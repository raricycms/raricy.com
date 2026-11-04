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
// 消息操作只有两条入口：桌面右键、触屏长按。没有常驻「⋯」按钮 —— 桌面悬停 /
// 键盘聚焦时给气泡轻微变色作可操作提示，移动端按下时同一套叠色。
// 单击正文（移动端轻点 / 桌面左键）打开消息详情浮层 ——
// 移动端的原生选字因此搬到详情里，列表上的长按留给操作面板。
// 具体判据与事件接线见下面的 useMessageInteractions 与 chat-message-interaction.ts。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Avatar from '@/app/components/Avatar';
import ChatBubble from '@/app/components/ChatBubble';
import { ArrowRight, BookOpenText } from 'lucide-react';
import { CHAT_DELETED_TEXT, type ChatMessageDTO } from '@/lib/chat-shared';
import {
  LONG_PRESS_MS,
  hasTextSelection,
  isInteractiveClickTarget,
  isPointInsideRange,
  isPointInsideSelection,
  isPressExcludedTarget,
  movedBeyondTolerance,
} from '@/lib/chat-message-interaction';
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

// ── 指针交互（按下反馈 / 长按菜单 / 右键菜单 / 单击详情）──────────────────────
//
// 两端共用一套接线，判据在零依赖的 chat-message-interaction.ts：
//   · 触屏：按下给反馈；滑动取消反馈与长按；长按开菜单；长按后的收尾 click 吞掉。
//   · 鼠标：不接管按下反馈；右键开菜单（选区内的右键放行浏览器菜单）；
//     左键单击正文开详情，拖选结束（有选区 / 有位移）不开详情。
//   · 键盘：contextmenu 事件没有指针坐标，直接贴着消息左上角开菜单。
//
// 【为什么抑制标记要在 click 里消费、再用定时器兜底】触屏长按松手后浏览器仍可能补发
// 一个 click（不同浏览器时序不同）。若不在 click 里吞掉它，菜单刚开就会同屏弹出详情。
// 但某些手势根本不会发 click，抑制标记不能永久留着（否则下一次正常单击被吞），
// 所以另有一个短定时器把它复位。
function useMessageInteractions({
  msg,
  canMenu,
  canDetail,
  onOpenMenu,
  onOpenDetail,
}: {
  msg: ChatMessageDTO;
  canMenu: boolean;
  canDetail: boolean;
  onOpenMenu: (m: ChatMessageDTO, anchor: MessageMenuAnchor) => void;
  onOpenDetail: (m: ChatMessageDTO) => void;
}) {
  const [pressed, setPressed] = useState(false);
  const pointerTypeRef = useRef('');
  const pressRef = useRef<{
    startX: number;
    startY: number;
    timer: ReturnType<typeof setTimeout> | null;
    longPress: boolean;
  } | null>(null);
  /** 长按已经开过菜单：松手后的 click 必须吞掉。 */
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 鼠标按下点：用来区分「单击」与「拖选 / 拖动」。 */
  const mouseStartRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * 右键按下瞬间的选区快照。
   *
   * 【为什么要快照】部分浏览器（以及无头环境的合成鼠标）在右键 mousedown 时就会
   * 把选区收起，等 contextmenu 派发时 `getSelection()` 已经空了 —— 直接读实时选区
   * 会判成「不在选区内」，于是刚选好的字右键却弹出我们的菜单。按下时先克隆一份，
   * contextmenu 时拿它判断落点。
   */
  const selectionSnapshotRef = useRef<Range | null>(null);

  const clearSuppressTimer = useCallback(() => {
    if (suppressTimerRef.current) {
      clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, []);

  /** 取消按下态与长按计时（滑动 / 指针取消 / 卸载）。 */
  const cancelPress = useCallback(() => {
    const press = pressRef.current;
    if (press?.timer) clearTimeout(press.timer);
    pressRef.current = null;
    setPressed(false);
  }, []);

  useEffect(
    () => () => {
      const press = pressRef.current;
      if (press?.timer) clearTimeout(press.timer);
      pressRef.current = null;
      clearSuppressTimer();
    },
    [clearSuppressTimer]
  );

  /** 滑动滚动时取消反馈与长按：列表内部滚动不冒泡，用捕获阶段收。 */
  useEffect(() => {
    if (!pressed) return;
    const onScrollOrResize = () => cancelPress();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [pressed, cancelPress]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType;
      const touchLike = e.pointerType === 'touch' || e.pointerType === 'pen';
      if (!touchLike) {
        // 鼠标只记录起点：拖选结束后的 click 靠它识别，不接管按下反馈。
        if (e.pointerType === 'mouse' && e.button === 0) {
          mouseStartRef.current = { x: e.clientX, y: e.clientY };
          selectionSnapshotRef.current = null;
        } else if (e.pointerType === 'mouse' && e.button === 2) {
          // 只覆盖、不清空：拖选结束时已经存过一份；右键按下时实时选区若已被收起，
          // 仍应沿用那份快照。
          const selection = document.getSelection();
          if (hasTextSelection(selection) && selection) {
            selectionSnapshotRef.current = selection.getRangeAt(0).cloneRange();
          }
        }
        return;
      }
      if (e.button !== 0) return;
      // 链接 / 按钮 / 输入框有自己的点击语义，不从这里起长按。
      if (isPressExcludedTarget(e.target)) return;
      clearSuppressTimer();
      suppressClickRef.current = false;
      cancelPress();
      try {
        // 捕获指针：手指移出消息范围后仍能收到 up / cancel，按下态不会粘住。
        // 合成事件或老浏览器没有活动指针时会抛，忽略即可（不影响真实触屏）。
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
      const state = {
        startX: e.clientX,
        startY: e.clientY,
        timer: null as ReturnType<typeof setTimeout> | null,
        longPress: false,
      };
      pressRef.current = state;
      setPressed(true);
      if (!canMenu) return; // 没有可开的菜单，但按下反馈照给
      state.timer = setTimeout(() => {
        const current = pressRef.current;
        if (!current) return;
        current.timer = null;
        current.longPress = true;
        suppressClickRef.current = true;
        setPressed(false);
        onOpenMenu(msg, { x: current.startX, y: current.startY, fromKeyboard: false });
      }, LONG_PRESS_MS);
    },
    [canMenu, clearSuppressTimer, cancelPress, msg, onOpenMenu]
  );

  /** 滑动 / 拖动超过容差 → 这不是长按，是滚动或拖选：立刻取消反馈与计时。 */
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (!press || press.longPress) return;
      if (movedBeyondTolerance(e.clientX - press.startX, e.clientY - press.startY)) {
        cancelPress();
      }
    },
    [cancelPress]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 鼠标拖选结束时把选区存一份：下一手右键即便在 mousedown 就把实时选区收起来，
      // 也还有它的几何范围可判「右键点是不是落在已选文字上」。
      if (e.pointerType === 'mouse' && e.button === 0) {
        const selection = document.getSelection();
        if (hasTextSelection(selection) && selection) {
          selectionSnapshotRef.current = selection.getRangeAt(0).cloneRange();
        }
      }
      const press = pressRef.current;
      if (!press) return;
      if (press.timer) clearTimeout(press.timer);
      const wasLongPress = press.longPress;
      pressRef.current = null;
      setPressed(false);
      if (!wasLongPress) return;
      // 长按已开菜单：松手后的收尾 click 必须吞掉，否则会顺带打开详情。
      suppressClickRef.current = true;
      clearSuppressTimer();
      suppressTimerRef.current = setTimeout(() => {
        suppressClickRef.current = false;
        suppressTimerRef.current = null;
      }, 800);
    },
    [clearSuppressTimer]
  );

  /** 手指被浏览器接管去滚动时派发 pointercancel —— 与滑动同一条路。 */
  const onPointerCancel = useCallback(() => cancelPress(), [cancelPress]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canMenu) return;
      // 键盘菜单键 / Shift+F10 没有指针坐标（clientX/Y 都是 0）→ 贴着消息左上角开
      const byPointer = e.clientX !== 0 || e.clientY !== 0;
      const pointerType =
        (e.nativeEvent as PointerEvent).pointerType ||
        (byPointer ? pointerTypeRef.current : '');
      if (pointerType === 'touch' || pointerType === 'pen') {
        // 长按操作面板由我们接管；不屏蔽的话系统选字菜单会盖住它。
        e.preventDefault();
        return;
      }
      // 在已选文字内右键：把浏览器原生菜单（复制 / 搜索）让回去。
      // 先看右键按下时的选区快照，再退回实时选区 —— 前者能兜住「mousedown 已收起选区」
      // 的浏览器；两者都判不出来就按普通右键处理。
      if (byPointer) {
        const snapshot = selectionSnapshotRef.current;
        selectionSnapshotRef.current = null;
        if (snapshot && isPointInsideRange(document, e.clientX, e.clientY, snapshot)) return;
        if (isPointInsideSelection(document, e.clientX, e.clientY)) return;
      }
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onOpenMenu(msg, {
        x: byPointer ? e.clientX : rect.left + 12,
        y: byPointer ? e.clientY : rect.top + 12,
        // 键盘菜单键（没有指针坐标）打开时才把焦点交给第一项。
        fromKeyboard: !byPointer,
      });
    },
    [canMenu, msg, onOpenMenu]
  );

  /** 左键 / 单击正文 → 详情。拖选收尾、长按收尾、图片与链接都走不到这里。 */
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.chat-msg__content')) return;
      if (isInteractiveClickTarget(target)) return;
      if (target.closest('img')) return; // 图片单击是预览，不是详情
      if (!canDetail) return;
      // 拖选结束的收尾 click：有选区就不打开详情。
      if (hasTextSelection(document.getSelection())) return;
      const start = mouseStartRef.current;
      mouseStartRef.current = null;
      if (start && movedBeyondTolerance(e.clientX - start.x, e.clientY - start.y)) return;
      onOpenDetail(msg);
    },
    [canDetail, msg, onOpenDetail]
  );

  return {
    pressed,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu,
      onClick,
    },
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
  /** 桌面右键 / 触屏长按唤出操作菜单，菜单自己负责摆位。 */
  onOpenMenu: (m: ChatMessageDTO, anchor: MessageMenuAnchor) => void;
  /** 单击正文（移动端轻点 / 桌面左键）打开消息详情浮层。 */
  onOpenDetail: (m: ChatMessageDTO) => void;
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
  onOpenDetail,
  onAvatarClick,
  onJumpToReply,
  onImageClick,
}: ChatMessageItemProps) {
  const [imgError, setImgError] = useState(false);

  // 菜单里有没有可做的动作：没有就放行浏览器原生右键菜单（至少还能复制文字）
  const canMenu = canSave || canDelete || (!msg.is_deleted && !msg.pat);
  // 详情只对「有正文的未删除消息」开放：拍一拍没有正文，删除占位没有可读内容。
  const canDetail = !msg.is_deleted && !msg.pat && msg.content.trim() !== '';
  const { pressed, handlers } = useMessageInteractions({
    msg,
    canMenu,
    canDetail,
    onOpenMenu,
    onOpenDetail,
  });

  // 拍一拍：无头像无气泡的居中系统行（微信/QQ 式）；本人被拍时用品牌色强调。
  // 已删除的拍一拍保持居中，只把文案换成删除占位（不能打开详情）。
  // 它的「删除」通过桌面右键 / 触屏长按菜单打开。
  if (msg.pat) {
    const pattedMe = msg.pat.target_id === currentUserId;
    return (
      <div
        className={`chat-pat${pattedMe ? ' chat-pat--me' : ''}${canMenu ? ' chat-pat--actionable' : ''}${pressed ? ' chat-pat--pressed' : ''}`}
        {...handlers}
      >
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
      className={`chat-msg${isMine ? ' chat-msg--mine' : ''}${grouped ? ' chat-msg--grouped' : ''}${highlighted ? ' chat-msg--highlight' : ''}${canMenu ? ' chat-msg--actionable' : ''}${pressed ? ' chat-msg--pressed' : ''}`}
      data-message-id={msg.id}
      {...handlers}
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
