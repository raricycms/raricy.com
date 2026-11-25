'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatGenerationItem.tsx — 生成中的临时消息行（正式消息落库前的预览）
//
// 与 ChatMessageItem 刻意分开：临时行不是 ChatMessageDTO，不参与菜单、回复、拍一拍、
// 保存、已读回执与未读计数（state 在 ChatApp 的 useChatGenerations 里，按 SSE
// generation_snapshot 逐帧替换完整正文）。正式消息到达后由 ChatApp 移除本行。
//
// 渲染只复用聊天正文壳（ChatRmdMessage，streaming 阶段不取引用/媒体）与气泡/头像
// 语义；样式在 _chat.scss 的 chat-msg--generating 段（G 负责）。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import Avatar from '@/app/components/Avatar';
import ChatBubble from '@/app/components/ChatBubble';
import type { ChatGenerationPreview } from './useChatGenerations';
import ChatRmdMessage from './ChatRmdMessage';

export default function ChatGenerationItem({
  generation,
  isMine,
  onImageClick,
  onBeforeContentChange,
  onContentChange,
}: {
  generation: ChatGenerationPreview;
  isMine: boolean;
  onImageClick?: (url: string) => void;
  /** 编译/渲染高度即将变化前通知 ChatApp 记录「变化前是否贴底」。 */
  onBeforeContentChange?: () => void;
  /** 编译/渲染高度变化后通知 ChatApp 按「贴底才跟随」规则滚动。 */
  onContentChange?: () => void;
}) {
  return (
    <div
      className={`chat-msg chat-msg--generating${isMine ? ' chat-msg--mine' : ''}`}
      data-generation-id={generation.generationId}
    >
      <Avatar
        userId={generation.author.id}
        src={generation.author.avatar_url}
        frameUrl={generation.author.frame_url}
        alt={generation.author.username}
        loading="lazy"
        className="chat-msg__avatar"
      />
      <div className="chat-msg__body">
        <div className="chat-msg__meta">
          <Link className="chat-msg__name" href={`/u/${generation.author.id}`}>
            {generation.author.username}
          </Link>
          <span className="chat-msg__time chat-msg__time--generating">正在生成…</span>
        </div>
        <div className="chat-msg__own-blocks">
          <ChatBubble bubbleKey={generation.author.bubble_key}>
            {generation.source.trim() ? (
              <ChatRmdMessage
                messageKey={`gen:${generation.generationId}`}
                content={generation.source}
                phase="streaming"
                allowBareImage={false}
                onImageClick={onImageClick}
                onBeforeContentChange={onBeforeContentChange}
                onContentChange={onContentChange}
              />
            ) : (
              // 仅首个空快照会走到：给一个占位，避免空气泡闪一下就没有内容。
              <span className="chat-msg__generating-pending" aria-label="正在生成" />
            )}
          </ChatBubble>
        </div>
      </div>
    </div>
  );
}