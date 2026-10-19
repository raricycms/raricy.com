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
//
// 【消息上没有常驻按钮】保存 / 回复 / 删除住在一个右键 / 长按唤出的菜单里（由 ChatApp
// 持有 ChatMessageMenu，本文件只负责把「右键 / 长按」翻译成一次 onOpenMenu）。原来的
// hover 工具条已删：它在触屏上只能靠「点一下 → 粘住 hover」这种偶然行为打开，还会
// 把按钮摆进表头行、挤占气泡外侧的宽度。手势识别见 useMessageMenuTrigger。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Avatar from '@/app/components/Avatar';
import ChatBubble from '@/app/components/ChatBubble';
import { ArrowRight, BookOpenText } from 'lucide-react';
import { CHAT_DELETED_TEXT, type ChatMessageDTO } from '@/lib/chat-shared';
import { nowForDb } from '@/lib/db-time';
import ChatMarkdown from './ChatMarkdown';
import type { MessageMenuAnchor } from './ChatMessageMenu';

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

// ── 连续消息合并 ─────────────────────────────────────────────────────────────
// 同一个人连着发言时，只有**这一串的第一条**画表头（时间 / 用户名 / 头像），
// 后续几条省略 —— 屏幕上因此是一簇气泡配一个时间戳，而不是每条都顶一行。

/**
 * 合并时间窗，**从这一串的第一条起算**（不是与上一条逐条比较）。
 *
 * 逐条比较在「每 4 分钟发一条」时会无限并下去，一串能横跨几个小时；锚在串首则
 * 一串总长不超过这个窗口，超了就断开重开一串（表头在断开的那条上重新出现）。
 */
export const CHAT_GROUP_WINDOW_MS = 5 * 60_000;

/** 时间戳 → 毫秒；缺失 / 不可解析返回 NaN（读不出间隔就不合并）。 */
function timeOf(ts: string | null): number {
  if (!ts) return Number.NaN;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? Number.NaN : t;
}

/**
 * 标出哪些消息要省略表头 —— 返回与入参**等长**的布尔数组，按索引对齐。
 * `true` = 这条是同一人连续发言的后继，不显示时间、用户名与头像；
 * `false` = 串首（或打断了上一串的那条），表头照常显示。
 *
 * 【判据】作者与当前这一串相同，且距**这一串的第一条**不超过 CHAT_GROUP_WINDOW_MS
 * （含端点）。跨自然日也算断开 —— 日期分隔线本来就插在两者之间，表头必须跟着出现。
 *
 * 【拍一拍两侧都不并进来】它是居中的系统行，视觉上打断了气泡簇：它自己不做后继，
 * 也**不做串首** —— 它后面那条照常显示表头，再从那条起算新的一串。
 *
 * 【为什么不在渲染时只看相邻两条】窗口锚在串首而非上一条，判据必须沿列表顺序累积
 * 状态，单看相邻两条算不出来（理由见 CHAT_GROUP_WINDOW_MS 上方）。
 */
export function markGroupedMessages(messages: ChatMessageDTO[]): boolean[] {
  const grouped: boolean[] = [];
  /** 当前这一串是谁、从哪一刻起算；null / NaN = 没有可承接的串（换人、拍一拍打断） */
  let runAuthor: string | null = null;
  let runStart = Number.NaN;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;
    const ts = timeOf(m.created_at);
    const gap = ts - runStart; // NaN 落进下面的比较里自然为 false

    const merged =
      !m.pat &&
      (!prev || dayKey(prev.created_at) === dayKey(m.created_at)) &&
      runAuthor === m.author.id &&
      gap >= 0 &&
      gap <= CHAT_GROUP_WINDOW_MS;

    grouped.push(merged);
    if (!merged) {
      runAuthor = m.pat ? null : m.author.id;
      runStart = m.pat ? Number.NaN : ts;
    }
  }
  return grouped;
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

// ── 右键 / 长按 → 操作菜单 ───────────────────────────────────────────────────
//
// 触屏没有 hover，鼠标右键是浏览器自己的菜单 —— 两者都要变成「消息操作菜单」：
//   · 鼠标：只认 contextmenu（右键 / 键盘菜单键 / Shift+F10）。**不做鼠标长按**，
//     按住左键 500ms 弹菜单不是桌面上的习惯，而且会和拖选文字打架。
//   · 触屏：自己做长按计时（iOS 不派发 contextmenu）。手指移动超过阈值即视为
//     在滚动列表 → 取消；定时器触发后吞掉随后的 click，免得顺带点开图片 / 链接。
//   · Android：长按会**同时**触发原生 contextmenu 与我们的计时器，用
//     touchOpenedAtRef 去重，两次只开一个菜单。
//
// ⚠️ 为什么不做 `preventDefault()` on touchstart：那会连列表滚动一起禁掉。iOS 长按
// 选中文字 / 链接 callout 只能靠计时器触发后收掉选区 + 样式表的
// `-webkit-touch-callout: none` 来压，压不干净也只是「多出一片选区」，菜单照常开。

/** 长按判定时长（毫秒）。与 Android 原生 contextmenu 的触发时间大致同档。 */
export const MESSAGE_LONG_PRESS_MS = 500;
/** 手指移动超过这个距离（px）就视为滑动列表，取消长按。 */
const LONG_PRESS_MOVE_TOLERANCE = 8;

/**
 * 给消息行挂上「右键 / 长按 → 打开操作菜单」的手势。
 *
 * @param canMenu 这条消息有没有可做的动作。没有就别拦浏览器原生菜单 —— 右键
 *   至少还能复制文字（如别人发的已删消息）。
 * @returns 直接 spread 到消息行根节点的 props。
 */
function useMessageMenuTrigger(
  msg: ChatMessageDTO,
  canMenu: boolean,
  onOpenMenu: (m: ChatMessageDTO, anchor: MessageMenuAnchor) => void
) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  /** 长按刚开过菜单 → 吞掉随后那一次 click（否则会顺带放大图片 / 跟进链接）。 */
  const suppressClickRef = useRef(false);
  /** 触摸长按已经开过菜单的时刻：Android 随后还会补一个 contextmenu，别开第二次。 */
  const touchOpenedAtRef = useRef(0);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  // 卸载时清掉挂着的定时器（列表滚动会不断挂载 / 卸载消息行）
  useEffect(() => cancel, [cancel]);

  const open = useCallback(
    (x: number, y: number) => onOpenMenu(msg, { x, y }),
    [msg, onOpenMenu]
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canMenu) return;
      e.preventDefault();
      // Android 长按：上面的计时器先开了菜单，紧跟着原生 contextmenu 又来一次
      if (Date.now() - touchOpenedAtRef.current < 1000) return;
      cancel();
      const rect = e.currentTarget.getBoundingClientRect();
      // 键盘菜单键 / Shift+F10 没有指针坐标（clientX/Y 都是 0）→ 贴着消息左上角开
      const byPointer = e.clientX !== 0 || e.clientY !== 0;
      open(byPointer ? e.clientX : rect.left + 12, byPointer ? e.clientY : rect.top + 12);
    },
    [canMenu, cancel, open]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 新手势开始：上一次长按的「吞 click」状态作废（长按后未必真会派发 click）
      suppressClickRef.current = false;
      if (!canMenu || e.pointerType === 'mouse' || e.button !== 0) return;
      // 万一上一下还没结束（多点触控 / 异常序列），别让旧计时器留着
      cancel();
      startRef.current = { x: e.clientX, y: e.clientY };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const start = startRef.current;
        startRef.current = null;
        if (!start) return;
        suppressClickRef.current = true;
        touchOpenedAtRef.current = Date.now();
        // iOS 长按会顺手开始选文字 / 弹 callout —— 菜单接管，把选区收掉。
        // （链接的 callout 另由 `-webkit-touch-callout: none` 压，见 _chat.scss）
        window.getSelection()?.removeAllRanges();
        open(start.x, start.y);
      }, MESSAGE_LONG_PRESS_MS);
    },
    [canMenu, cancel, open]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = startRef.current;
      if (!start) return;
      if (
        Math.abs(e.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(e.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
      ) {
        cancel();
      }
    },
    [cancel]
  );

  const onPointerEnd = useCallback(() => cancel(), [cancel]);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onPointerLeave: onPointerEnd,
    onClickCapture,
  };
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
  /**
   * 同一人连续发言的后继（距这一串的第一条 ≤ CHAT_GROUP_WINDOW_MS）
   * → 省略时间 / 用户名 / 头像。判据见 markGroupedMessages，别在调用点另算一套。
   */
  grouped?: boolean;
  /** 私聊里「我发出的最后一条」的送达状态（对方读游标决定）；其他消息不传 */
  receipt?: 'read' | 'unread' | null;
  /** 只有私聊里未删除的消息可保存（大区消息不进保存箱；拍一拍也不进）。 */
  canSave?: boolean;
  /** 右键 / 长按唤出操作菜单：锚点是视口坐标（菜单自己负责摆位） */
  onOpenMenu: (m: ChatMessageDTO, anchor: MessageMenuAnchor) => void;
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
  canSave = false,
  onOpenMenu,
  onAvatarClick,
  onJumpToReply,
  onImageClick,
}: ChatMessageItemProps) {
  const [imgError, setImgError] = useState(false);

  // 菜单里有没有可做的动作：没有就放行浏览器原生右键菜单（至少还能复制文字）
  const canMenu = canSave || canDelete || (!msg.is_deleted && !msg.pat);
  const menuTrigger = useMessageMenuTrigger(msg, canMenu, onOpenMenu);

  // 拍一拍：无头像无气泡的居中系统行（微信/QQ 式）；本人被拍时用品牌色强调。
  // 已删除的拍一拍保持居中，只把文案换成删除占位。
  // 它的「删除」也走同一个右键 / 长按菜单（原先是一条 hover 才出现的按钮）。
  if (msg.pat) {
    const pattedMe = msg.pat.target_id === currentUserId;
    return (
      <div className={`chat-pat${pattedMe ? ' chat-pat--me' : ''}`} {...menuTrigger}>
        <span className="chat-pat__text">
          {msg.is_deleted
            ? CHAT_DELETED_TEXT
            : `${msg.author.username} 拍了拍 ${msg.pat.target_name}`}
        </span>
      </div>
    );
  }

  // 正文里 @到自己 → 整条消息高亮（插入时格式为「@名字 」，见 isMentioned）
  const mentioned = isMentioned(msg.content, currentUsername);

  // 纯图片 / 纯博客引用消息没有正文 → 不画空气泡；已删消息仍显示占位泡
  const contentBlock = msg.content || msg.is_deleted ? (
    <ChatBubble bubbleKey={msg.is_deleted ? null : msg.author.bubble_key} mentioned={!msg.is_deleted && mentioned}>
      {msg.is_deleted ? (
        <span className="chat-msg__deleted">{msg.content}</span>
      ) : (
        <ChatMarkdown
          content={msg.content}
          allowBareImage={!msg.image && !msg.image_missing && !msg.blog && !msg.blog_missing}
        />
      )}
    </ChatBubble>
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
            alt="讨论图片"
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
        {/* 被引用的是纯图片消息时正文为空 → 用缩略图代替文字（图已删/缺失时服务端
            在 content 里给了占位文案，这里自然回落到文字分支） */}
        {msg.reply.content ? (
          <span className="chat-msg__reply-text">{msg.reply.content}</span>
        ) : null}
        {msg.reply.image_url ? (
          <img
            className="chat-msg__reply-thumb"
            src={msg.reply.image_url}
            alt="引用的图片"
            loading="lazy"
          />
        ) : null}
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

  // 表头行：作者名 / 时间 / 已读回执。
  // grouped（同人连续发言的后继）上，整行由 _chat.scss 接管成绝对定位的浮层。
  // 操作按钮不在这一行 —— 保存 / 回复 / 删除在右键 / 长按菜单里。
  const metaRow = (
    <div className="chat-msg__meta">
      <Link className="chat-msg__name" href={`/u/${msg.author.id}`}>
        {msg.author.username}
      </Link>
      <span className="chat-msg__time numeric">{fmtTime(msg.created_at)}</span>
      {isMine && receipt && (
        <span className={`chat-msg__receipt${receipt === 'read' ? ' is-read' : ''}`}>
          {receipt === 'read' ? '已读' : '未读'}
        </span>
      )}
    </div>
  );

  // 「自己的块」= 气泡 / 图 / 博客卡，**引用块不在其中**（引用是别人的话）。
  //
  // 【为什么要单独包一层】grouped 的表头行是绝对定位的浮层，贴的是**定位祖先**的边。
  // 不包这一层的话，那个祖先是 .chat-msg__body，而 body 的宽度 = max(引用块, 自己的块)
  // —— 引用比正文长时，回执就跟着引用甩到外面去，看着像对齐了「引用内容和原信息里
  // 更长的那一个」（2026-09 站长报的）。包一层之后浮层永远贴自己的块。
  // **别把这层去掉、也别让浮层挪回 body 上**（CSS 那边有对应的注释）。
  //
  // grouped 时表头行住进这一层 —— 浮层必须真的在它的定位祖先里面，才能贴着它。
  // 非 grouped 时表头行不进（要在 body 开头占一行，而这一层排在引用块
  // **之后**，进去就跑到引用下面去了）。
  const ownBlocks = (
    <div className="chat-msg__own-blocks">
      {grouped && metaRow}
      {contentBlock}
      {imageBlock}
      {blogBlock}
    </div>
  );

  return (
    <div
      className={`chat-msg${isMine ? ' chat-msg--mine' : ''}${grouped ? ' chat-msg--grouped' : ''}${highlighted ? ' chat-msg--highlight' : ''}`}
      data-message-id={msg.id}
      {...menuTrigger}
    >
      {/* 头像不再是直链：点开选项框（拍一拍 / 访问个人主页 / @ta / 取消） */}
      <Avatar
        as="button"
        userId={msg.author.id}
        src={msg.author.avatar_url}
        frameUrl={msg.author.frame_url}
        alt={msg.author.username}
        loading="lazy"
        className="chat-msg__avatar"
        onClick={(e) => onAvatarClick(msg, e.currentTarget)}
        title="拍一拍 / 主页 / @ta"
        ariaLabel={`${msg.author.username} 的操作菜单`}
      />
      <div className="chat-msg__body">
        {/* 表头行只在这一处与 ownBlocks 里的那一处之间二选一（grouped 决定去哪边） */}
        {!grouped && metaRow}

        {/* 回复摘要统一在正文上方；独立于 ownBlocks。 */}
        {replyBlock}
        {ownBlocks}
      </div>
    </div>
  );
}

const ChatMessageItem = memo(ChatMessageItemInner);
export default ChatMessageItem;
