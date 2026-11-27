'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatGenerationItem.tsx — 生成中的临时消息行（正式消息落库前的预览）
//
// 与 ChatMessageItem 刻意分开：临时行不是 ChatMessageDTO，不参与菜单、回复、拍一拍、
// 保存、已读回执与未读计数（state 在 ChatApp 的 useChatGenerations 里，按 SSE
// generation_snapshot 逐帧替换完整正文）。正式消息到达后由 ChatApp 移除本行。
//
// 【为什么还要分步显示】服务端快照是 200ms 一帧（5 帧/秒），直接渲染会让视觉节奏
// 比原来的 10 帧/秒顿一半。这里把每帧新增的后缀切成两个进度点：快照到达先显示
// 前半段，100ms 后补上后半段；新快照若提前到达，立即从当前已显示位置重新规划，
// 不播放过时中间态。计划逻辑在 generation-reveal.ts，便于单测。
//
// 渲染只复用聊天正文壳（ChatRmdMessage，streaming 阶段不取引用/媒体）与气泡/头像
// 语义；样式在 _chat.scss 的 chat-msg--generating 段（G 负责）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Avatar from '@/app/components/Avatar';
import ChatBubble from '@/app/components/ChatBubble';
import type { ChatGenerationPreview } from './useChatGenerations';
import {
  GENERATION_REVEAL_INTERVAL_MS,
  planGenerationReveal,
} from './generation-reveal';
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
  // 初始快照直接显示；之后每个快照的新增后缀分两步追赶。
  const [displayedSource, setDisplayedSource] = useState(() => generation.source);
  const displayedRef = useRef(displayedSource);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const steps = planGenerationReveal(displayedRef.current, generation.source);
    if (steps.length === 0) return;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    let index = 0;
    const showNext = (): void => {
      const next = steps[index];
      index += 1;
      displayedRef.current = next;
      setDisplayedSource(next);
      timerRef.current = index < steps.length
        ? setTimeout(showNext, GENERATION_REVEAL_INTERVAL_MS)
        : null;
    };
    showNext();

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [generation.source]);

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
          {generation.author.id ? (
            <Link className="chat-msg__name" href={`/u/${generation.author.id}`}>
              {generation.author.username}
            </Link>
          ) : (
            <span className="chat-msg__name">{generation.author.username}</span>
          )}
          <span className="chat-msg__time chat-msg__time--generating">正在生成…</span>
        </div>
        <div className="chat-msg__own-blocks">
          <ChatBubble bubbleKey={generation.author.bubble_key}>
            {displayedSource.trim() ? (
              <ChatRmdMessage
                messageKey={`gen:${generation.generationId}`}
                content={displayedSource}
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
