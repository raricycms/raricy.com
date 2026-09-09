// ─────────────────────────────────────────────────────────────────────────────
// blog-markdown.ts — 博客 / 剪贴板正文渲染的**安全边界**（DOMPurify 白名单 + 投票嵌入）
//
// 【为什么单独成模块】正文是用户输入，且渲染给所有读者（含 admin / owner）。
// 白名单与投票嵌入的写入方式集中在这里定义 —— 改这里等于改安全边界，
// 务必同步 tests/unit/blog-markdown.test.ts（对齐 chat-markdown.ts 的做法）。
//
// 【历史教训 · 已复现的存储型 XSS】旧实现把 data-vote-id 的属性值拼进 innerHTML：
//     el.innerHTML = `<a href="/vote/${vid}">[查看投票]</a>`
// DOMPurify 只净化 HTML 结构，拦不住我们**之后自己**拼字符串：属性值里的
// `"` 在 DOM 里是合法字符，getAttribute 原样取回，重新解析就成了可执行 HTML。
//     <div class="vote-embed" data-vote-id='x"><img src=x onerror=alert(1)>'>
// core 用户发一篇博客即可在任意读者（含 admin）会话里执行脚本。
// 修法：① 只放行短 id 形态；② 一律用 DOM API 写入，绝不拼 innerHTML。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DOMPurify 白名单。
 *
 * 为什么留 class / data-vote-id：投票嵌入的 HTML 形态就是
 * `<div class="vote-embed" data-vote-id="...">`，选择器 `.vote-embed[data-vote-id]`
 * 靠这两者定位。data-code 是代码块「复制」按钮的数据。
 *
 * ALLOW_DATA_ATTR: false —— 只放行上面显式列出的两个 data-*，任意其他 data-*
 * 一律剥掉（净化后由我们自己的后处理代码添加属性时不受影响）。
 */
export const BLOG_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'details', 'summary', 'sub', 'sup', 'mark', 'input', 'button',
    'video', 'source', 'track', 'audio',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'class', 'rel', 'target', 'width', 'height',
    'align', 'colspan', 'rowspan', 'type', 'checked', 'disabled', 'data-code',
    'data-vote-id', 'controls', 'autoplay', 'muted', 'loop', 'poster', 'preload',
    'playsinline', 'crossorigin', 'kind', 'srclang', 'label',
  ],
  ALLOW_DATA_ATTR: false,
};

/**
 * 投票 id 形态：short-id.ts 生成的小写字母 + 数字（8~9 位）。
 * 这里放宽到 32 位以兼容历史数据，但**只允许字母数字** ——
 * 引号 / 尖括号 / 空白 / 斜杠一律拒绝，从源头断掉属性逃逸。
 */
const VOTE_ID_RE = /^[A-Za-z0-9]{1,32}$/;

export function isValidVoteId(vid: string | null | undefined): vid is string {
  return typeof vid === 'string' && VOTE_ID_RE.test(vid);
}

/**
 * 渲染「[查看投票]」兜底链接（投票不存在 / 请求失败时）。
 *
 * ★ 用 createElement + textContent，不用 innerHTML ★
 * vid 是不可信输入，拼进 innerHTML 等于把净化过一遍的内容又交还给解析器。
 * 即便校验被绕过，DOM API 也只会把它当**文本**写入，不会解析成标签。
 */
export function renderVoteFallback(el: HTMLElement, vid: string): void {
  el.textContent = '';
  const a = el.ownerDocument.createElement('a');
  a.setAttribute('href', `/vote/${vid}`);
  a.textContent = '[查看投票]';
  el.appendChild(a);
}
