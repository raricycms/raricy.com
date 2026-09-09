'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageItem.tsx — 单条消息气泡（拍一拍系统行 / 正文 / 图片 / 博客卡 / 回复）
//
// 【为什么单独成文件 + React.memo】消息列表是全页最重的渲染子树：输入框每敲一个
// 字都会 setText → ChatApp 重渲染 → 整棵列表重渲染。包上 memo 后，只要 props 引用
// 不变就跳过（父组件里所有回调都必须是 useCallback 的稳定引用，见 ChatApp）。
//
// 【正文渲染】走 ChatMarkdown（Markdown → 净化 HTML）；回复摘要 / 侧栏预览等
// 只露一行的位置仍按纯文本处理，不进 Markdown 管线。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpenText } from 'lucide-react';
import { CHAT_DELETED_TEXT, type ChatMessageDTO } from '@/lib/chat-shared';
import { nowForDb } from '@/lib/db-time';
import ChatMarkdown from './ChatMarkdown';

// ── 时间显示：一律 UTC+8 钟面 ─────────────────────────────────────────────────
// 库里时间戳是「UTC+8 墙上时间，贴 Z 标签」（见 src/lib/db-time.ts）—— 也就是说
// toISOString 里那串数字**本身就是 UTC+8 的钟面**。因此一律用 getUTC* 读；用
// getHours() 这类本地 getter 会被浏览器时区再平移一次（UTC 下整体差 8 小时）。
// 「今天 / 昨天」的参照点同理，取 nowForDb()（UTC+8 的现在）。

/** 'MM-DD HH:mm'（UTC+8）。 */
export function fmtTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** UTC+8 日历日键（用于日期分隔线的分组比较）。 */
function dayKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/** 同一天的消息归为一组（日期分隔线用）。 */
export function dayKey(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return dayKeyOf(d);
}

/** 日期分隔线文案：今天 / 昨天 / M月D日 / YYYY年M月D日。 */
export function fmtDay(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = nowForDb(); // UTC+8 的「现在」，否则跨零点前后会把今天判成昨天
  const key = dayKeyOf(d);
  if (key === dayKeyOf(now)) return '今天';
  if (key === dayKeyOf(new Date(now.getTime() - 86_400_000))) return '昨天';
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
    : `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/**
 * 消息是否 @ 了某人：出现 `@username` 且其后紧跟空白或行尾。
 * 收尾的空白既是「@ta」插入时的固定格式（自动补一个空格），也是边界 ——
 * 否则 @bob 会把 @bobby 也当成提到自己。
 */
export function isMentioned(content: string, username: string): boolean {
  if (!username) return false;
  const needle = `@${username}`;
  for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + 1)) {
    const after = content[i + needle.length];
    if (after === undefined || /\s/.test(after)) return true;
  }
  return false;
}

export interface ChatMessageItemProps {
  msg: ChatMessageDTO;
  isMine: boolean;
  canDelete: boolean;
  currentUserId: string;
  /** 当前用户用户名：正文里 @到自己时高亮整条消息 */
  currentUsername: string;
  /** 被锚点/搜索跳转命中 → 短暂高亮（见 ChatApp 的 jumpToMessage） */
  highlighted?: boolean;
  /** 与上一条同人、5 分钟内、且不带引用 → 省略头像与名字（连续消息合并） */
  grouped?: boolean;
  /** 私聊里「我发出的最后一条」的送达状态（对方读游标决定）；其他消息不传 */
  receipt?: 'read' | 'unread' | null;
  onReply: (m: ChatMessageDTO) => void;
  onDelete: (m: ChatMessageDTO) => void;
  onAvatarClick: (m: ChatMessageDTO, el: HTMLButtonElement) => void;
  /** 点击回复摘要 → 跳到被引用的原消息 */
  onJumpToReply: (messageId: number) => void;
  /** 点击图片 → 原位放大（覆盖层），不新开窗口 */
  onImageClick: (url: string) => void;
}

function ChatMessageItemInner({
  msg,
  isMine,
  canDelete,
  currentUserId,
  currentUsername,
  highlighted = false,
  grouped = false,
  receipt = null,
  onReply,
  onDelete,
  onAvatarClick,
  onJumpToReply,
  onImageClick,
}: ChatMessageItemProps) {
  const [imgError, setImgError] = useState(false);

  // 拍一拍：无头像无气泡的居中系统行（微信/QQ 式）；本人被拍时用品牌色强调。
  // 已删除的拍一拍保持居中，只把文案换成删除占位。
  if (msg.pat) {
    const pattedMe = msg.pat.target_id === currentUserId;
    return (
      <div className={`chat-pat${pattedMe ? ' chat-pat--me' : ''}`}>
        <span className="chat-pat__text">
          {msg.is_deleted
            ? CHAT_DELETED_TEXT
            : `${msg.author.username} 拍了拍 ${msg.pat.target_name}`}
        </span>
        {canDelete && !msg.is_deleted && (
          <button
            type="button"
            className="chat-msg__btn chat-msg__btn--danger chat-pat__btn"
            onClick={() => onDelete(msg)}
          >
            删除
          </button>
        )}
      </div>
    );
  }

  // 正文里 @到自己 → 整条消息高亮（插入时格式为「@名字 」，见 isMentioned）
  const mentioned = isMentioned(msg.content, currentUsername);

  // 纯图片 / 纯博客引用消息没有正文 → 不画空气泡；已删消息仍显示占位泡
  const contentBlock = msg.content || msg.is_deleted ? (
    <div className={`chat-msg__content${mentioned ? ' chat-msg__content--mention' : ''}`}>
      {msg.is_deleted ? (
        <span className="chat-msg__deleted">{msg.content}</span>
      ) : (
        <ChatMarkdown content={msg.content} />
      )}
    </div>
  ) : null;

  // 附件一律以 !msg.is_deleted 为门（服务端已对软删消息抹掉附件，这里是第二道）：
  // 否则「删掉的图」在刷新后仍会渲染出来。
  const imageBlock =
    !msg.is_deleted && (msg.image || msg.image_missing) ? (
      <>
        {msg.image && !imgError && (
          <img
            className="chat-msg__image"
            src={msg.image.url}
            alt="聊天图片"
            loading="lazy"
            onClick={() => onImageClick(msg.image!.url)}
            onError={() => setImgError(true)}
          />
        )}
        {msg.image_missing && <div className="chat-msg__image-missing">[图片已删除]</div>}
      </>
    ) : null;

  const replyBlock =
    !msg.is_deleted && msg.reply ? (
      <button
        type="button"
        className="chat-msg__reply"
        onClick={() => onJumpToReply(msg.reply!.id)}
        title="跳到这条消息"
      >
        <span className="chat-msg__reply-name">{msg.reply.author_name ?? ''}：</span>
        <span className="chat-msg__reply-text">{msg.reply.content}</span>
      </button>
    ) : null;

  // 博客引用链接卡（整卡可点 → 博客详情页）；博客已删时走占位，不给链接
  const blogBlock = !msg.is_deleted && msg.blog ? (
    <a className="chat-msg__blog" href={`/blog/${msg.blog.id}`}>
      <span className="chat-msg__blog-icon" aria-hidden="true">
        <BookOpenText />
      </span>
      <span className="chat-msg__blog-main">
        <span className="chat-msg__blog-title">{msg.blog.title}</span>
        {msg.blog.description ? (
          <span className="chat-msg__blog-desc">{msg.blog.description}</span>
        ) : null}
        {msg.blog.author ? (
          <span className="chat-msg__blog-author">@{msg.blog.author}</span>
        ) : null}
      </span>
      <ArrowRight className="chat-msg__blog-arrow" aria-hidden="true" />
    </a>
  ) : msg.blog_missing ? (
    <div className="chat-msg__blog-missing">[博客已删除]</div>
  ) : null;

  return (
    <div
      className={`chat-msg${isMine ? ' chat-msg--mine' : ''}${grouped ? ' chat-msg--grouped' : ''}${highlighted ? ' chat-msg--highlight' : ''}`}
      data-message-id={msg.id}
    >
      {/* 头像不再是直链：点开选项框（拍一拍 / 访问个人主页 / @ta / 取消） */}
      <button
        type="button"
        className="chat-msg__avatar"
        onClick={(e) => onAvatarClick(msg, e.currentTarget)}
        title="拍一拍 / 主页 / @ta"
        aria-label={`${msg.author.username} 的操作菜单`}
      >
        <img src={msg.author.avatar_url} alt={msg.author.username} loading="lazy" />
      </button>
      <div className="chat-msg__body">
        <div className="chat-msg__meta">
          <Link className="chat-msg__name" href={`/u/${msg.author.id}`}>
            {msg.author.username}
          </Link>
          <span className="chat-msg__time">{fmtTime(msg.created_at)}</span>
          {isMine && receipt && (
            <span className={`chat-msg__receipt${receipt === 'read' ? ' is-read' : ''}`}>
              {receipt === 'read' ? '已读' : '未读'}
            </span>
          )}
          <span className="chat-msg__actions">
            {!msg.is_deleted && (
              <button type="button" className="chat-msg__btn" onClick={() => onReply(msg)}>
                回复
              </button>
            )}
            {canDelete && (
              <button type="button" className="chat-msg__btn chat-msg__btn--danger" onClick={() => onDelete(msg)}>
                删除
              </button>
            )}
          </span>
        </div>

        {/* 自己的消息：正文（含图）置顶，回复摘要 / 博客引用卡随后；
            他人消息：保持回复摘要在上、正文在下，博客卡在图片后 */}
        {isMine ? (
          <>
            {contentBlock}
            {imageBlock}
            {replyBlock}
            {blogBlock}
          </>
        ) : (
          <>
            {replyBlock}
            {contentBlock}
            {imageBlock}
            {blogBlock}
          </>
        )}
      </div>
    </div>
  );
}

const ChatMessageItem = memo(ChatMessageItemInner);
export default ChatMessageItem;
