'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMarkdown.tsx — 消息正文的 Markdown 渲染壳
//
// 真正干活的是 @/lib/chat-markdown（marked → DOMPurify → 后处理），这里只负责：
//   · memo：内容不变就跳过重渲染（聊天列表每敲一个字都会重渲染父组件）；
//   · useMemo：同一条消息的重渲染不重复跑管线（模块内还有一层 LRU 缓存兜底）。
//
// 【水合说明】renderChatMarkdown 在无 DOM 环境返回转义纯文本，客户端返回净化后的
// HTML —— 两者不同，但**消息列表是客户端拉取的**（ChatApp 的 messages 初始为 []，
// SSR 期一条消息都不渲染），因此不存在服务端/客户端首帧不一致。若将来改成服务端
// 直出消息，这里必须改成「挂载后再渲染 Markdown」的门控写法。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useMemo } from 'react';
import { renderChatMarkdown } from '@/lib/chat-markdown';

function ChatMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderChatMarkdown(content), [content]);
  if (!html) return null;
  return (
    <div
      className="chat-msg__md"
      // html 来自 renderChatMarkdown：已过 DOMPurify 白名单净化 + 链接加固
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(ChatMarkdown);
