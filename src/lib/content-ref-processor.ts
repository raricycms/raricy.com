// ─────────────────────────────────────────────────────────────────────────────
// content-ref-processor.ts — 博客 / 剪贴板正文的**整篇引用预处理**
//
// 职责：在 Markdown 源文上（marked 之前）扫出 `[@…]` 引用、按既有顺序与预算
// 替换成展开内容。取数一律走 ContentRefResolver（content-ref-resolver.ts），
// 本模块不自己发请求、不持有模式判断。
//
// 分流词汇（按 id 长度）：8 位 → 剪贴板正文内联 / 9 位 → 投票嵌入位 /
// 10 位 → 图床图片 / 6 位纯数字 → 收藏夹卡片。**只在这条管线上**：评论与讨论走
// rich-text.ts，那边刻意不认 6 位，与 9 位投票「只识别不展开」同向。
// 音频引用 `[@音频/<ID>]` 是**名字形**，`\w` 匹配不到中文，单独一趟放在最后。
//
// ⚠️ 数字 id 引用保留 `\[@\s*(\w+)\s*\]` 的宽松形态（含内部空白、含下划线）——
// 那是现有语法的兼容范围，不能顺手收紧（评论管线收紧到 [A-Za-z0-9] 是它自己的事，
// 见 content-refs.ts 文件头）。具名 token 则继续遵守白名单和不含空白的规则。
//
// 本模块零 DOM / 零 React，可直接单测（tests/unit/content-ref-processor.test.ts）；
// 组件级回归在 tests/unit/blog-ref-render.test.ts。
// ─────────────────────────────────────────────────────────────────────────────

import {
  CLIPBOARD_ID_LEN,
  IMAGE_ID_LEN,
  MAX_BLOG_REF_ITEMS,
  VOTE_ID_LEN,
} from '@/lib/content-refs';
import {
  collectFavoriteRefs,
  isFavoriteId,
  maskMarkdownCode,
  replaceFavoriteRefs,
} from '@/lib/favorite-refs';
import { collectAudioRefs, replaceAudioRefs } from '@/lib/audio-refs';
import type { ContentRefResolver } from '@/lib/content-ref-resolver';

export class ContentRefProcessor {
  constructor(private resolver: ContentRefResolver) {}

  /**
   * 整篇预处理：扫描 → 解析（经 resolver）→ 按区间切片替换。
   * 返回的仍是 Markdown 源文（展开内容已内联），交给 marked 继续走。
   */
  async preprocess(markdownContent: string): Promise<string> {
    // 分流扫的是**盖过码**的副本（`maskMarkdownCode`，与音频 / 收藏夹那两趟同口径）：
    // 代码块与行内代码里的引用一律不展开 —— 那是《内容引用语法指南》对读者的承诺
    // （「代码里的引用一律不展开」），也是「想展示语法本身」的唯一写法。
    // ⚠️ 不盖码的后果不是「渲染错了」，而是**静默改掉用户写下的代码**：
    // 围栏里的 `[@10位]` 会被改写成 `![id](…/raw)`，复制按钮复制走的也是改过的那份。
    // 盖码副本与原文**等长**，故同一下标两处通用（`match` 一律取自原文）。
    const maskedContent = maskMarkdownCode(markdownContent);
    const pattern = /\[@\s*(\w+)\s*\]/g;
    const refSlots: { id: string; match: string; start: number }[] = [];
    for (const m of maskedContent.matchAll(pattern)) {
      const start = m.index ?? 0;
      refSlots.push({
        id: m[1],
        match: markdownContent.slice(start, start + m[0].length),
        start,
      });
    }

    // ★ 音频那趟**必须早于**下面这条空集早退 ★
    // 音频引用是 `[@音频/<ID>]`，合集名是中文，而上面那条分流用的 `\w` 匹配不到中文
    // —— 于是「正文里只有音频引用」时 refSlots 是**空的**，早退会把播放器一起吞掉
    // （写一篇只贴了一段录音的文章 = 什么也不展开，且不报错）。
    // 此刻还没有任何替换发生过，下标成立，直接替换掉返回即可。
    // 有条目时下面照旧**重新扫一次**（那时字符串已被改写，这批下标不再成立）。
    if (refSlots.length === 0) {
      const audioSlots = collectAudioRefs(markdownContent, maskedContent);
      return audioSlots.length > 0
        ? replaceAudioRefs(markdownContent, audioSlots)
        : markdownContent;
    }

    const clipboardIds = new Set<string>();
    const voteIds = new Set<string>();
    const imageIds = new Set<string>();
    const favoriteIds = new Set<string>();
    for (const slot of refSlots) {
      const id = slot.id;
      if (id.length === CLIPBOARD_ID_LEN) clipboardIds.add(id);
      else if (id.length === VOTE_ID_LEN) voteIds.add(id);
      else if (id.length === IMAGE_ID_LEN) imageIds.add(id);
      // 6 位是收藏夹。用白名单判定（`^[0-9]{6}$`）而不是「长度 === 6」——
      // 6 位字母/下划线的 token 必须落回字面量，不要去请求一次不存在的资源。
      else if (isFavoriteId(id)) favoriteIds.add(id);
    }

    // 取数全部经 resolver：模式（expand / external）、并发去重、失败降级都封在里面。
    // 这里对**去重后的 id 集合**统一发 resolve —— 已缓存的同步返回，不会重复请求。
    const pending: Promise<unknown>[] = [];
    for (const id of clipboardIds) pending.push(this.resolver.resolve('clipboard', id));
    for (const id of voteIds) pending.push(this.resolver.resolve('vote', id));
    for (const id of imageIds) pending.push(this.resolver.resolve('image', id));
    for (const id of favoriteIds) pending.push(this.resolver.resolve('favorite', id));
    await Promise.all(pending);

    // 替换**按区间切片**（不是 `replace(token, …)`），单向往回走一遍。
    // 两条各自的理由：
    //   · 为什么切片：同一个 token 在正文里可能出现多次，而 `replace` 命中的是
    //     **第一处**。盖过码之后这一点会真出事 —— 只写了一处引用的正文里，若同一个
    //     token 还在前面的代码块里出现过（那处已经被盖掉、不在 refSlots 里），
    //     `replace` 会去改**代码块里那一处**，正文里那处反而留在原地。
    //   · 为什么不 break 而是 continue：没有内容的（超出上限、取不到）保持字面量，
    //     不该吃掉后面那些**取得到**的引用的名额 —— 与收藏夹那趟的 `used` 计数同义。
    let processed = '';
    let cursor = 0;
    let count = 0;
    for (const slot of refSlots) {
      if (count >= MAX_BLOG_REF_ITEMS) continue;
      const id = slot.id;
      let replacement: string | undefined;
      if (id.length === CLIPBOARD_ID_LEN) {
        const hit = this.resolver.peek('clipboard', id);
        if (hit) replacement = hit.content ?? '';
      } else if (id.length === VOTE_ID_LEN) {
        const hit = this.resolver.peek('vote', id);
        if (hit) {
          replacement = hit.error
            ? `<a href="/vote/${hit.id}">[投票 ${hit.id} 加载失败，点击查看]</a>`
            : `<div class="vote-embed" data-vote-id="${id}"></div>`;
        }
      } else if (id.length === IMAGE_ID_LEN) {
        const hit = this.resolver.peek('image', id);
        if (hit) replacement = `![${id}](${hit.url})`;
      }
      // 收藏夹在主循环里**刻意跳过**：它最后单独走一趟，理由见下方那段的注释。
      if (replacement === undefined) continue;
      processed += markdownContent.slice(cursor, slot.start) + replacement;
      cursor = slot.start + slot.match.length;
      count++;
    }
    processed += markdownContent.slice(cursor);

    // ── 收藏夹卡片：**最后单独一趟**，且**按区间切片**而不是 replace ─────────────
    //
    // 两个「为什么」：
    //   · 为什么放在最后：卡片 HTML 里含博客标题（不可信输入），标题里若正好有
    //     `[@8位]` 字样，**先**插卡片就意味着后面每一趟都得躲开它。放在最后做，
    //     此后不再有任何扫描，插进去的卡片就不可能被二次解释。
    //   · 为什么重新扫一遍而不是复用上面的 refSlots：上面的循环已经改写过
    //     `processed`，那批下标对应的是**原始**字符串，长度变了就不成立了。
    //     这里对着当前字符串重新取一次位置，切片才是准的。
    const slots = collectFavoriteRefs(processed);
    if (slots.length > 0) {
      const htmlById = new Map<string, string>();
      for (const slot of slots) {
        const hit = this.resolver.peek('favorite', slot.id);
        if (hit?.content !== undefined) {
          htmlById.set(slot.id, hit.content);
        }
      }
      processed = replaceFavoriteRefs(processed, slots, htmlById);
    }

    // ── 音频（`[@音频/<ID>]`）：**最后再一趟**，同样按区间切片 ──────────────────
    //
    // 三条与上面收藏夹那趟同源的理由，外加一条自己的：
    //   · 为什么在最后：它前面那趟会插进**收藏夹卡片 HTML**，而卡片里含博客标题
    //     （不可信输入）。音频排在它之后、且此后不再有任何扫描，插进去的东西就
    //     不可能被二次解释。
    //   · 为什么重新扫：`processed` 已被改写，早先那批下标不再成立。
    //   · 为什么按区间切片：见 replaceAudioRefs 的说明。
    //   · **为什么自己调 maskMarkdownCode**：收藏夹那趟是在 collectFavoriteRefs
    //     内部盖的码；音频这个模块必须保持**零 import**（chat-shared 要把它拉进
    //     客户端包，见 audio-refs.ts 文件头），所以盖码这一步留在调用方做。
    //     漏了它 = 在代码块里写语法本身会嵌出一个**真播放器**
    //     （audio 在博客白名单里是放行的，DOMPurify 不会拦）。
    const audioSlots = collectAudioRefs(processed, maskMarkdownCode(processed));
    if (audioSlots.length > 0) {
      processed = replaceAudioRefs(processed, audioSlots);
    }

    return processed;
  }
}
