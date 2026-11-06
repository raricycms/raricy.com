// ─────────────────────────────────────────────────────────────────────────────
// chat-markdown.ts — 讨论正文的 Markdown → 安全 HTML
//
// 【本文件现在很薄，这是有意的】管线（marked → DOMPurify → 后处理）、五道防线与
// **标签 / 属性白名单**全在 src/lib/rich-text.ts —— 与评论正文共用同一套（R3-151）。
// 那条注释把威胁模型讲全了（含 marked 的 inRawBlock 裸文本通道钓鱼向量），
// 要改安全行为请改那里，并同步 tests/unit/chat-markdown.test.ts。
//
// 这里只回答一个问题：**讨论气泡的链接类名与缓存上限是什么**（白名单两端共用，不在这里）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  createRichTextRenderer,
  RICH_TEXT_ALLOWED_ATTR,
  RICH_TEXT_ALLOWED_TAGS,
  type RichTextContext,
} from './rich-text';

/** 净化后的链接统一带的类名（复用既有样式，也让 e2e 能按类定位）。 */
const LINK_CLASS = 'chat-msg__link';

/** 渲染结果缓存上限（DOM_CAP 是 300，同量级即可覆盖当前可见消息）。 */
const CACHE_MAX = 300;

const renderer = createRichTextRenderer({
  allowedTags: RICH_TEXT_ALLOWED_TAGS,
  allowedAttr: RICH_TEXT_ALLOWED_ATTR,
  linkClass: LINK_CLASS,
  cacheMax: CACHE_MAX,
});

/**
 * 讨论正文渲染入口（带缓存）。
 *
 * 【为什么缓存】消息一旦落库内容就不再变，而讨论列表会因输入、SSE、对账频繁重渲染。
 * 以 content 为键做 FIFO 缓存（上限 300，与 DOM_CAP 同量级），把 marked + DOMPurify
 * 的开销压到「每条消息只算一次」。
 * ⚠️ 例外：正文里含用户名片 token 的不进缓存（名片数据会变），见 rich-text.ts。
 *
 * @param ctx 外挂数据（目前只有用户名片）。缺省 = 还没取到，token 显示字面量。
 */
export function renderChatMarkdown(content: string, ctx?: RichTextContext): string {
  return renderer.render(content, ctx);
}
