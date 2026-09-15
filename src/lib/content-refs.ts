// ─────────────────────────────────────────────────────────────────────────────
// content-refs.ts — `[@<内容ID>]` 引用语法的**纯逻辑**（识别 / 替换 / 截断）
//
// 【与博客的关系】博客正文那套在 src/app/components/MarkdownRenderer.tsx 的
// ContentRefProcessor 里，是**博客专用**的异步预处理器（它还会内联投票小组件）。
// 评论与讨论走的是另一条同步管线（src/lib/rich-text.ts），本文件是那条管线的
// 引用支持 —— 三种引用里只认两种：
//
//   8 位  → 云剪贴板，正文内联；**一条消息最多展开 1 条**（见 MAX_CLIPBOARD_REFS）
//   10 位 → 图床图片，内联成 <img>；**不请求 API**，只拼 /api/images/<id>/raw
//   9 位  → 投票，**刻意不认**，原样保留字面量（2026-09 定的口径：投票箱是交互
//           组件，塞进讨论气泡 / 楼中楼里没有意义）
//
// ⚠️ 这里导出的正则**比博客那条 `\[@\s*(\w+)\s*\]` 严**（`\w` 含下划线，
// `[@__________]` 也凑得出 10 个字符）。理由：id 会被拼进 `/api/images/<id>/raw`
// 并写成 DOM 属性，形态收紧到「只可能是图床 id」就注入不进任何东西。
// 不匹配的一律保留字面量（fail-closed）。
//
// 本文件零依赖、不碰 DOM 也不碰 React，故可直接单测
// （tests/unit/content-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/** 云剪贴板 ID 长度（`generateShortId(8)`，见 src/lib/short-id.ts）。 */
export const CLIPBOARD_ID_LEN = 8;
/** 投票 ID 长度 —— 认出来只是为了**跳过**它。 */
export const VOTE_ID_LEN = 9;
/** 图床 ID 长度（`generateImageId(10)`，见 src/lib/image-upload.ts）。 */
export const IMAGE_ID_LEN = 10;

/** 字母数字本体（不含下划线 / 空白 / 引号 / 斜杠），两种 id 共用。 */
const ALNUM = '[A-Za-z0-9]';

/**
 * 在**已净化的文本节点**里找图床引用（全局版，一次替换全部）。
 *
 * 匹配 `[@AbCdEf1234]`，也容忍 `[@ AbCdEf1234 ]` 这样的内部空白（与博客同口径）。
 */
export const IMAGE_REF_RE = new RegExp(`\\[@\\s*(${ALNUM}{${IMAGE_ID_LEN}})\\s*\\]`, 'g');

/** 同上，非全局 —— 只问「这个文本节点里有没有」，避免 `lastIndex` 残留。 */
export const IMAGE_REF_PROBE = new RegExp(`\\[@\\s*(${ALNUM}{${IMAGE_ID_LEN}})\\s*\\]`);

/** 找云剪贴板引用（非全局版，只取第一条）。 */
export const CLIPBOARD_REF_PROBE = new RegExp(
  `\\[@\\s*(${ALNUM}{${CLIPBOARD_ID_LEN}})\\s*\\]`
);

/**
 * 一条消息里最多展开几条云剪贴板。
 *
 * 【为什么是 1】剪贴板正文上限 50000 字（CLIP_CONTENT_MAX），而一条消息正文上限
 * 5000 字 —— 放开数量等于给「一条 10 字的短消息」变成几十万字 DOM 的机会，而且
 * 每条引用都是一次额外请求。1 条既够用（引用一段材料），又把最坏情况钉死。
 */
export const MAX_CLIPBOARD_REFS = 1;

/**
 * 一条消息里最多展开几张图床图片（超出部分保留 `[@id]` 字面量）。
 *
 * 【为什么必须封顶】5000 字正文理论上能塞下 ~450 个引用 = 450 次
 * `/api/images/<id>/raw` 的磁盘读。上限是正文的**确定性函数**，所以不破坏渲染
 * 缓存（同样正文 → 同样结果）。
 */
export const MAX_IMAGE_REFS = 50;

/**
 * 展开后的剪贴板正文上限。
 *
 * 【为什么截断】引用只占 10 个字符，但展开出来的是**另一名用户**写的、上限
 * 50000 字的内容。博客正文里 5 万字是合理的，讨论列表里就是灾难（而且这些节点
 * 会长期挂在列表上）。截断处给一句说明 + 回原剪贴板的链接，信息不丢。
 */
export const CLIP_EXPAND_MAX = 2000;

/** 剪贴板取不到时的占位文案，与博客侧逐字一致。 */
export function clipboardFailureText(id: string): string {
  return `[剪贴板 ${id} 加载失败]`;
}

/** 内联图片的类名（净化后由我们自己的代码添加，用户伪造不了）。 */
export const IMAGE_REF_CLASS = 'rich-image-ref';

// ── 云剪贴板（8 位）─────────────────────────────────────────────────────────

export interface ClipboardRef {
  id: string;
  /** 原文里的完整匹配（含内部空白），用于精确定位替换区间。 */
  match: string;
  /** 匹配区间在原文里的起点。 */
  start: number;
}

/**
 * 找出**第一条**要展开的云剪贴板引用（没有就 null）。
 *
 * 只认第一条 = MAX_CLIPBOARD_REFS 的落地点：后面的 `[@8位]` 既不请求也不替换，
 * 原样留在正文里（与博客超出 50 处时的行为一致 —— 静默保留字面量，不报错）。
 */
export function firstClipboardRef(text: string): ClipboardRef | null {
  const m = CLIPBOARD_REF_PROBE.exec(text);
  if (!m || m.index === undefined) return null;
  return { id: m[1], match: m[0], start: m.index };
}

/**
 * 把那条引用换成剪贴板正文。
 *
 * ★ 按区间切片，不重扫整串 ★ —— 若照博客那样 `processed.replace(match, ...)`，
 * 插入的剪贴板正文里若含同样的 `[@id]`，`replace` 会命中**插入内容里的那处**，
 * 于是「一条消息最多 1 条剪贴板」被绕过（剪贴板正文里的引用会被再展开一次）。
 * 切片没有这个问题。
 */
export function replaceClipboardRef(text: string, ref: ClipboardRef, content: string): string {
  return text.slice(0, ref.start) + content + text.slice(ref.start + ref.match.length);
}

/**
 * 展开结果过长时截断，并附一句说明 + 回原剪贴板的链接。
 *
 * 链接写成 Markdown，因为它随后会跟正文一起过 marked。
 */
export function truncateClipboardContent(content: string, id: string): string {
  if (content.length <= CLIP_EXPAND_MAX) return content;
  return (
    `${content.slice(0, CLIP_EXPAND_MAX)}\n\n` +
    `> 内容过长，已截断。[查看完整剪贴板](/clipboard/${id})`
  );
}

// ── 图床图片（10 位 → 净化后换成 <img>）──────────────────────────────────────

/**
 * 把**已净化** DOM 文本节点里的 `[@<10位图床ID>]` 换成真 `<img>`。
 *
 * ★ 这是「我们不放开 img 白名单、图片却出得来」的全部秘密 ★
 * 换在 DOMPurify **之后**：走 createElement + setAttribute，绝不拼 innerHTML
 * （拼 innerHTML = 把到手的内容又交还给解析器；blog-markdown.ts 的文件头记着
 * 一次真实存储型 XSS 就是这么来的）。因此用户手写的 `<img>` 照旧被转义、
 * `![](外链)` 照旧降级成链接 —— 能出现的图片只有我们亲手建的这一种形态。
 *
 * 三处刻意跳过（父节点是 `A` / `CODE` / `PRE`）：
 *   · `CODE` / `PRE` —— 用户想**展示这个语法本身**时应该写得出字面量；
 *   · `A` —— `[[@AbCdEf1234]](/blog/1)` 那种写法里，插图会变成 `<a>` 套 `<img>`。
 *
 * 与 linkifyTextNodes 同构：先收集再统一改（边走边改会让 TreeWalker 位置失效）。
 */
export function embedImageRefs(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
      // walker 是 SHOW_TEXT，所以拿到的一定是 Text
      return IMAGE_REF_PROBE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let budget = MAX_IMAGE_REFS;
  for (const node of nodes) {
    if (budget <= 0) break;
    // 每个文本节点用一个新正则：全局正则的 lastIndex 会在多次 exec 之间残留。
    const re = new RegExp(IMAGE_REF_RE.source, 'g');
    const frag = doc.createDocumentFragment();
    let last = 0;
    let replaced = 0;
    for (const m of node.data.matchAll(re)) {
      if (budget <= 0) break;
      const at = m.index ?? 0;
      if (at > last) frag.appendChild(doc.createTextNode(node.data.slice(last, at)));
      const img = doc.createElement('img');
      img.className = IMAGE_REF_CLASS;
      img.setAttribute('src', `/api/images/${m[1]}/raw`);
      img.setAttribute('alt', m[1]);
      img.setAttribute('loading', 'lazy');
      frag.appendChild(img);
      last = at + m[0].length;
      budget -= 1;
      replaced += 1;
    }
    if (replaced === 0) continue;
    if (last < node.data.length) frag.appendChild(doc.createTextNode(node.data.slice(last)));
    node.replaceWith(frag);
  }
}
