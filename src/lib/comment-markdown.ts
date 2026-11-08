// ─────────────────────────────────────────────────────────────────────────────
// comment-markdown.ts — 评论正文的 Markdown → 安全 HTML
//
// 【与讨论同管线，同一份白名单】实现全在 src/lib/rich-text.ts（五道防线在那边逐条讲）。
// 评论和讨论是同一类东西 —— 用户输入、渲染给所有登录用户看的公共区域 —— 所以
// **标签 / 属性白名单是同一份**（`RICH_TEXT_ALLOWED_TAGS` / `RICH_TEXT_ALLOWED_ATTR`，
// 住 rich-text.ts，见 R3-151）：两边能写的东西一样，用户不必记「这句话在评论里能排版、
// 在讨论里不能」。这里不再各自持有一份副本 —— 那正是「只改一边、另一边静默漂移」的来源。
//
// 与讨论的唯一差别是链接类名（与缓存上限）：讨论气泡的 `.chat-msg__link` 有自己的
// 字号 / 颜色，套到评论区会显得突兀，故单独一个 `comment-link`（样式见 pages/blog/_blog.scss）。
//
// ⚠️ 改这里 = 改安全边界。对等单测：tests/unit/chat-markdown.test.ts
//    （原 comment-markdown.test.ts 已于 Round4 并入，用例与讨论侧逐条对齐，仅类名断言不同）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  createRichTextRenderer,
  RICH_TEXT_ALLOWED_ATTR,
  RICH_TEXT_ALLOWED_TAGS,
  type RichTextContext,
} from './rich-text';

/** 评论正文里链接的类名（样式在 pages/blog/_blog.scss 的 .comment-content 下）。 */
const LINK_CLASS = 'comment-link';

/** 评论比讨论少得多：一篇博客至多几百条，上限给 200 足够覆盖当前展开的评论树。 */
const CACHE_MAX = 200;

const renderer = createRichTextRenderer({
  allowedTags: RICH_TEXT_ALLOWED_TAGS,
  allowedAttr: RICH_TEXT_ALLOWED_ATTR,
  linkClass: LINK_CLASS,
  cacheMax: CACHE_MAX,
});

/**
 * 评论正文渲染入口（带缓存）。
 *
 * 【为什么缓存】评论内容落库后不再变，但评论区会因「回复 / 删除 / 点赞」整树重渲染，
 * 而 renderCommentMarkdown 是在 render 期间同步调用的（每棵子树每个节点一次）。
 * 以内容为键 FIFO 缓存，把 marked + DOMPurify 的开销压到「每条评论只算一次」。
 * ⚠️ 例外：正文里含用户名片 token 的不进缓存（名片数据会变），见 rich-text.ts。
 *
 * @param ctx 外挂数据（目前只有用户名片）。缺省 = 还没取到，token 显示字面量。
 */
export function renderCommentMarkdown(content: string, ctx?: RichTextContext): string {
  return renderer.render(content, ctx);
}
