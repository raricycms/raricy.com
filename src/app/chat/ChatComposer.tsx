'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatComposer.tsx — 输入区（回复条 / 博客引用 / 待发图片 / 工具栏 / 输入框 / 发送）
//
// 纯展示 + 回调：状态仍在 ChatApp（草稿按频道保存、insertMention 需要跨组件操作
// 输入框，状态上提更省事）。fileRef / textareaRef 由 ChatApp 持有并传入。
// ─────────────────────────────────────────────────────────────────────────────

import { BookOpenText, Image as ImageIcon } from 'lucide-react';
import type { ChatMessageDTO } from '@/lib/chat-shared';

// SVG 不在内联展示白名单：raw 路由对 SVG 强制 Content-Disposition: attachment
// （防内联脚本执行的 XSS 设计），<img> 内联渲染必然失败，聊天场景只收位图。
// 文件选择的 accept 与上传前的 MIME 校验共用这一份。
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

export interface ComposerBlogQuote {
  id: string;
  title: string;
  description: string | null;
  author: string | null;
}

export default function ChatComposer({
  activeId,
  text,
  sending,
  pendingImage,
  uploadingImage,
  replyTarget,
  blogQuote,
  textareaRef,
  fileRef,
  onTextChange,
  onSend,
  onPickImage,
  onOpenQuote,
  onClearReply,
  onClearBlogQuote,
  onClearImage,
}: {
  activeId: string | null;
  text: string;
  sending: boolean;
  pendingImage: { id: string; url: string } | null;
  uploadingImage: boolean;
  replyTarget: ChatMessageDTO | null;
  blogQuote: ComposerBlogQuote | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onTextChange: (value: string) => void;
  onSend: () => void;
  onPickImage: (file: File) => void;
  onOpenQuote: () => void;
  onClearReply: () => void;
  onClearBlogQuote: () => void;
  onClearImage: () => void;
}) {
  return (
    <div
      className="chat-composer"
      // 拖拽图片到输入区即上传（与点按钮、粘贴共用同一条 pickImage 校验链路）
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onPickImage(f);
      }}
    >
      {replyTarget && (
        <div className="chat-composer__reply">
          <span className="chat-composer__reply-text">
            回复 {replyTarget.author.username}：{replyTarget.content}
          </span>
          <button
            type="button"
            className="chat-composer__reply-close"
            onClick={onClearReply}
            aria-label="取消回复"
          >
            ×
          </button>
        </div>
      )}
      {blogQuote && (
        <div className="chat-composer__blog">
          <BookOpenText className="chat-composer__blog-icon" aria-hidden="true" />
          <span className="chat-composer__reply-text">{blogQuote.title}</span>
          <button
            type="button"
            className="chat-composer__reply-close"
            onClick={onClearBlogQuote}
            aria-label="移除引用"
          >
            ×
          </button>
        </div>
      )}
      {pendingImage && (
        <div className="chat-composer__image">
          <img src={pendingImage.url} alt="待发送图片" />
          <button
            type="button"
            className="chat-composer__image-remove"
            onClick={onClearImage}
            aria-label="移除图片"
          >
            ×
          </button>
        </div>
      )}

      <div className="chat-composer__panel">
        <div className="chat-composer__toolbar">
          <button
            type="button"
            className="chat-composer__icon-btn"
            onClick={onOpenQuote}
            title="引用博客"
            aria-label="引用博客"
          >
            <BookOpenText aria-hidden="true" />
          </button>
          <button
            type="button"
            className="chat-composer__icon-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploadingImage}
            title="上传图片（图床）"
            aria-label="上传图片"
          >
            {uploadingImage ? '…' : <ImageIcon aria-hidden="true" />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickImage(f);
            }}
          />
        </div>
        <textarea
          ref={textareaRef}
          className="chat-composer__input"
          rows={1}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            // QQ 式自动加高：清高重算，封顶后走 CSS max-height 内滚
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(176, el.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          onPaste={(e) => {
            // 从剪贴板粘图（截图工具最常见）：有文件就拦下、走图床上传
            const f = e.clipboardData.files?.[0];
            if (f) {
              e.preventDefault();
              onPickImage(f);
            }
          }}
        />
        <div className="chat-composer__foot">
          <span className="chat-composer__hint">Enter 发送 · Shift+Enter 换行 · 支持 Markdown</span>
          <button
            type="button"
            className="chat-composer__send"
            onClick={onSend}
            disabled={sending || !activeId}
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
