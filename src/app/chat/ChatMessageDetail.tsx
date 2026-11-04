'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageDetail.tsx — 单击消息正文打开的「消息详情 + 操作」面板。
//
// 【为什么需要它】移动端为了「长按开操作面板」把消息正文的原生选字关掉了
// （见 _chat.scss 的触屏区块），选字 / 复制就得另给一个可操作的面；桌面左键
// 单击正文也落到这里 —— 两端的入口不同，落到同一个可选中、可复制、可操作的面。
//
// 【和右键 / 长按菜单的分工】两者共用同一套权限判定，入口不同：
//   · 菜单 = 快速操作（右键 / 长按，按落点弹出，动作后立即关闭）；
//   · 详情 = 阅读 + 操作（正文可原生选字，底部是同一套权限的动作按钮）。
// 详情里「回复 / 删除」先关面板再执行（回复要把焦点交给输入区、删除会弹
// confirm / prompt，面板留着只会挡在后面）；「保存 / 复制」不关 —— 保存按钮
// 要能立刻从「保存」翻成「已保存」，复制后用户通常还想继续看这条消息。
//
// 【为什么正文用 ChatMarkdown 而不是纯文本】消息本来是什么样，详情里就该是什么样；
// 纯文本会把 `**粗体**`、表情 token、名片原样摊开。详情层在 `.chat-msg` 之外，
// 不受消息列表那条 `user-select: none` 影响，原生选字与复制照常可用。
//
// 【定位与动效】走站内统一弹窗外壳（.modal-overlay / .modal-dialog / .modal-content），
// 与发起私聊、搜索消息同一套；点遮罩 / Esc / 关闭按钮都能关。入场动画对齐个人主页
// 的 .bento-modal：遮罩淡入 + 面板轻抬，节奏与减少动态效果见 _chat.scss 的 chat-detail。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Bookmark, BookmarkCheck, Copy, Reply, Trash2 } from 'lucide-react';
import Avatar from '@/app/components/Avatar';
import type { ChatMessageDTO } from '@/lib/chat-shared';
import ChatMarkdown from './ChatMarkdown';

/**
 * 'YYYY-MM-DD HH:mm'（UTC+8 钟面）。
 *
 * 与 fmtTime 同一个来源：库里时间戳是「UTC+8 墙上时间，贴 Z 标签」
 * （见 src/lib/db-time.ts），所以一律用 getUTC* 读，不能用本地 getter 再平移一次。
 * 详情要给出完整日期 —— 列表里的 'MM-DD HH:mm' 跨年时看不出是哪一年。
 */
function fmtFullTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}`;
}

export default function ChatMessageDetail({
  msg,
  saved,
  canSave,
  canReply,
  canCopy,
  canDelete,
  onToggleSave,
  onReply,
  onCopy,
  onDelete,
  onClose,
}: {
  /** 当前查看的这条消息。 */
  msg: ChatMessageDTO;
  /** 我在保存箱里存过这条（保存按钮显示「已保存」，点一下是取消）。 */
  saved: boolean;
  /** 只有私聊、未删除、非拍一拍的消息能进保存箱（大区消息不进）。 */
  canSave: boolean;
  canReply: boolean;
  /** 有正文且未删除 / 非拍一拍：复制走正文原文（不是渲染后的富文本）。 */
  canCopy: boolean;
  canDelete: boolean;
  onToggleSave: (m: ChatMessageDTO) => void;
  onReply: (m: ChatMessageDTO) => void;
  onCopy: (m: ChatMessageDTO) => void;
  onDelete: (m: ChatMessageDTO) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // 打开即把焦点收进弹窗：键盘用户不会留在背后的消息列表里。
  // 刻意聚焦**对话框本身**而不是关闭按钮 —— 脚本在指针操作后设的焦点会被浏览器
  // 判成 :focus-visible，一打开就有一圈蓝色 outline 扣在 × 上，看着像已经选中它；
  // 焦点在容器上时视觉干净，Tab 一步仍到关闭按钮。
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
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

  /** 先收起、再执行：回复要把焦点交给输入区，删除会弹 confirm / prompt。 */
  const runAndClose = (fn: (m: ChatMessageDTO) => void) => () => {
    onClose();
    fn(msg);
  };

  const time = fmtFullTime(msg.created_at);

  return createPortal(
    <div className="modal-overlay show chat-detail-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-dialog chat-detail"
        role="dialog"
        aria-modal="true"
        aria-label="消息详情"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-content chat-detail__card">
          <div className="chat-detail__bar">
            <h3 className="chat-detail__title">消息详情</h3>
            <button
              type="button"
              className="chat-modal-close"
              onClick={onClose}
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          <div className="chat-detail__identity">
            <Avatar
              userId={msg.author.id}
              src={msg.author.avatar_url}
              frameUrl={msg.author.frame_url}
              alt={msg.author.username}
              className="chat-detail__avatar"
              loading="lazy"
            />
            <div className="chat-detail__who">
              <div className="chat-detail__name-row">
                <Link className="chat-detail__name" href={`/u/${msg.author.id}`}>
                  {msg.author.username}
                </Link>
                {msg.author.is_admin && <span className="chat-detail__badge">管理员</span>}
              </div>
              <span className="chat-detail__time numeric">{time || '—'}</span>
            </div>
          </div>

          <div className="chat-detail__body">
            {msg.reply && (
              <div className="chat-detail__quote">
                <span className="chat-detail__quote-name">
                  {msg.reply.author_name ?? '未知用户'}：
                </span>
                {msg.reply.content ? (
                  <span className="chat-detail__quote-text">{msg.reply.content}</span>
                ) : null}
                {msg.reply.image_url ? (
                  <img
                    className="chat-detail__quote-thumb"
                    src={msg.reply.image_url}
                    alt="引用的图片"
                    loading="lazy"
                  />
                ) : null}
              </div>
            )}

            <ChatMarkdown content={msg.content} />

            {/* 「详细信息」：把列表里看不全的事实摊开（完整日期 / 消息编号 /
                回复对象 / 保存状态）。只放用户能据此做判断的条目，不堆内部字段。 */}
            <dl className="chat-detail__facts" aria-label="消息详细信息">
              <div className="chat-detail__fact">
                <dt>发送时间</dt>
                <dd className="numeric">{time || '—'}</dd>
              </div>
              <div className="chat-detail__fact">
                <dt>消息编号</dt>
                <dd className="numeric">#{msg.id}</dd>
              </div>
              {msg.reply && (
                <div className="chat-detail__fact">
                  <dt>回复对象</dt>
                  <dd>{msg.reply.author_name ?? '未知用户'}</dd>
                </div>
              )}
              {canSave && (
                <div className="chat-detail__fact">
                  <dt>保存箱</dt>
                  <dd>{saved ? '已保存' : '未保存'}</dd>
                </div>
              )}
            </dl>
          </div>

          {(canReply || canCopy || canSave || canDelete) && (
            <div className="chat-detail__actions">
              {canReply && (
                <button
                  type="button"
                  className="chat-detail__btn chat-detail__btn--primary"
                  onClick={runAndClose(onReply)}
                >
                  <Reply aria-hidden="true" />
                  回复
                </button>
              )}
              {canCopy && (
                <button type="button" className="chat-detail__btn" onClick={() => onCopy(msg)}>
                  <Copy aria-hidden="true" />
                  复制
                </button>
              )}
              {canSave && (
                <button
                  type="button"
                  className={`chat-detail__btn${saved ? ' is-active' : ''}`}
                  aria-pressed={saved}
                  onClick={() => onToggleSave(msg)}
                  title={
                    saved
                      ? '从保存箱里移除（消息本身不会被删除）'
                      : '保存到保存箱（只有自己看得到）'
                  }
                >
                  {saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
                  {saved ? '已保存' : '保存'}
                </button>
              )}
              <span className="chat-detail__actions-gap" />
              {canDelete && (
                <button
                  type="button"
                  className="chat-detail__btn chat-detail__btn--danger"
                  onClick={runAndClose(onDelete)}
                >
                  <Trash2 aria-hidden="true" />
                  删除
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
