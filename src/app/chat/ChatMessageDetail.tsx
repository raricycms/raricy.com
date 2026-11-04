'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageDetail.tsx — 单条消息的「文字详情」浮层。
//
// 【为什么需要它】移动端为了「长按开操作面板」把消息正文的原生选字关掉了
// （见 _chat.scss 的触屏区块），选字 / 复制就得另给一个可操作的面。桌面端左键单击
// 正文也落到这里 —— 两端的入口不同，落到同一个可选中、可复制的详情面。
//
// 【为什么正文用 ChatMarkdown 而不是纯文本】消息本来是什么样，详情里就该是什么样；
// 纯文本会把 `**粗体**`、表情 token、名片原样摊开。详情层在 `.chat-msg` 之外，
// 不受消息列表那条 `user-select: none` 影响，原生选字与复制照常可用。
//
// 【定位】走站内统一弹窗外壳（.modal-overlay / .modal-dialog / .modal-content），
// 与发起私聊、搜索消息同一套；点遮罩 / Esc / 关闭按钮都能关。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessageDTO } from '@/lib/chat-shared';
import ChatMarkdown from './ChatMarkdown';
import { fmtTime } from './ChatMessageItem';

export default function ChatMessageDetail({
  msg,
  onClose,
}: {
  msg: ChatMessageDTO;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // 打开即把焦点放到关闭按钮：键盘用户不会留在背后的消息列表里。
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay show" onClick={onClose}>
      <div
        className="modal-dialog chat-detail"
        role="dialog"
        aria-modal="true"
        aria-label="消息详情"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">消息详情</h3>
            <button
              ref={closeRef}
              type="button"
              className="chat-modal-close"
              onClick={onClose}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <div className="modal-body">
            <div className="chat-detail__meta">
              <span className="chat-detail__author">{msg.author.username}</span>
              <span className="chat-detail__time numeric">{fmtTime(msg.created_at)}</span>
            </div>
            <div className="chat-detail__body">
              <ChatMarkdown content={msg.content} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
