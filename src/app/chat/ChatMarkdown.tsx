'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMarkdown.tsx — 消息正文的渲染壳（薄壳，与 CommentMarkdown 同构）
//
// 真正干活的全在别处：
//   · marked → DOMPurify → 后处理：@/lib/chat-markdown（白名单 + 五道防线）
//   · `[@<8位剪贴板ID>]` 的异步展开、内联图片的点击放大：@/app/components/RichContentBody
//
// 这里只回答一个问题：**用哪个类名、哪个白名单**。
//
// 【水合说明】renderChatMarkdown 在无 DOM 环境返回转义纯文本，客户端返回净化后的
// HTML —— 两者不同，但**消息列表是客户端拉取的**（ChatApp 的 messages 初始为 []，
// SSR 期一条消息都不渲染），因此不存在服务端/客户端首帧不一致。若将来改成服务端
// 直出消息，这里必须改成「挂载后再渲染 Markdown」的门控写法。
// ─────────────────────────────────────────────────────────────────────────────

import RichContentBody from '@/app/components/RichContentBody';
import { renderChatMarkdown } from '@/lib/chat-markdown';

export default function ChatMarkdown({ content }: { content: string }) {
  return <RichContentBody content={content} className="chat-msg__md" render={renderChatMarkdown} />;
}
