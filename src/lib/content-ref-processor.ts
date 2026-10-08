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
  MAX_REF_EXPAND_CHARS,
  MAX_REF_FETCHES,
  VOTE_ID_LEN,
} from '@/lib/content-refs';
import {
  MAX_FAVORITE_REFS,
  collectFavoriteRefs,
  isFavoriteId,
  maskMarkdownCode,
  replaceFavoriteRefs,
} from '@/lib/favorite-refs';
import { collectAudioRefs, replaceAudioRefs } from '@/lib/audio-refs';
import type {
  ContentRefResolver,
  ContentRefType,
  ResolvedRef,
} from '@/lib/content-ref-resolver';

/** 一轮预处理取到的结果，键是 `${type}:${id}`（见 preprocessRound）。 */
export type RefRoundEntries = ReadonlyMap<string, ResolvedRef | undefined>;

export interface RefRoundResult {
  /** 展开后的 Markdown 源文 —— 与 `preprocess` 的返回值逐字相同。 */
  text: string;
  /** 本轮**这一趟真的取到的**那些（`undefined` = 这一类取不到，保留字面量）。 */
  entries: RefRoundEntries;
}

export class ContentRefProcessor {
  constructor(private resolver: ContentRefResolver) {}

  /**
   * 整篇预处理：扫描 → 解析（经 resolver）→ 按区间切片替换。
   * 返回的仍是 Markdown 源文（展开内容已内联），交给 marked 继续走。
   */
  async preprocess(markdownContent: string): Promise<string> {
    return (await this.preprocessRound(markdownContent)).text;
  }

  /**
   * 与 `preprocess` 同一条管线，另外把**本轮**取到的结果一起交出来。
   *
   * ★ 为什么必须由本轮自己交出来，而不是让调用方回头去问 resolver ★
   * resolver 的缓存是**全局的、可被任何人作废的**：同一时刻另一处（「刷新引用」、
   * 另一次预览渲染）调一次 `invalidate()`，缓存就被清空/换成了新的一代。
   * 而处理器是「先 `await` 所有 resolve，再回头读缓存」两段式的 —— 中间这一小段
   * 里被作废的话，第二段读到的就是**空的**：正文里那些引用会**静默退成字面量**
   * `[@8位]`（成功取到的内容被丢掉），而且越慢的接口越容易撞上，页面上没有任何提示。
   * 所以第一段 `await` 的**返回值**才是这一轮的真值，替换只认它。
   *
   * 【调用方拿到 entries 干什么】预览 / 导出里那些**同一批引用派生出来的**东西
   * （首当其冲是投票小组件的数据）必须来自这同一份快照，否则就会出现「正文用本轮
   * 取到的，小组件用后来那一代、或者干脆自己再拉一条」—— 同一屏上两个不一致的来源。
   */
  async preprocessRound(markdownContent: string): Promise<RefRoundResult> {
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
    // ⚠️ **展开预算同样管这条早退**：只贴录音、而正文本身已超预算时，播放器也不能加。
    if (refSlots.length === 0) {
      const audioSlots = collectAudioRefs(markdownContent, maskedContent);
      return {
        text:
          audioSlots.length > 0
            ? replaceAudioRefs(markdownContent, audioSlots, MAX_REF_EXPAND_CHARS)
            : markdownContent,
        entries: new Map(),
      };
    }

    // 分流 + 挑取数候选。
    //   · 图床（10 位）只拼 URL、不取数 —— 不进候选，也不占 MAX_REF_FETCHES（否则
    //     图多的文章会把剪贴板 / 投票的取数名额饿死）。
    //   · 剪贴板 / 投票 / 收藏夹**要取数** —— 按**原文出现顺序**取前 MAX_REF_FETCHES
    //     个不同的 `${type}:${id}`（去重；缓存命中也算，见常量的说明）。
    //     ⚠️ 不能先按类型分组、各自截断：那样正文后面的一条剪贴板会抢掉前面投票的
    //     名额，于是「按顺序数」与「按类型数」给出两篇不同的展开结果，且不报错。
    //   · 超出预算的引用**既不取数也不替换**，原样留在正文里。
    const imageIds = new Set<string>();
    const wanted: Array<[ContentRefType, string]> = [];
    const fetchedKeys = new Set<string>();
    for (const slot of refSlots) {
      const id = slot.id;
      if (id.length === IMAGE_ID_LEN) {
        imageIds.add(id);
        continue;
      }
      const type: ContentRefType | null =
        id.length === CLIPBOARD_ID_LEN
          ? 'clipboard'
          : id.length === VOTE_ID_LEN
            ? 'vote'
            : // 6 位是收藏夹。用白名单判定（`^[0-9]{6}$`）而不是「长度 === 6」——
              // 6 位字母/下划线的 token 必须落回字面量，不去请求一次不存在的资源。
              isFavoriteId(id)
              ? 'favorite'
              : null;
      if (!type) continue;
      if (wanted.length >= MAX_REF_FETCHES) continue;
      const key = `${type}:${id}`;
      if (fetchedKeys.has(key)) continue;
      fetchedKeys.add(key);
      wanted.push([type, id]);
    }
    // 图床追加在后面：它不发请求（不占并发闸门），顺序只影响 entries 的写入。
    for (const id of imageIds) wanted.push(['image', id]);

    // 取数全部经 resolver：模式（expand / external）、并发去重（上限 MAX_REF_CONCURRENCY）、
    // 失败降级都封在里面。这里对**去重后的候选**统一发 resolve —— 已缓存的同步返回，
    // 不会重复请求。
    const fetched = await Promise.all(wanted.map(([type, id]) => this.resolver.resolve(type, id)));
    // ★ 这一轮的真值就落在这里 ★ 替换阶段只认它，**再也不回头问 resolver**
    //（理由见 preprocessRound 的说明：缓存可能已经被人作废成另一代）。
    const entries = new Map<string, ResolvedRef | undefined>();
    wanted.forEach(([type, id], index) => entries.set(`${type}:${id}`, fetched[index]));

    // 替换**按区间切片**（不是 `replace(token, …)`），单向往回走一遍。
    // 三条各自的理由：
    //   · 为什么切片：同一个 token 在正文里可能出现多次，而 `replace` 命中的是
    //     **第一处**。盖过码之后这一点会真出事 —— 只写了一处引用的正文里，若同一个
    //     token 还在前面的代码块里出现过（那处已经被盖掉、不在 refSlots 里），
    //     `replace` 会去改**代码块里那一处**，正文里那处反而留在原地。
    //   · 为什么不 break 而是 continue：没有内容的（超出上限、取不到、装不下）保持
    //     字面量，不该吃掉后面那些**取得到**的引用的名额 —— 与收藏夹那趟的 `used` 同义。
    //   · 展开预算（MAX_REF_EXPAND_CHARS）：`used` 从**原文长度**起算（保留的原文字数
    //     也算进去），每接受一条加它的净增。装不下就保留 token，**绝不截断内容**。
    //     原文本身已超预算时 `sourceFits` 为假 —— 保留原文、不再增长。
    const sourceFits = markdownContent.length <= MAX_REF_EXPAND_CHARS;
    let processed = '';
    let cursor = 0;
    let count = 0;
    let used = markdownContent.length;
    for (const slot of refSlots) {
      if (count >= MAX_BLOG_REF_ITEMS) continue;
      if (!sourceFits) continue;
      const id = slot.id;
      let replacement: string | undefined;
      if (id.length === CLIPBOARD_ID_LEN) {
        const hit = entries.get(`clipboard:${id}`);
        if (hit) replacement = hit.content ?? '';
      } else if (id.length === VOTE_ID_LEN) {
        const hit = entries.get(`vote:${id}`);
        if (hit) {
          replacement = hit.error
            ? `<a href="/vote/${hit.id}">[投票 ${hit.id} 加载失败，点击查看]</a>`
            : `<div class="vote-embed" data-vote-id="${id}"></div>`;
        }
      } else if (id.length === IMAGE_ID_LEN) {
        const hit = entries.get(`image:${id}`);
        if (hit) replacement = `![${id}](${hit.url})`;
      }
      // 收藏夹在主循环里**刻意跳过**：它最后单独走一趟，理由见下方那段的注释。
      if (replacement === undefined) continue;
      const delta = replacement.length - slot.match.length;
      if (used + delta > MAX_REF_EXPAND_CHARS) continue; // 装不下这条，保留 token
      used += delta;
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
        // 与上面那趟同一个来源：本轮 entries，不回头问 resolver
        const hit = entries.get(`favorite:${slot.id}`);
        if (hit?.content !== undefined) {
          htmlById.set(slot.id, hit.content);
        }
      }
      // 展开预算跨趟共享：卡片 HTML 比 token 长得多，装不下就保留 token（不截断卡片）。
      processed = replaceFavoriteRefs(
        processed,
        slots,
        htmlById,
        MAX_FAVORITE_REFS,
        MAX_REF_EXPAND_CHARS
      );
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
      // 同一条总预算：播放器标签串也占字数，装不下就保留 token。
      processed = replaceAudioRefs(processed, audioSlots, MAX_REF_EXPAND_CHARS);
    }

    return { text: processed, entries };
  }
}
