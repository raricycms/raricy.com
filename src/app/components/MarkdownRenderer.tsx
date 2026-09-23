'use client';

// 博客正文客户端渲染：marked + DOMPurify + highlight.js。
// 额外处理：
//   • 内容引用预处理（[@id]）：8位→剪贴板正文内联 / 9位→投票嵌入 / 10位→图床图片 /
//     6位→收藏夹卡片（**只在这条管线上**：评论与讨论走 rich-text.ts，那边刻意不认 6 位，
//     与 9 位投票「只识别不展开」同向）。
//   • 音频引用 `[@音频/<ID>]`：**名字形**，不参与上面那条按长度分流（`\w` 匹配不到
//     中文），单独一趟放在最后，见 ContentRefProcessor.preprocess。
//
// 【两种模式，不是「展开 / 不展开」】`contentRefs='expand'` 是站内成员视图，
// `'external'` 是对外视图。对外视图**也展开**，只是展开的范围小一圈：
// 图床图片 / 音频 / **服务端随 payload 下发的公开剪贴板**（externalClips）出得来，
// 投票与收藏夹保留字面量。判据是「这条引用的读口是不是匿名本来就取得到」——
// 见 prop 上的说明与 docs/architecture.md §7.3。
//   • MathJax：行内 $..$ / \(..\)、块级 $$..$$ / \[..\]、mhchem（mathjax-full 模块化 API）。
//   • 代码高亮亮/暗双主题随 data-theme 切换（github / monokai，media 切换）。
//   • 代码块「复制」按钮、图片点击放大、外链 target=_blank 加固、任务列表 checkbox。
import { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { CHTML } from 'mathjax-full/js/output/chtml.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { BLOG_SANITIZE_OPTIONS, renderVoteEmbed } from '@/lib/blog-markdown';
import { protectMath, restoreMath } from '@/lib/markdown-math';
import {
  MAX_CARD_ITEMS,
  buildFavoriteCardHtml,
  collectFavoriteRefs,
  favoriteFailureText,
  isFavoriteId,
  maskMarkdownCode,
  replaceFavoriteRefs,
} from '@/lib/favorite-refs';
import { collectAudioRefs, replaceAudioRefs } from '@/lib/audio-refs';
import { MAX_BLOG_REF_ITEMS } from '@/lib/content-refs';

/** `contentRefs` 的两个取值，见下面 prop 的说明。 */
type RefMode = 'expand' | 'external';

// ── 内容引用预处理器（端点走 Next API）────────────────────────────────────────
class ContentRefProcessor {
  private cache = new Map<string, { type: string; content?: string; error?: boolean; id?: string; url?: string }>();
  private MAX_ITEMS = MAX_BLOG_REF_ITEMS;

  /**
   * @param mode        'expand' 会去请求三条 core+ 接口；'external' 一个请求都不发。
   * @param externalClips 'external' 下**服务端预先解析好**的公开剪贴板（id → 正文）。
   *   私有 / 已软删的不在表里，于是它们在正文里原样保留字面量（fail-closed）。
   */
  constructor(
    private mode: RefMode = 'expand',
    private externalClips: Record<string, string> = {}
  ) {}

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
      if (id.length === 8) clipboardIds.add(id);
      else if (id.length === 9) voteIds.add(id);
      else if (id.length === 10) imageIds.add(id);
      // 6 位是收藏夹。用白名单判定（`^[0-9]{6}$`）而不是「长度 === 6」——
      // 6 位字母/下划线的 token 必须落回字面量，不要去请求一次不存在的资源。
      else if (isFavoriteId(id)) favoriteIds.add(id);
    }

    // ── 对外视图：一切数据都已随 payload 下发，**一个请求都不发** ────────────────
    //
    // 三条 core+ 接口在匿名页面上只会换来 401，所以 'external' 下干脆不构建这些
    // 请求。三类的处置各不相同，别「统一」：
    //   · 剪贴板 —— 服务端已经替我们判过公开档（clipboard-service.resolvePublicClipRefs），
    //     **在表里的**直接当内容用；不在表里的保持字面量（私有 / 已软删 / 不存在同形）。
    //   · 投票 —— 一律不展开，保留字面量。这是站长定的口径：投票箱不进对外视图。
    //   · 收藏夹 —— 一律不展开，保留字面量（读口同样是 core+）。
    let clipboardFetches: Promise<void>[] = [];
    if (this.mode === 'expand') {
      clipboardFetches = [...clipboardIds]
        .filter((id) => !this.cache.has(id))
        .map(async (id) => {
          try {
            const res = await fetch(`/api/clipboard/${id}`, { credentials: 'same-origin' });
            if (!res.ok) throw new Error('failed');
            const data = await res.json();
            this.cache.set(id, { type: 'clipboard', content: data.clip?.content ?? data.content ?? '' });
          } catch {
            this.cache.set(id, { type: 'clipboard', content: `[剪贴板 ${id} 加载失败]` });
          }
        });
    } else {
      for (const id of clipboardIds) {
        const content = this.externalClips[id];
        if (content !== undefined && !this.cache.has(id)) {
          this.cache.set(id, { type: 'clipboard', content });
        }
      }
    }

    let voteFetches: Promise<void>[] = [];
    if (this.mode === 'expand') {
      voteFetches = [...voteIds]
        .filter((id) => !this.cache.has(id))
        .map(async (id) => {
          try {
            const res = await fetch(`/api/votes/${id}`, { credentials: 'same-origin' });
            if (!res.ok) throw new Error('failed');
            await res.json();
            this.cache.set(id, { type: 'vote' });
          } catch {
            this.cache.set(id, { type: 'vote', error: true, id });
          }
        });
    }

    for (const id of imageIds) {
      if (!this.cache.has(id)) this.cache.set(id, { type: 'image', url: `/api/images/${id}/raw` });
    }

    // 收藏夹：拉 spider 那条公开读路径（**需 core+**）。'expand' 的两个调用点
    // （博客详情的成员视图、剪贴板详情）都在 requireCoreUser() 之后，而这次 fetch 带
    // same-origin 凭据，所以会话一定在。'external' 下不请求（会 401），保字面量。
    // 拿到就直接拼成卡片 HTML 存进 cache。取不到（不存在 / 私密 / 已软删 / 网络错误）
    // 一律降级成失败文案，静默不抛 —— 调用方是 `void`。
    const favoriteFetches =
      this.mode === 'expand'
        ? [...favoriteIds]
            .filter((id) => !this.cache.has(id))
            .map(async (id) => {
              try {
                const res = await fetch(`/api/spider/favorites/${id}`, { credentials: 'same-origin' });
                if (!res.ok) throw new Error('failed');
                const data = await res.json();
                this.cache.set(id, {
                  type: 'favorite',
                  content: buildFavoriteCardHtml({
                    id,
                    title: typeof data.title === 'string' ? data.title : '',
                    count: typeof data.count === 'number' ? data.count : 0,
                    author: typeof data.author === 'string' ? data.author : undefined,
                    blogs: Array.isArray(data.blogs)
                      ? data.blogs
                          .filter((b: unknown): b is { id: string; title: string } => {
                            const o = b as { id?: unknown; title?: unknown };
                            return typeof o?.id === 'string' && typeof o?.title === 'string';
                          })
                          .slice(0, MAX_CARD_ITEMS)
                      : [],
                  }),
                });
              } catch {
                this.cache.set(id, { type: 'favorite', content: favoriteFailureText(id) });
              }
            })
        : [];

    await Promise.all([...clipboardFetches, ...voteFetches, ...favoriteFetches]);

    // 替换**按区间切片**（不是 `replace(token, …)`），单向往回走一遍。
    // 两条各自的理由：
    //   · 为什么切片：同一个 token 在正文里可能出现多次，而 `replace` 命中的是
    //     **第一处**。盖过码之后这一点会真出事 —— 只写了一处引用的正文里，若同一个
    //      token 还在前面的代码块里出现过（那处已经被盖掉、不在 refSlots 里），
    //     `replace` 会去改**代码块里那一处**，正文里那处反而留在原地。
    //   · 为什么不 break 而是 continue：没有内容的（超出上限、取不到）保持字面量，
    //     不该吃掉后面那些**取得到**的引用的名额 —— 与收藏夹那趟的 `used` 计数同义。
    let processed = '';
    let cursor = 0;
    let count = 0;
    for (const slot of refSlots) {
      const cached = this.cache.get(slot.id);
      if (!cached || count >= this.MAX_ITEMS) continue;
      let replacement: string;
      if (cached.type === 'clipboard') replacement = cached.content ?? '';
      else if (cached.type === 'vote') {
        replacement = cached.error
          ? `<a href="/vote/${cached.id}">[投票 ${cached.id} 加载失败，点击查看]</a>`
          : `<div class="vote-embed" data-vote-id="${slot.id}"></div>`;
      } else if (cached.type === 'image') replacement = `![${slot.id}](${cached.url})`;
      else continue;
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
        const hit = this.cache.get(slot.id);
        if (hit?.type === 'favorite' && hit.content !== undefined) {
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

// ── hljs 双主题 CSS（亮=github，暗=monokai）───────────────────────────────────
// 说明：highlight.js 的两套主题 CSS 都作用于全局 .hljs，若同时生效会互相覆盖。
// 因此内联为两个 <style>，仅让匹配当前 data-theme 的一份生效（另一份 media='not all'
// 彻底禁用），并用 MutationObserver 监听 documentElement[data-theme] 切换。
// 内联而非静态 import / 外链，保证组件自包含、暗色代码块必定走暗色高亮。
const HLJS_GITHUB_CSS =
  'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}' +
  '.hljs{color:#24292e;background:#fff}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}.hljs-built_in,.hljs-symbol{color:#e36209}.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}.hljs-subst{color:#24292e}.hljs-section{color:#005cc5;font-weight:700}.hljs-bullet{color:#735c0f}.hljs-emphasis{color:#24292e;font-style:italic}.hljs-strong{color:#24292e;font-weight:700}.hljs-addition{color:#22863a;background-color:#f0fff4}.hljs-deletion{color:#b31d28;background-color:#ffeef0}';
const HLJS_MONOKAI_CSS =
  'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}' +
  '.hljs{background:#272822;color:#ddd}.hljs-keyword,.hljs-literal,.hljs-name,.hljs-number,.hljs-selector-tag,.hljs-strong,.hljs-tag{color:#f92672}.hljs-code{color:#66d9ef}.hljs-attr,.hljs-attribute,.hljs-link,.hljs-regexp,.hljs-symbol{color:#bf79db}.hljs-addition,.hljs-built_in,.hljs-bullet,.hljs-emphasis,.hljs-section,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-string,.hljs-subst,.hljs-template-tag,.hljs-template-variable,.hljs-title,.hljs-type,.hljs-variable{color:#a6e22e}.hljs-class .hljs-title,.hljs-title.class_{color:#fff}.hljs-comment,.hljs-deletion,.hljs-meta,.hljs-quote{color:#75715e}.hljs-doctag,.hljs-keyword,.hljs-literal,.hljs-section,.hljs-selector-id,.hljs-selector-tag,.hljs-title,.hljs-type{font-weight:700}';

function useHljsThemeStyles() {
  useEffect(() => {
    const ensure = (id: string, css: string) => {
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        el.textContent = css;
        document.head.appendChild(el);
      }
      return el;
    };
    const light = ensure('hljs-theme-light', HLJS_GITHUB_CSS);
    const dark = ensure('hljs-theme-dark', HLJS_MONOKAI_CSS);
    const sync = () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      // media='not all' → 该 <style> 不生效；只保留匹配当前主题的一份。
      light.media = isDark ? 'not all' : 'all';
      dark.media = isDark ? 'all' : 'not all';
    };
    sync();
    const obs = new MutationObserver((muts) => {
      muts.forEach((m) => m.attributeName === 'data-theme' && sync());
    });
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, []);
}

// ── MathJax：模块化 mathjax-full（CHTML 输出），page-lifetime 单例─────────────
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js';

interface TypesetContext {
  ready: boolean;
  tex?: TeX<any, any, any>;
  chtml?: CHTML<any, any, any>;
}

// 跨 MarkdownRenderer 实例复用 mathjax 句柄链。第一次见到数学公式时懒初始化。
const typesetCtx: TypesetContext = { ready: false };

function ensureMathJax(): TypesetContext {
  if (typesetCtx.ready) return typesetCtx;
  // RegisterHTMLHandler 内部已把 HTMLHandler 注册到 mathjax.handlers；
  // TeX / CHTML 不属 Handler，要走 mathjax.document({ InputJax, OutputJax })。
  RegisterHTMLHandler(browserAdaptor());
  typesetCtx.tex = new TeX({
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    processEscapes: true,
    processEnvironments: true,
    packages: AllPackages,
    macros: {
      RR: '\\mathbb{R}', NN: '\\mathbb{N}', ZZ: '\\mathbb{Z}', QQ: '\\mathbb{Q}',
      CC: '\\mathbb{C}', PP: '\\mathbb{P}', EE: '\\mathbb{E}', FF: '\\mathbb{F}',
    },
  });
  // ⚠️ 只传 mathjax-full 3.x 认得的选项。enableMenu/fontCache 是 v4 才有的
  // 配置，写在 3.2.2 上只会得到两条 Invalid option 警告且配置不生效。
  //
  // fontURL 必须显式给绝对路径：默认值 `js/output/chtml/fonts/tex-woff-v2` 是
  // 相对路径，会按**当前页面**解析（/clipboard/xxx 下就变成 /clipboard/js/…），
  // 一律 404 —— 公式只能用回退字体渲染，字形与间距都不对。字体文件由
  // scripts/copy-mathjax-fonts.mjs 从 mathjax-full 拷到 public/static/mathjax/。
  typesetCtx.chtml = new CHTML({ fontURL: '/static/mathjax/woff-v2' });
  typesetCtx.ready = true;
  return typesetCtx;
}

function typesetMath(root: HTMLElement): void {
  const ctx = ensureMathJax();
  if (!ctx.tex || !ctx.chtml) return;
  try {
    // ⚠️ 绝不能把页面上的容器传给 mathjax.document(元素) —— 它会把传入元素
    // **搬进一个新建的空文档**（脱离页面），正文会整体从原位置消失（详情页
    // 正文渲染为空的根因）。正确用法：在全局 document 上建实例，用
    // findMath({ elements: [root] }) 把扫描限定在本容器内，updateDocument 把
    // mjx-container 就地写回，其余 DOM 与已绑定的事件一概不动。
    const mathDocument = mathjax.document(document, {
      InputJax: ctx.tex,
      OutputJax: ctx.chtml,
    });
    mathDocument.findMath({ elements: [root] }).compile().getMetrics().typeset().updateDocument();
  } catch {
    // 公式语法错误时静默保留原文，不影响页面其他内容
  }
}

export default function MarkdownRenderer({
  content,
  contentRefs,
  externalClips,
}: {
  content: string;
  /**
   * 内容引用（`[@…]`）的处理方式。**由服务端决定，不是客户端开关。**
   *
   *   · 'expand'   —— 站内成员视图：带 same-origin 凭据去请求三条 core+ 接口
   *     （剪贴板正文 / 投票嵌入 / 收藏夹卡片）+ 拼图床 URL + 音频播放器。
   *     **只有 core+ 的页面能传这个。**
   *   · 'external' —— 对外视图：只展开**匿名读口本来就取得到**的那几类 ——
   *     图床图片、音频播放器，以及随 payload 下发的公开剪贴板（见 `externalClips`）。
   *     投票与收藏夹**保留字面量**（两者的读口都是 core+，而且那是站长定的口径：
   *     投票箱不进对外视图）。本模式**一个请求都不发**。
   *
   * **必传，没有默认值** —— 一个默认展开的组件一旦被用在匿名页面上，就是三条 401
   * 外加把站内内容渲染给站外读者看。文章详情页按 `isCore` 传（`blog/[id]/page.tsx`）。
   *
   * 【判据是「读口」，不是「是不是站内内容」】图片 / 音频的字节由 `/api/images|audio
   * /<id>/raw` 供，那两条路由**匿名可达、逐条判该不该给你**（私有档对无权者 404）；
   * 剪贴板 / 投票 / 收藏夹的三条接口一律要 core+ 会话，匿名去问只有 401。
   * 所以对外视图展开前一类、不展开后一类。⚠️ **别把这条边界往回缩成「一律不展开」**
   * ——「作者把文章设为对外可见，读到的人却看不到正文里的图和录音」正是这一版要修的。
   *
   * 【展不开时为什么是「原样保留字面量」而不是「换成一句提示」】评论区那条管线
   * （`src/lib/useResolvedContent.ts`）已经立过这个口径：「取不到时的样子（未登录 /
   * 非 core 读者）与加载中一致」，就显示 `[@abc12345]`。跟着它走，站内不会出现
   * 第三种「引用不可用」的观感；也不往不可信字符串里插入任何新文本，没有新的转义面。
   */
  contentRefs: 'expand' | 'external';
  /**
   * **服务端预先解析好**的公开剪贴板（id → 正文），只给 'external' 用。
   *
   * 为什么由服务端给而不是客户端去拉：`GET /api/clipboard/:id` 要 core+ 会话，
   * 匿名读者拿不到 —— 而剪贴板的 `publicity=false` 是比 core+ **更窄**的一档，
   * 不能因为「被引用进了一篇公开文章」而放宽。所以判档在服务端做，判完只把能给的
   * 那几条随 payload 发下来（`clipboard-service.ts` 的 `resolvePublicClipRefs`）。
   * 不带会话的页面**必须**传它，否则正文里的剪贴板引用一律是字面量。
   */
  externalClips?: Record<string, string>;
}) {
  /** 渲染结果 + 抽出的公式数量（决定要不要跑 MathJax，见 markdown-math.ts）。 */
  const [doc, setDoc] = useState<{ html: string; mathCount: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useHljsThemeStyles();

  // 渲染 markdown → 安全 HTML（含内容引用预处理 + 数学公式占位保护）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 两种模式都要过预处理器 —— 差别在处理器**展开到哪一档**，不在「过不过它」。
      // 别在这里写 `contentRefs === 'expand' && …`：那样对外视图连音频都不会展开。
      let text = await new ContentRefProcessor(contentRefs, externalClips).preprocess(content ?? '');

      // 保护数学公式，避免被 Markdown 破坏（还原时的两个坑见 markdown-math.ts）
      const math = protectMath(text);
      text = math.text;

      // marked 实例（gfm 任务列表原生支持）+ 自定义代码块渲染（高亮 + 复制按钮）。
      // 外链 target=_blank / rel 加固在渲染后的 DOM 后处理里统一完成。
      const m = new Marked({ gfm: true, breaks: true });
      m.use({
        renderer: {
          code({ text: code, lang }: { text: string; lang?: string }) {
            let highlighted: string;
            try {
              highlighted =
                lang && hljs.getLanguage(lang)
                  ? hljs.highlight(code, { language: lang }).value
                  : hljs.highlightAuto(code).value;
            } catch {
              highlighted = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
            return `<div class="highlight"><pre><code class="hljs">${highlighted}</code></pre><button class="copy-btn" data-code="${encodeURIComponent(code)}">复制</button></div>`;
          },
        },
      });

      let out = m.parse(text, { async: false }) as string;
      out = restoreMath(out, math.placeholders);

      // 白名单是安全边界，集中定义在 src/lib/blog-markdown.ts（改动请同步其单测）。
      const clean = DOMPurify.sanitize(out, BLOG_SANITIZE_OPTIONS);
      if (!cancelled) setDoc({ html: clean, mathCount: math.count });
    })();
    return () => { cancelled = true; };
  }, [content, contentRefs, externalClips]);

  // 渲染后处理：代码高亮、复制按钮、图片放大、外链加固、投票嵌入、MathJax
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !doc) return;

    // 复制按钮
    root.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach((btn) => {
      btn.onclick = () => {
        const codeText = decodeURIComponent(btn.getAttribute('data-code') || '');
        const done = () => {
          const orig = btn.textContent;
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(codeText).then(done).catch(done);
        else done();
      };
    });

    // 外链加固
    root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      try {
        const url = new URL(href, window.location.origin);
        const proto = url.protocol.toLowerCase();
        const isHttp = proto === 'http:' || proto === 'https:';
        if (!(isHttp || proto === 'mailto:' || proto === 'tel:')) { a.removeAttribute('href'); return; }
        if (isHttp && url.origin !== window.location.origin) {
          a.setAttribute('rel', 'noopener noreferrer nofollow');
          a.setAttribute('target', '_blank');
        }
      } catch { a.removeAttribute('href'); }
    });

    // 图片点击放大
    root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      img.style.cursor = 'pointer';
      img.onclick = () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;background:rgba(0,0,0,.8);display:flex;justify-content:center;align-items:center;z-index:9999;cursor:pointer;';
        const z = img.cloneNode() as HTMLImageElement;
        z.style.cssText = 'max-width:90%;max-height:90%;object-fit:contain;border-radius:8px;';
        overlay.appendChild(z);
        overlay.onclick = () => document.body.removeChild(overlay);
        document.body.appendChild(overlay);
      };
    });

    // 投票嵌入：拉数据 → 渲染完整小组件（标题 / 可投票 / 结果视图 / 详情页入口）。
    // 构造与交互都在 src/lib/blog-markdown.ts —— 那里是安全边界（id 校验 + 只用 DOM API
    // 写入），并有 jsdom 单测钉住结构。data-vote-id 来自用户 Markdown，校验也在那边做。
    root.querySelectorAll<HTMLElement>('.vote-embed[data-vote-id]').forEach((el) => {
      if (el.dataset.rendered) return;
      el.dataset.rendered = '1';
      void renderVoteEmbed(el, el.getAttribute('data-vote-id'));
    });

    // MathJax 数学公式。判据是抽取阶段的公式计数，而不是在渲染后的 HTML 上
    // 正则嗅探 —— 跨行块级公式（cases/aligned）用 `\$[^$\n]+\$` 嗅不出来，
    // 一漏就是整页公式全不排版（历史 bug，见 markdown-math.ts）。
    if (doc.mathCount > 0) {
      typesetMath(root);
    }
  }, [doc]);

  return (
    <div className="blog-content-container-container">
      {doc ? (
        <div
          ref={containerRef}
          className="blog-content-container"
          id="userContentContainer"
          // 已经 DOMPurify 净化
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
      ) : (
        <div
          className="blog-content-container"
          id="userContentContainer"
          ref={containerRef}
        >
          <div id="loading-indicator" className="text-center my-4">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">加载中...</span>
            </div>
            <p className="mt-2">正在加载内容...</p>
          </div>
        </div>
      )}
    </div>
  );
}
