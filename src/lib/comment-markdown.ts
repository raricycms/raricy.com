// ─────────────────────────────────────────────────────────────────────────────
// comment-markdown.ts — 评论正文的 Markdown → 安全 HTML
//
// 【与聊天同管线，同白名单】实现全在 src/lib/rich-text.ts（五道防线在那边逐条讲）。
// 评论和聊天是同一类东西 —— 用户输入、渲染给所有登录用户看的公共区域 —— 所以
// 白名单**刻意与 chat-markdown.ts 逐字相同**：两边能写的东西一样，用户不必记
// 「这句话在评论里能排版、在聊天里不能」。
//
// 与聊天的唯一差别是链接类名：聊天气泡的 `.chat-msg__link` 有自己的字号 / 颜色，
// 套到评论区会显得突兀，故单独一个 `comment-link`（样式见 pages/blog/_blog.scss）。
//
// ⚠️ 改这里 = 改安全边界。对等单测：tests/unit/comment-markdown.test.ts
//    （用例与 chat-markdown.test.ts 逐条对齐，仅类名断言不同）。
// ─────────────────────────────────────────────────────────────────────────────

import { createRichTextRenderer } from './rich-text';

/** 与 chat-markdown.ts 的 ALLOWED_TAGS 逐字相同（见文件头「同白名单」的说明）。 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
];

const ALLOWED_ATTR = ['href', 'title', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled'];

/** 评论正文里链接的类名（样式在 pages/blog/_blog.scss 的 .comment-content 下）。 */
const LINK_CLASS = 'comment-link';

/** 评论比聊天少得多：一篇博客至多几百条，上限给 200 足够覆盖当前展开的评论树。 */
const CACHE_MAX = 200;

const renderer = createRichTextRenderer({
  allowedTags: ALLOWED_TAGS,
  allowedAttr: ALLOWED_ATTR,
  linkClass: LINK_CLASS,
  cacheMax: CACHE_MAX,
});

/**
 * 评论正文渲染入口（带缓存）。
 *
 * 【为什么缓存】评论内容落库后不再变，但评论区会因「回复 / 删除 / 点赞」整树重渲染，
 * 而 renderCommentMarkdown 是在 render 期间同步调用的（每棵子树每个节点一次）。
 * 以内容为键 FIFO 缓存，把 marked + DOMPurify 的开销压到「每条评论只算一次」。
 */
export function renderCommentMarkdown(content: string): string {
  return renderer.render(content);
}
