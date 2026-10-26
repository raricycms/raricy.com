// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/export.ts —— HTML 导出与浏览器打印（PDF）
//
// 【导出的是什么】导出件里装的是**文本与已经展开好的内容**：正文 Markdown 渲染出的
// HTML、代码高亮、以及引用展开后的东西（图床 `<img>`、音频 `<audio>`、投票小组件、
// 收藏夹卡片、剪贴板内联正文）。这些东西在**生成那一刻**就写死在文件里了 ——
// 离线打开也一个字不少。
//
// 【导出的一步：正文从哪来】不在这里。调用方（MarkdownEditor）拿**此刻编辑器里的
// 原文**跑一遍与预览**同一套**管线，把结果挂到离屏容器上跑完 DOM 后处理，再把
// innerHTML 交给本模块。历史教训：这里原先直接读预览面板那棵 DOM，而预览是防抖
// 400ms + 一条异步取数的 —— 敲完最后一个字立刻点导出，出来的正是**敲之前**那一版，
// 页面上没有任何提示。所以本模块只负责「拼文件 + 打印」，不负责取正文。
//
// 【样式怎么带过去】把当前文档 head 里的样式表**原样抄一份绝对地址**进去：
//   · `<link rel=stylesheet>` → 用 `.href`（浏览器已经解析成绝对地址）；
//   · `<style>`（Next 注入的、hljs 双主题、MathJax 的 CHTML 字体表）→ outerHTML，
//     并且把里面**站内相对**的 `url(/…)` 补成绝对地址（见 absolutizeCssUrls）。
// 比在客户端重新内联一遍 CSS 可靠：那份 CSS 里带 hashed 文件名与 `@font-face`
// 相对路径，自己拼必然漏。代价是导出的文件**需要联网**才能取到样式 ——
// 这是**刻意的**取舍（内联一份完整 CSS 要自己维护字体与图片的相对路径），
// 不是没做完：**离线打开时是「有内容、没版式」**，正文一个字都不少。
//
// 【正文里的地址为什么也要补】`/api/images/<id>/raw` 这类站内相对地址在文件里
// 是相对于**文件自己的位置**解析的，双击打开就变成 `file:///api/images/…` ——
// 图片全裂、链接全废。所以正文与样式里的站内相对地址一律补成站点绝对地址
// （absolutizeSiteUrls）。**但绝不加 `<base>`**：那会把 `#锚点` 也一起带回原站，
// 而锚点恰恰是导出件内部该在自己身上跳的那一类。同理，**媒体与链接仍然需要
// 联网**（而且私有图 / 私有音频在站外本来就取不到）—— 这一点如实写进导出说明。
//
// 【公式】MathJax 已经渲染成 CHTML（内联样式 + head 里的字体表），所以把 `<style>`
// 抄过去就够了，导出件里**不需要**再加载 MathJax。
//
// 【ReactiveMD】`renderStaticMarkup` 用离屏 React 根按**初始状态**渲染一份只读正文，
// 再取出 innerHTML（见该函数头）。适配、编译、图片内联都在这里做，调用方只负责
// 把结果交给 `buildExportHtml`。上游 `screen.css` 从这里 side-effect import ——
// 编辑器页面因此一定会把它带进 head，`collectStyleMarkup` 才抄得到。
// **不 import `print.css`**：它带全局 `@page`，站点的打印规则已经是作用域化的
// （见 `src/styles-scss/pages/blog/_reactive-md.scss` 的 `@media print`），
// 导出件不该再被第二套全局分页规则接管。
// ─────────────────────────────────────────────────────────────────────────────

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { compileLocal, createLocalRuntime, type LocalDocument, type LocalNode } from 'reactive-md';
import { LocalDocumentView } from 'reactive-md/react/unstyled';
import 'reactive-md/screen.css';

import { renderSiteEmbedStatic } from '@/app/components/reactive/site-embed-static';
import type { ContentFormat } from '@/lib/content-format';
import { adaptReactivePreview, createClientReferenceReader } from '@/lib/reactive/client-compile';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';
import type { SiteHostData } from '@/lib/reactive/ref-types';
import { isAllowedReactiveUrl } from '@/lib/reactive/url-policy';
import { MAX_REF_CONCURRENCY, createConcurrencyLimiter } from '@/lib/content-refs';

/**
 * 解析相对地址时的**基准地址** —— 这一页自己的地址。
 *
 * 为什么是「页面地址」而不是「站点源（origin）」：正文里的相对地址（`../`、
 * `./x`、`x.png`）本来就是**相对于本页**写的，只有页面地址才解析得出它的目标。
 * 从前只认 `/` 开头的值，于是 `[首页](../)` 这类相对链接在导出件里原样留着，
 * 双击打开就指向 `file:///C:/…/` 那一层 —— 链接看着在，点下去什么也没有。
 */
function pageBase(explicit?: string): string {
  if (explicit) return explicit;
  return typeof window === 'undefined' ? '' : window.location.href;
}

/**
 * 把一个属性值解析成绝对地址。**只解析真的相对地址**，其余原样返回：
 *   · `#锚点` —— 导出件**内部**的跳转，必须继续指自己。`new URL('#x', base)`
 *     会把它拼成 `https://站点/…/#x`，那正是这里最要避免的（等于加了个 `<base>`）；
 *   · 空串 / `data:` / `blob:` / `javascript:` / `about:` —— 不是「地址」；
 *   · 解析不出来的畸形串 —— 原样留着，总好过改写成另一个畸形串。
 *
 * 其余一律 `new URL(value, base)`：
 *   · `/api/…`、`../x`、`x.png` → 站点绝对地址（导出件从 `file://` 打开才取得到）；
 *   · `//cdn.test/a.png` → **补上这一页的协议**。协议相对地址在 `file://` 下会被
 *     解析成 `file://cdn.test/a.png` —— 一个不存在的主机上的文件，必裂；
 *   · `https://…` / `mailto:` / `tel:` → 解析结果就是它自己，等于没动。
 */
export function resolveUrl(value: string, base: string): string {
  if (!base || value === '' || value.startsWith('#')) return value;
  if (/^(?:data|blob|javascript|about|mailto|tel):/i.test(value)) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/**
 * `<style>` / 行内 `style` 里 `url(…)` 的地址补成绝对地址。
 *
 * MathJax 的 CHTML 字体表就是这种形态：`src: url("/static/mathjax/woff-v2/…")`。
 * 样式里的相对地址是**相对于文档基址**解析的 —— 导出件从 `file://` 打开时
 * 它指向 `file:///C:/…/static/…`，一律 404，公式只能用回退字体（字形与间距都不对）。
 * 判据与属性那条同一个 `resolveUrl`：`data:` / `#filter` / 已经是绝对的地址不动。
 */
export function absolutizeCssUrls(css: string, base: string): string {
  if (!base) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (all, quote: string, value: string) => {
    const resolved = resolveUrl(value, base);
    return resolved === value ? all : `url(${quote}${resolved}${quote})`;
  });
}

/**
 * 同源样式表**内联**成 `<style>`，让导出件离线也有版式。
 *
 * `<link>` 只能是绝对地址、离线打开时取不到；而浏览器已经把同源样式表解析进
 * `link.sheet` 了，读 `cssRules` 就能拿到原文。跨源样式表（字体 CDN 之类）会抛
 * SecurityError —— 那些**原样保留 link**，绝不因为读不到就把样式整条丢掉。
 * 读得到但为空（还在加载）时同样回退到 link。
 */
function inlineSameOriginSheet(link: HTMLLinkElement, base: string): string | null {
  try {
    const sheet = link.sheet;
    if (!sheet) return null;
    const rules = sheet.cssRules;
    if (!rules || rules.length === 0) return null;
    const css = Array.from(rules)
      .map((rule) => rule.cssText)
      .join('\n');
    if (!css) return null;
    // 规则里的相对 url() 是相对**样式表自己**解析的，所以基准用 link.href。
    return `<style>\n${absolutizeCssUrls(css, link.href || base)}\n</style>`;
  } catch {
    return null;
  }
}

/** 把 head 里的样式抄成一段可以直接放进导出件的标记。 */
function collectStyleMarkup(base: string): string {
  const parts: string[] = [];
  for (const node of Array.from(
    document.head.querySelectorAll('link[rel="stylesheet"], style')
  )) {
    if (node.tagName === 'LINK') {
      const link = node as HTMLLinkElement;
      const inlined = inlineSameOriginSheet(link, base);
      if (inlined) {
        parts.push(inlined);
        continue;
      }
      // 浏览器已经把 `.href` 解析成绝对地址了 —— 直接用，别自己拼
      const href = link.href;
      if (href) parts.push(`<link rel="stylesheet" href="${href}">`);
    } else {
      parts.push(absolutizeCssUrls(node.outerHTML, base));
    }
  }
  return parts.join('\n');
}

/**
 * 把正文与内联样式里的**相对地址**解析成这一页的绝对地址，让导出件从 `file://`
 * 打开时图片、音频、站内链接、背景图照样出得来。
 *
 * 覆盖四类落点：`src` / `href` / `poster` 三个属性、以及 `style` 属性与正文里的
 * `<style>`（MathJax / 编辑器的行内样式都可能带 `url(…)`）。
 * 不动的那些（`#锚点`、`data:`、已经是绝对的地址）见 `resolveUrl` 的说明。
 */
export function absolutizeSiteUrls(root: HTMLElement, base?: string): void {
  const resolvedBase = pageBase(base);
  if (!resolvedBase) return;
  for (const attr of ['src', 'href', 'poster'] as const) {
    root.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
      const value = el.getAttribute(attr);
      if (!value) return;
      const next = resolveUrl(value, resolvedBase);
      if (next !== value) el.setAttribute(attr, next);
    });
  }
  root.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    const css = el.getAttribute('style');
    if (!css || !css.includes('url(')) return;
    const next = absolutizeCssUrls(css, resolvedBase);
    if (next !== css) el.setAttribute('style', next);
  });
  root.querySelectorAll('style').forEach((el) => {
    const css = el.textContent;
    if (!css || !css.includes('url(')) return;
    el.textContent = absolutizeCssUrls(css, resolvedBase);
  });
}

/**
 * 纯 `#锚点` 链接在导出件里要**就地跳**。
 *
 * 渲染管线给只读预览的正文里每一条链接都加了 `target="_blank" rel="noopener …"`
 * （站内预览的规矩：就地点跳会丢掉没发布的草稿）。导出件是一份**死文件**，
 * `#锚点` 是它**自己文档内部**的跳转 —— 留着 `target` 就是「点一下弹出第二个标签页，
 * 里面是同一份文件」，而且新标签页连锚点都不一定带过去（用户看到的是「点了没反应」）。
 * 只摘这一类的 target / rel：真正的外链仍然新窗口开（那是它们本来的行为）。
 */
export function localizeFragmentLinks(root: HTMLElement): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.removeAttribute('target');
    a.removeAttribute('rel');
  });
}

/**
 * 剥掉**只在站内页面上才成立的空壳**。
 *
 * 目前只有代码块的「复制」按钮：它是 `blog-renderer.ts` 直接写在 HTML 里的
 * `<button class="copy-btn" data-code="…">`，行为由 blog-content-dom.ts 挂 JS。
 * 导出件是一份**死**的静态文件，留着它就是一颗按不动的按钮 —— 占版面、还误导人。
 */
export function stripInteractiveShells(root: HTMLElement): void {
  root.querySelectorAll('.copy-btn').forEach((el) => el.remove());
}

/**
 * ReactiveMD 导出件的固定说明：只含**初始状态**。
 *
 * 导出发生在作者的工作台上，但导出的语义是「与读者打开时看到的初始状态一致」，
 * 不是作者此刻拖过的滑杆值。`renderStaticMarkup` 把它写进正文末尾的注释里；
 * 调用方也可以把它当 `buildExportHtml` 的 `footerNote` 显示出来。
 */
export const REACTIVE_EXPORT_NOTE =
  'ReactiveMD 文档：导出件展示初始状态；交互控件在导出件中不可用。';

/**
 * 单张图片**从发出请求到读完 body** 的总上限。
 *
 * 与整体预算分开的两个理由：
 *   · 一张外链图片的服务器完全不响应时，没有单图上限就只有一个整次导出的上限；
 *   · 单图上限让「坏的那张」尽早让位，其他图片继续排队（并发闸门只有 4 格）。
 */
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/**
 * 整次导出的图片预取总预算。
 *
 * 从开始预取算起，到点后**不再发起新的图片**、在飞的也按剩余预算封顶。
 * 这个数不是「等图片多久」，而是「导出最多被图片挡住多久」：预取之后还要
 * 离屏 React 渲染一次，整段体验不能被一串慢外链无限拖长。
 */
export const IMAGE_PREFETCH_BUDGET_MS = 20_000;

/**
 * 单张图片允许读入内存的字节上限。
 *
 * 与图床上传的请求上限（`MAX_REQUEST_BYTES` = 12MiB）同量级：本站自己产出的
 * 图片不会更大，外链图超过这个量级时导出件也不该为它撑爆内存。
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * 所有图片**合计**允许读入的字节上限 —— 并发再高也不越过这一条。
 *
 * 单图上限挡不住「30 张各 10MB」：base64 还要再涨三分之一，全部驻留在同一个
 * Map 里。图片是按需放弃的（超预算的那张保留 alt 回退），其余正文照常导出。
 */
export const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;

/** `Promise.race` 里代表「到点了」的哨兵值（与 null / 正常结果区分开）。 */
const PREFETCH_TIMEOUT = Symbol('image-prefetch-timeout');

/**
 * 从**编译成功的 AST** 里收集真正会被渲染的图片地址。
 *
 * 只认 `type === 'image'` 的节点：Markdown 图片与原生 `<img>` 编译后都是它，
 * 而代码围栏 / 行内代码里的示例是 `code` / `inlineCode` 节点（值只是一段字符串）。
 * 从源码跑正则会把这些示例也当图片去取 —— 既浪费整次导出的预算，又会在网络
 * 面板里凭空多出几个请求；`[@…]` 适配后才出现的地址它也认不出来。
 */
export function collectDocumentImageUrls(document: Pick<LocalDocument, 'nodes'>): string[] {
  const urls = new Set<string>();
  const visit = (nodes: readonly LocalNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'image' && typeof node.url === 'string' && node.url !== '') {
        urls.add(node.url);
      }
      if (node.children?.length) visit(node.children);
    }
  };
  visit(document.nodes);
  return [...urls];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块：`String.fromCharCode(...bytes)` 在长图上会撞调用栈上限。
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface ParsedImage {
  mime: string;
  bytes: Uint8Array;
}

/** 所有图片共享的一份剩余字节额度。读取在单线程里推进，减扣不会交错。 */
interface ByteBudget {
  remaining: number;
}

function fitsBudget(size: number, budget: ByteBudget): boolean {
  return size > 0 && size <= MAX_IMAGE_BYTES && size <= budget.remaining;
}

/** 只取结构上需要的那一格，避免把 DOM 的流泛型卷进签名。 */
interface CancellableReader {
  cancel?: () => Promise<unknown>;
}

function cancelReader(reader: CancellableReader): void {
  if (!reader.cancel) return;
  void reader.cancel().catch(() => undefined);
}

/**
 * 读完整个 body（有上限），或者返回 null 表示这张图放弃。
 *
 * 两条路径：
 *   · 有 `response.body` —— 逐块读，**边读边扣总额度**，超了就停（不会先把
 *     整个 body 收进内存再判断，那正是无界内存的来源）；
 *   · 没有（测试桩 / 老环境）—— 退到 `arrayBuffer()`，读完再判断大小。
 *
 * 挂起由外层 `withPrefetchDeadline` 的 race 兜住；这里额外挂一个 abort 监听，
 * 超时后尽力取消底层流（取消本身不做等待 —— 卡住的流可能连 cancel 都不回来）。
 */
async function readImageBody(
  response: Response,
  signal: AbortSignal,
  budget: ByteBudget
): Promise<ParsedImage | null> {
  const mime = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!mime.startsWith('image/')) return null;

  // Content-Length 可用时先否决：能省掉一次注定超预算的读取。
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && !fitsBudget(declared, budget)) {
    return null;
  }

  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!fitsBudget(bytes.length, budget)) return null;
    budget.remaining -= bytes.length;
    return { mime, bytes };
  }

  const reader = stream.getReader();
  const onAbort = () => cancelReader(reader);
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!fitsBudget(value.length, budget) || total + value.length > MAX_IMAGE_BYTES) {
        cancelReader(reader);
        return null;
      }
      total += value.length;
      budget.remaining -= value.length;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { mime, bytes };
}

/**
 * 把一段工作包进「最多等 ms」的 race，到点 abort 并返回哨兵值。
 *
 * ★ 计时器**必须在工作完成时清掉** ★ 否则一次正常导出也会在后台留一串待触发的
 * timer（长文档几十张图就是几十个），假时钟的用例还会被它们拖住。
 */
function withPrefetchDeadline<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController
): Promise<T | typeof PREFETCH_TIMEOUT> {
  if (ms <= 0) {
    controller.abort();
    return Promise.resolve(PREFETCH_TIMEOUT);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PREFETCH_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(PREFETCH_TIMEOUT);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 把允许的图片**全部先取回来**，再交给同步的 `imageResolver`。
 *
 * 上游的 resolver 是同步签名 —— 渲染到那一张时才开始 fetch 就来不及了，只能
 * 返回 null、由渲染器显示 alt 回退。取不到的（私有图 / 网络失败 / 非图片 /
 * 超时 / 超预算）保持不在表里：那张图按上游的既定形态降级成 alt 文本，
 * **不伪造一个空 data URL**。
 *
 * 有界性有两层（缺一层就会「导出一直转圈」）：
 *   · 单图 `IMAGE_FETCH_TIMEOUT_MS`：fetch 挂起与 body 挂起走同一个 race；
 *   · 整体 `IMAGE_PREFETCH_BUDGET_MS`：到点后队列里的直接跳过，在飞的按剩余
 *     预算封顶。单张失败只影响它自己，其他图片继续。
 * 并发上限仍走站点统一的 `MAX_REF_CONCURRENCY`，与引用取数共用一套。
 */
async function prefetchImages(urls: readonly string[], base?: string): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (urls.length === 0) return resolved;
  const schedule = createConcurrencyLimiter(MAX_REF_CONCURRENCY);
  const pageUrl = pageBase(base);
  const deadline = Date.now() + IMAGE_PREFETCH_BUDGET_MS;
  const budget: ByteBudget = { remaining: MAX_TOTAL_IMAGE_BYTES };

  await Promise.all(
    urls.map((url) =>
      schedule(async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const controller = new AbortController();
        const work = (async () => {
          const response = await fetch(resolveUrl(url, pageUrl), {
            credentials: 'same-origin',
            signal: controller.signal,
          });
          if (!response.ok) return null;
          return readImageBody(response, controller.signal, budget);
        })().catch(() => null);
        const result = await withPrefetchDeadline(
          work,
          Math.min(IMAGE_FETCH_TIMEOUT_MS, remaining),
          controller
        );
        if (result === PREFETCH_TIMEOUT || result === null) return;
        resolved.set(url, `data:${result.mime};base64,${bytesToBase64(result.bytes)}`);
      })
    )
  );
  return resolved;
}

export interface ReactiveStaticMarkupInput {
  /** 作者源码（未适配）。给了 `adaptedSource` 时忽略。 */
  source: string;
  /** 正文语言：决定 `markdownBreaks` 等编译选项。 */
  format: ContentFormat;
  /** 解析相对地址的基准（页面地址）；不传取 `location.href`。 */
  base?: string;
  /** 已适配的源码与 hostData（预览侧已做过同一趟时可复用）。 */
  adaptedSource?: string;
  hostData?: SiteHostData;
}

/**
 * 把一份 ReactiveMD 文档渲染成**只读静态** HTML。
 *
 * 三步，顺序固定：
 *   1. 适配 `[@…]`（与预览同一套 `adaptReactiveReferences`）并编译；
 *   2. 预取允许的图片 → data URL（同步 resolver 才拿得到）；
 *   3. 离屏 `createRoot` + `flushSync` 渲染 `mode="static"` 的 `LocalDocumentView`，
 *      读 `innerHTML`，然后卸载并释放运行时。
 *
 * ⚠️ 只渲染**初始状态**：不 import 状态文件、不读预览里调过的参数。导出件因此
 * 与读者打开时的第一屏一致（见 `REACTIVE_EXPORT_NOTE`）。
 *
 * 编译失败会抛出（调用方据此提示「导出失败」）—— 绝不拿一份空正文冒充成功。
 */
export async function renderStaticMarkup(input: ReactiveStaticMarkupInput): Promise<string> {
  const adapted =
    input.adaptedSource !== undefined
      ? { adaptedSource: input.adaptedSource, hostData: input.hostData ?? {} }
      : // 与预览共用同一份客户端取数 / 适配（client-compile）—— 两处各写一份的话，
        // 「导出里能看见的引用」与「预览里能看见的引用」会慢慢漂开。
        await adaptReactivePreview(input.source, createClientReferenceReader());

  const compiled = compileLocal(adapted.adaptedSource, reactiveCompileOptions(input.format));
  if (!compiled.ok) {
    const codes = compiled.diagnostics.map((diagnostic) => diagnostic.code).join(', ');
    throw new Error(codes ? `ReactiveMD 编译失败：${codes}` : 'ReactiveMD 编译失败');
  }

  // 图片地址从**编译后的 AST** 取，不从源码跑正则：代码围栏 / 行内代码里的
  // `![](...)` 只是字符串，不是会被渲染的图片节点。
  const imageUrls = collectDocumentImageUrls(compiled.document).filter((url) =>
    isAllowedReactiveUrl(url, 'image')
  );
  const resolvedImages = await prefetchImages(imageUrls, input.base);

  const runtime = createLocalRuntime(compiled.document);
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-100000px;top:0;width:760px;';
  document.body.appendChild(container);
  const root = createRoot(container, { identifierPrefix: 'reactive-export-' });
  let mounted = false;
  try {
    flushSync(() => {
      root.render(
        createElement(LocalDocumentView, {
          document: compiled.document,
          runtime,
          mode: 'static',
          locale: 'zh',
          hostData: adapted.hostData,
          hostRenderer: renderSiteEmbedStatic,
          urlPolicy: (url: string, kind: 'image' | 'link') =>
            isAllowedReactiveUrl(url, kind),
          imageResolver: (url: string) =>
            resolvedImages.get(url) ?? resolvedImages.get(resolveUrl(url, pageBase(input.base))) ?? null,
        })
      );
      mounted = true;
    });

    // 相对地址补成站点绝对地址（音频、链接卡片）；`#锚点` 就地跳。
    absolutizeSiteUrls(container, input.base);
    localizeFragmentLinks(container);
    stripInteractiveShells(container);

    // 唯一一处读 innerHTML：读的是**离屏渲染结果**，不是作者输入。
    const html = container.innerHTML;
    return `${html}\n<!-- ${REACTIVE_EXPORT_NOTE} -->`;
  } finally {
    if (mounted) root.unmount();
    container.remove();
    runtime.dispose();
  }
}

/** HTML 文本转义 —— 只用于标题（正文 HTML 是我们自己的渲染产物，不再转义）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ExportOptions {
  /** 文档标题（进 `<title>` 与导出文件名）。 */
  title: string;
  /** 正文容器的 innerHTML（调用方跑完整管线后取出来）。 */
  bodyHtml: string;
  /**
   * 解析相对地址的基准（**页面地址**，不是站点源）；不传就取当前页面的
   * `location.href`（单测可显式传）。
   */
  base?: string;
  /** 导出件末尾的说明（纯文本，会转义）。ReactiveMD 用它交代「只含初始状态」。 */
  footerNote?: string;
}

/**
 * 拼一份可独立打开的 HTML。
 *
 * `body` 的形状沿用文章页（`.blog-content-container` 提供阅读版式），
 * 于是导出件在浏览器里打开的观感与站内文章页一致。
 */
export function buildExportHtml({ title, bodyHtml, base, footerNote }: ExportOptions): string {
  const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${collectStyleMarkup(pageBase(base))}
</head>
<body>
<main class="blog-content-container-container">
<div class="blog-content-container">
${bodyHtml}
</div>
${footerNote ? `<p class="export-note">${escapeHtml(footerNote)}</p>` : ''}
</main>
</body>
</html>
`;
}

/**
 * 文件名里不能出现的字符替换成 `-`。取 Windows 与 POSIX 两批禁用字符的并集
 * （反斜杠 / 斜杠 / 冒号 / 星号 / 问号 / 引号 / 尖括号 / 竖线），空白与控制字符
 * 一并去掉 —— 标题是从服务端原文来的，里头可能真有换行与制表符；而导出件多半要
 * 靠邮件 / 聊天转手，名字里带空格会被转义成一串 %20。
 */
export function safeFilename(title: string, fallback = 'document'): string {
  const cleaned = title
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** 触发一次下载。用 Blob + 临时 `<a>`，不发任何请求。 */
export function downloadHtml(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及取到内容，下一轮任务再释放
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 打印前等待的上限。**超了照打** —— 宁可少一张没加载完的图，
 * 也不能让「点了打印没反应」。
 *
 * ⚠️ 它是**整段等待共用的一个总上限**，从写完 iframe 一直到 `print()` 之前的**每一次**
 * 等待都算在里面：样式 / 图片 → 那几帧 → 字体 → 收尾的两帧。不是每段各给这么久
 * （那会让最坏情况成倍地拖），也不是只给「等资源」那一段 —— 见 `withinDeadline`。
 */
export const PRINT_READY_MAX_MS = 3000;

/** 等两帧：第一帧做布局，第二帧才看得到它触发出来的加载与绘制。 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * 在总预算内等 p；预算已经用完就立刻放行。
 *
 * ⚠️ **连「等几帧」也一律走这里** ★ 这是有界性的关键一半：
 * `requestAnimationFrame` 在**后台标签页里不回调** —— 用户切去别的标签页干别的、
 * 或者从一个刚被藏起来的页面上点了打印（真机上「点了打印没反应」最像的一种）。
 * 直接等它的回调就是一个**没有上界的等待**：那一头永远不回来，后面的
 * `print()` 也就永远不执行，而屏幕上什么都不会说。
 * 与总预算竞速之后，到点就走 —— 宁可少一帧布局，也不能把打印吊死。
 * （`setTimeout` 在后台标签页里会被节流到 ≥1s，但**一定会 fire**：这正是这里要的兜底。）
 */
function withinDeadline(p: Promise<void>, deadline: number): Promise<void> {
  if (deadline - Date.now() <= 0) return Promise.resolve();
  return Promise.race([
    p,
    new Promise<void>((resolve) => setTimeout(resolve, deadline - Date.now())),
  ]).then(() => undefined);
}

/**
 * 等「这一份文档真的画得出来」：先样式表 + 图片（**布局**才算发生），
 * 再回头读**当时**的 `fonts.ready`，最后整体封顶。
 *
 * 三样都必须等，各有各的后果（而且都只在真按下打印时才看得见）：
 *   · 样式表没到 → 打出来**没有版式**；
 *   · 图片没到   → PDF 里是空白框（尤其刚插进去的那张图）；
 *   · 字体没就绪 → MathJax 的 CHTML 公式字形与间距都不对。
 *
 * ★ 顺序不能反：字体必须**排在样式与布局之后** ★
 * `doc.fonts.ready` 在没有字体请求在跑时是**已经兑现**的 Promise。刚 `document.write`
 * 完那一瞬间样式表还没解析出来，也就没有 `@font-face` 规则、更没有任何字体请求 ——
 * 这时候读它等于「等了一个立刻完成的空等待」，`await` 一下就过去了，字体一个都没等。
 * 等到样式表 load 完、再过一两帧让**布局**发生（字体请求是布局触发下载的），
 * 那时读到的 `fonts.ready` 才真的挂着那几个字体文件。前后差的是「公式用回退字体
 * 打出来」，页面上没有任何提示。
 * 两帧：rAF 回调跑在这一帧的样式/布局**之前**，所以第一帧才做布局、第二帧才看得到它
 * 触发出来的加载。
 *
 * `deadline` 是**绝对时刻**（由 printHtml 一处算出，整段等待共用）—— 这里每一段
 * 等待（含那两帧）都要跟它竞速，理由见 `withinDeadline`。
 */
function waitForPrintReady(doc: Document, deadline: number): Promise<void> {
  const waits: Promise<unknown>[] = [];

  doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
    // 已经解析出 sheet 的说明早就加载好了（同源 CSS 读得到 sheet）——
    // 这等于是给「监听器挂晚了」补一条会立刻通过的路径，别让它白等满 3 秒。
    if (link.sheet) return;
    waits.push(
      new Promise<void>((resolve) => {
        const done = () => {
          link.removeEventListener('load', done);
          link.removeEventListener('error', done);
          resolve();
        };
        link.addEventListener('load', done);
        link.addEventListener('error', done);
      })
    );
  });

  doc.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    // complete 在「已加载」和「已失败」两种情况下都是 true —— 两种都不必等，
    // 失败的那张本来就是裂图，再等也不会变好。
    if (img.complete) return;
    waits.push(
      new Promise<void>((resolve) => {
        const done = () => {
          img.removeEventListener('load', done);
          img.removeEventListener('error', done);
          resolve();
        };
        img.addEventListener('load', done);
        img.addEventListener('error', done);
      })
    );
  });

  const settled = waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  return withinDeadline(settled, deadline)
    // 让布局发生（两帧）—— **也走总预算**：rAF 在后台标签页里不回调，
    // 裸等它就成了没有上界的等待（见 withinDeadline）。
    .then(() => withinDeadline(afterPaint(), deadline))
    .then(() => {
      // ★ 到这里才读 fonts.ready（见上面那段）★
      const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
      if (!fonts?.ready) return;
      return withinDeadline(fonts.ready.catch(() => undefined).then(() => undefined), deadline);
    });
}

/**
 * 用隐藏 iframe 打印 —— 不 `window.open`，因此**不会被弹窗拦截**。
 *
 * iframe 的 onload 在 `document.write` 这条路径上并不可靠（内容同步写完时事件早已
 * 错过），**但「同步写完」不代表「画得出来」**：样式表、图片、字体都还在路上。
 * 所以这里等 `waitForPrintReady`（封顶 PRINT_READY_MAX_MS），过了再等两帧让
 * 浏览器真的做完布局，然后才调 print；打印完把 iframe 摘掉，否则每点一次就留一个
 * 空文档挂在页面上。
 *
 * 传入的 html 应当已经过 `buildExportHtml`：那里的样式与正文地址都是绝对的，
 * 与本页无关 —— iframe 里是 `about:blank`，相对地址在那儿的解析结果不可指望。
 */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  // ★ 一个总预算，一处算 ★ 从这里到 print 之前的每一次等待都算在里面 ——
  // 包含收尾那两帧（rAF 在后台标签页里不回调，裸等它就没有上界）。
  const deadline = Date.now() + PRINT_READY_MAX_MS;

  void waitForPrintReady(doc, deadline)
    .then(() => withinDeadline(afterPaint(), deadline))
    .then(() => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } finally {
        // 给打印对话框一点时间取走文档再摘
        setTimeout(() => frame.remove(), 1000);
      }
    });
}
