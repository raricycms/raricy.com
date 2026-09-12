// ─────────────────────────────────────────────────────────────────────────────
// chat-markdown.ts — 聊天正文的 Markdown → 安全 HTML
//
// 【本文件现在很薄，这是有意的】管线（marked → DOMPurify → 后处理）与五道防线的
// 实现全在 src/lib/rich-text.ts —— 它与评论正文共用同一套，只差白名单与类名。
// 那条注释把威胁模型讲全了（含 marked 的 inRawBlock 裸文本通道钓鱼向量），
// 要改安全行为请改那里，并同步 tests/unit/chat-markdown.test.ts。
//
// 这里只负责回答一个问题：**聊天气泡里允许出现什么**。
// ─────────────────────────────────────────────────────────────────────────────

import { createRichTextRenderer } from './rich-text';

/** 白名单标签：只保留聊天气泡里讲得通的语义标签（无 img / iframe / svg / style / form）。 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
];

/**
 * 白名单属性。`input` 的三个属性只为 GFM 任务列表（`- [x] 完成`）服务，
 * 渲染出来是禁用复选框（净化后另有 restrictInputs 兜底）。
 */
const ALLOWED_ATTR = ['href', 'title', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled'];

/** 净化后的链接统一带的类名（复用既有样式，也让 e2e 能按类定位）。 */
const LINK_CLASS = 'chat-msg__link';

/** 渲染结果缓存上限（DOM_CAP 是 300，同量级即可覆盖当前可见消息）。 */
const CACHE_MAX = 300;

const renderer = createRichTextRenderer({
  allowedTags: ALLOWED_TAGS,
  allowedAttr: ALLOWED_ATTR,
  linkClass: LINK_CLASS,
  cacheMax: CACHE_MAX,
});

/**
 * 聊天正文渲染入口（带缓存）。
 *
 * 【为什么缓存】消息一旦落库内容就不再变，而聊天列表会因输入、SSE、对账频繁重渲染。
 * 以 content 为键做 FIFO 缓存（上限 300，与 DOM_CAP 同量级），把 marked + DOMPurify
 * 的开销压到「每条消息只算一次」。
 */
export function renderChatMarkdown(content: string): string {
  return renderer.render(content);
}
