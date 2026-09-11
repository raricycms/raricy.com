'use client';

// ─────────────────────────────────────────────────────────────────────────────
// RichComposer.tsx — 富文本输入区（聊天与评论共用）
//
// 结构：附件条（回复 / 引用博客 / 待发图片）在上，下面一整块圆角面板
//       （幽灵工具条 → 自动加高文本框 → 底条：左侧提示 + 右下角提交）。
//
// 【为什么共用】评论区要跟聊天区一样的输入体验（Markdown / 图床附件 / 引用博客），
// 而这些东西的行为细节都是踩出来的 —— 触屏设备没有 Shift 键所以 Enter 只能换行、
// 粘贴与拖拽要走同一条上传校验链路、文本框要清高重算才能正确长高。复制一份必然 drift。
//
// 【状态仍在调用方】本组件是纯展示 + 回调：草稿、待发图片、回复目标都由调用方持有
// （聊天还要按频道存草稿、要在点 @ 时操作 textarea，状态上提更省事）。
//
// 【类名由调用方注入】`className` 是整棵子树的 BEM 前缀：
//   · 聊天传 'chat-composer'    → chat-composer__input / __send …
//   · 评论传 'comment-composer' → comment-composer__input / __send …
// 这样两类场景各有一套样式，而组件本身只有一份（聊天既有的 CSS 与 e2e 选择器
// 一个字节都不用改）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { BookOpenText, Image as ImageIcon } from 'lucide-react';
import { IMAGE_ACCEPT } from '@/lib/image-client';
import type { PendingImage } from './usePendingImage';

// 触屏设备（手机/平板）的虚拟键盘没有 Shift 键，Enter 只能承担换行，
// 发送交给右下角按钮。按指针/悬停能力判断，比 UA 嗅探稳，混合设备
// （触屏笔记本外接键盘）也不会误判。SSR 先按桌面渲染，挂载后校正。
function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(hover: none) and (pointer: coarse)');
    if (!mq) return;
    setCoarse(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

export interface ComposerBlogQuote {
  id: string;
  title: string;
  description: string | null;
  author: string | null;
}

/** 回复条预览：label 是「回复 某某」，text 是被回复内容的摘要。 */
export interface ComposerReplyChip {
  label: string;
  text: string;
}

export default function RichComposer({
  className,
  text,
  sending,
  sendDisabled = false,
  sendLabel,
  sendingLabel,
  placeholderLead,
  submitVerb,
  pendingImage,
  uploadingImage,
  replyChip,
  blogQuote,
  textareaRef,
  onTextChange,
  onSend,
  onPickImage,
  onOpenQuote,
  onClearReply,
  onClearBlogQuote,
  onClearImage,
  footerSlot,
}: {
  /** BEM 前缀，见文件头「类名由调用方注入」。 */
  className: string;
  text: string;
  sending: boolean;
  /** 除「正在发送」之外的禁用原因（聊天：没有选中频道）。 */
  sendDisabled?: boolean;
  sendLabel: string;
  sendingLabel: string;
  /** 占位符主句，例：'输入消息' / '说点什么…'（触屏/桌面后缀由本组件补）。 */
  placeholderLead: string;
  /** 提交动作的动词，例：'发送' / '发表评论'（用于占位符与提示文案）。 */
  submitVerb: string;
  pendingImage: PendingImage | null;
  uploadingImage: boolean;
  replyChip: ComposerReplyChip | null;
  blogQuote: ComposerBlogQuote | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onTextChange: (value: string) => void;
  onSend: () => void;
  onPickImage: (file: File) => void;
  onOpenQuote: () => void;
  onClearReply: () => void;
  onClearBlogQuote: () => void;
  onClearImage: () => void;
  /** 底条左侧提示的额外内容（评论用它显示字数上限）。 */
  footerSlot?: React.ReactNode;
}) {
  const isTouch = useCoarsePointer();
  // 文件 input 归自己持有：选完立即清 value，否则连续选同一个文件不会再触发 change。
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div
      className={className}
      // 拖拽图片到输入区即上传（与点按钮、粘贴共用同一条 pickImage 校验链路）
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onPickImage(f);
      }}
    >
      {replyChip && (
        <div className={`${className}__reply`}>
          <span className={`${className}__reply-text`}>
            {replyChip.label}：{replyChip.text}
          </span>
          <button
            type="button"
            className={`${className}__reply-close`}
            onClick={onClearReply}
            aria-label="取消回复"
          >
            ×
          </button>
        </div>
      )}
      {blogQuote && (
        <div className={`${className}__blog`}>
          <BookOpenText className={`${className}__blog-icon`} aria-hidden="true" />
          <span className={`${className}__reply-text`}>{blogQuote.title}</span>
          <button
            type="button"
            className={`${className}__reply-close`}
            onClick={onClearBlogQuote}
            aria-label="移除引用"
          >
            ×
          </button>
        </div>
      )}
      {pendingImage && (
        <div className={`${className}__image`}>
          <img src={pendingImage.url} alt="待发送图片" />
          <button
            type="button"
            className={`${className}__image-remove`}
            onClick={onClearImage}
            aria-label="移除图片"
          >
            ×
          </button>
        </div>
      )}

      <div className={`${className}__panel`}>
        <div className={`${className}__toolbar`}>
          <button
            type="button"
            className={`${className}__icon-btn`}
            onClick={onOpenQuote}
            title="引用博客"
            aria-label="引用博客"
          >
            <BookOpenText aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${className}__icon-btn`}
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
              e.target.value = '';
              if (f) onPickImage(f);
            }}
          />
        </div>
        <textarea
          ref={textareaRef}
          className={`${className}__input`}
          rows={1}
          placeholder={
            isTouch
              ? `${placeholderLead}，Enter 换行，点「${submitVerb}」提交`
              : `${placeholderLead}，Enter ${submitVerb}，Shift+Enter 换行`
          }
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            // QQ 式自动加高：清高重算，封顶后走 CSS max-height 内滚
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(176, el.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            // 触屏：不拦截 Enter，走浏览器默认行为插入换行
            if (isTouch) return;
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
        <div className={`${className}__foot`}>
          <span className={`${className}__hint`}>
            {footerSlot ??
              (isTouch
                ? `Enter 换行 · 点${submitVerb}提交 · 支持 Markdown`
                : `Enter ${submitVerb} · Shift+Enter 换行 · 支持 Markdown`)}
          </span>
          <button
            type="button"
            className={`${className}__send`}
            onClick={onSend}
            disabled={sending || sendDisabled}
          >
            {sending ? sendingLabel : sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
