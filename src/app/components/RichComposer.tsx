'use client';

// ─────────────────────────────────────────────────────────────────────────────
// RichComposer.tsx — 富文本输入区（讨论与评论共用）
//
// 结构：附件条（回复 / 引用博客 / 待发图片）在上，下面一整块圆角面板
//       （幽灵工具条 → 自动加高文本框 → 底条：左侧提示 + 右下角提交）。
//
// 【为什么共用】评论区要跟讨论区一样的输入体验（Markdown / 图床附件 / 引用博客），
// 而这些东西的行为细节都是踩出来的 —— 触屏设备没有 Shift 键所以 Enter 只能换行、
// 粘贴与拖拽要走同一条上传校验链路、文本框要清高重算才能正确长高。复制一份必然 drift。
//
// 【状态仍在调用方】本组件是纯展示 + 回调：草稿、待发图片、回复目标都由调用方持有
// （讨论还要按频道存草稿、要在点 @ 时操作 textarea，状态上提更省事）。
//
// 【类名由调用方注入】`className` 是整棵子树的 BEM 前缀：
//   · 讨论传 'chat-composer'    → chat-composer__input / __send …
//   · 评论传 'comment-composer' → comment-composer__input / __send …
// 这样两类场景各有一套样式，而组件本身只有一份（讨论既有的 CSS 与 e2e 选择器
// 一个字节都不用改）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { BookOpenText, IdCard, Image as ImageIcon, Images, Smile } from 'lucide-react';
import { IMAGE_ACCEPT } from '@/lib/image-client';
import type { PendingImage } from './usePendingImage';
import ImagePickerModal from './ImagePickerModal';
import StickerPicker, { type StickerPickKind } from './StickerPicker';
import UserPicker from './UserPicker';
import { captureCaret, insertAtRange, type CaretRange } from './textarea-insert';

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
  onPickFromLibrary,
  onOpenQuote,
  onClearReply,
  onClearBlogQuote,
  onClearImage,
  onStickerPick,
  stickerPickClosesPanel = true,
  hintExtra,
}: {
  /** BEM 前缀，见文件头「类名由调用方注入」。 */
  className: string;
  text: string;
  sending: boolean;
  /** 除「正在发送」之外的禁用原因（讨论：没有选中频道）。 */
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
  /** 「从图床选择」选中一张已有的图（与上传落在同一条待发附件状态上）。 */
  onPickFromLibrary: (image: PendingImage) => void;
  onOpenQuote: () => void;
  onClearReply: () => void;
  onClearBlogQuote: () => void;
  onClearImage: () => void;
  /**
   * 点了表情面板里的一格，参数是 token `[@合集/表情]` 与它是哪一类。
   *
   * 【为什么交回 token，而不是本组件自己插进 textarea 再让调用方发送】
   * 讨论要「点一下立刻发出去」，而发送读的是调用方的 text state；React 的 setState
   * 是批处理的 —— 本组件 setText 之后，父组件在**同一批次里**读到的 text 还是旧值。
   * 直接发的结果是弹「消息内容不能为空」，或者更糟：**把上一次的草稿当表情消息
   * 发出去**。所以「插不插、发不发」必须由调用方定：
   *   · 评论 → setText(v => insertAtCaret(ta, v, token))   两种都留在草稿里
   *   · 讨论 → 图片表情 sendWith(token)（绕开 textarea 直接发）
   *            黄脸     insertAtCaret（进输入框，**不发**）
   */
  onStickerPick: (token: string, kind: StickerPickKind) => void;
  /**
   * 选完一个表情要不要关面板。
   * 讨论 true（发完就走）；评论 false（通常是连着挑好几个再落笔）。
   */
  stickerPickClosesPanel?: boolean;
  /**
   * 底条左侧提示的**前置**内容（讨论与评论都用它显示字数上限）。
   *
   * 【为什么是前置而不是整体替换】曾经它是整体替换默认提示的，于是评论区的
   * 「Enter 发送 · Shift+Enter 换行 · 支持 Markdown」被顶掉了 —— 而讨论要加
   * 字数提示时同样会丢掉按键说明。前置就只是「多一句」，两边都完整。
   */
  hintExtra?: React.ReactNode;
}) {
  const isTouch = useCoarsePointer();
  // 文件 input 归自己持有：选完立即清 value，否则连续选同一个文件不会再触发 change。
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 图床选择弹窗也归自己持有（同 fileRef 的道理：开合是个纯 UI 状态，调用方不关心）。
  const [pickerOpen, setPickerOpen] = useState(false);
  // 表情面板同理 —— 开合是纯 UI 状态，调用方只关心「选中了哪个」。
  const [stickerOpen, setStickerOpen] = useState(false);
  // 名片选择弹窗与**插入位置**：位置必须在点按钮那一刻先捕获（弹窗要抢焦点），
  // 见 textarea-insert.ts 的 captureCaret。
  const [cardOpen, setCardOpen] = useState(false);
  const cardCaretRef = useRef<CaretRange | null>(null);

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
          <button
            type="button"
            className={`${className}__icon-btn`}
            onClick={() => setPickerOpen(true)}
            disabled={uploadingImage}
            title="从图床选择"
            aria-label="从图床选择"
          >
            <Images aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${className}__icon-btn`}
            // 选区必须在 mousedown 里捕获：等到 click 时焦点已经移到这个按钮上了
            onMouseDown={() => {
              cardCaretRef.current = captureCaret(textareaRef.current);
            }}
            onClick={() => setCardOpen(true)}
            title="发送用户名片"
            aria-label="发送用户名片"
          >
            <IdCard aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${className}__icon-btn`}
            onClick={() => setStickerOpen((v) => !v)}
            title="表情"
            aria-label="表情"
            aria-expanded={stickerOpen}
            // 供 StickerPicker 的「点外面关掉」识别并让开（否则会关了又开）
            data-sticker-toggle
          >
            <Smile aria-hidden="true" />
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
            {hintExtra ? <>{hintExtra} · </> : null}
            {isTouch
              ? `Enter 换行 · 点${submitVerb}提交 · 支持 Markdown`
              : `Enter ${submitVerb} · Shift+Enter 换行 · 支持 Markdown`}
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

      {/* 表情面板贴在输入区下方（不是居中弹窗）—— 理由见 StickerPicker 的文件头 */}
      {stickerOpen && (
        <StickerPicker
          onClose={() => setStickerOpen(false)}
          onPick={(token, kind) => {
            onStickerPick(token, kind);
            // 只有「图片表情 + 调用方说要关」才关。黄脸是**插进输入框**的，
            // 插完通常还要接着挑好几个 —— 关掉面板等于每插一个都要重开一次。
            // （评论端 stickerPickClosesPanel 恒为 false，所以那边永不关。）
            if (kind === 'sticker' && stickerPickClosesPanel) setStickerOpen(false);
          }}
        />
      )}

      {pickerOpen && (
        <ImagePickerModal
          onClose={() => setPickerOpen(false)}
          onPick={(image) => {
            onPickFromLibrary(image);
            setPickerOpen(false);
          }}
        />
      )}

      {cardOpen && (
        <UserPicker
          onClose={() => setCardOpen(false)}
          onPick={(user) => {
            // 插入由本组件直接做（讨论与评论对名片的语义完全一样：插进输入框、不发送），
            // 所以不像表情那样把决定权交回调用方。
            // ⚠️ 不追加尾随空格：token 自带 `]` 边界，而多一个空格在气泡里就是多一个空隙。
            onTextChange(
              insertAtRange(textareaRef.current, text, `[@用户/${user.username}]`, cardCaretRef.current)
            );
            setCardOpen(false);
          }}
        />
      )}
    </div>
  );
}
