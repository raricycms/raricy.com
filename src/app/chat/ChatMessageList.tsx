'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageList.tsx — 消息列表的内容（日期线 / 连续消息合并 / 折叠条 / 空态）
//
// 【为什么单独成组件 + memo】输入框的正文是 ChatApp 的 state：每敲一个字、每往输入框
// 插一个表情，ChatApp 都重渲染一次，而这段 JSX 里的 `messages.map(...)` 会**重建最多
// DOM_CAP（300）个元素与 props 对象**。ChatMessageItem 自己虽然是 memo，但那挡的是
// 「子组件重渲染」，挡不住这层重建 —— 元素、props 对象、以及随之而来的垃圾回收都要付，
// 而且开销**与列表长度成正比**：
//
//   2026-09 实测（Chromium + CDP 把 CPU 降到 4×/8× ≈ 低端机，讨论大区，DOM 240 条）：
//     敲一个字     列表 50 条 104ms → 240 条 214ms
//     插一个表情   列表 50 条 233ms → 240 条 300ms
//   trace 归因：`EventDispatch`（React 在事件里同步渲染）与列表长度同步增长，中间还夹着
//   一次 `MajorGC`。站长报的「大区里发表情特别卡」就是这一条 —— 私聊短、大区长。
//
// 包上 memo 之后，输入框状态的变化不再碰这棵子树：打字 / 插表情的开销与**列表长度脱钩**
// （剩下的只有输入框自己变高带来的样式重算与排版，那是浏览器侧的活，这层拿不掉）。
//
// ★ 加新 prop 时的纪律 ★
// 这个 memo 是**按引用**比的，任何「每次渲染都新建」的值都会让它永远不命中 ——
// 于是静默退回重构前的行为：不报错、只是又变慢。所以：
//   · 回调一律 useCallback，数组 / 对象一律 useMemo；
//   · 能传原始值就传原始值 —— 空态文案、`isDirect` 这种在调用方算好再传，别把
//     `activeChannel` 整个对象塞进来（它在切频道 / 对账时会换引用）。
//
// 【它不管什么】折叠量、加载更早的游标、滚动、已读回执的判定依据都由 ChatApp 持有，
// 这里只按传进来的值画 —— `<div className="chat-list">`（listRef / onScroll）也留在
// 调用方，本组件只渲染它**里面**的内容。
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, memo } from 'react';
import type { ChatMessageDTO } from '@/lib/chat-shared';
import ChatMessageItem, { dayKey, fmtDay } from './ChatMessageItem';

export interface ChatMessageListProps {
  /** 要渲染的那一段（头部已折叠）。**必须是 useMemo 的稳定引用**。 */
  messages: ChatMessageDTO[];
  /** 与 messages **等长**的连续消息标记（markGroupedMessages 的产物），同样要稳定引用。 */
  groupedFlags: boolean[];
  /** 头部折叠了多少条（> 0 时把「加载更早」换成「展开更早」）。 */
  folded: number;
  hasMore: boolean;
  loadingOlder: boolean;
  /** 进频道时的已读锚点（0 = 没有），用来插「以下是新消息」分隔线。 */
  unreadAnchor: number;
  newCount: number;
  /** 被跳转命中高亮的那条（见 ChatApp 的 jumpToMessage）。 */
  highlightId: number | null;
  /** 我发的最后一条 —— 只有它画送达状态。 */
  lastMineId: number | null;
  /** 私聊：对方读到哪了。 */
  peerLastRead: number;
  currentUserId: string;
  /** 当前用户用户名：正文里 @到自己时整条高亮（ChatMessageItem 判定）。 */
  currentUsername: string;
  isAdmin: boolean;
  /** 私聊才画送达状态；大区不画（那里没有「对方读到哪」这个概念）。 */
  isDirect: boolean;
  /** 一条消息都没有时的空态文案（大区与私聊刻意不同）。 */
  emptyText: string;
  /** 「已折叠 N 条 · 展开更早」——放回一页由 ChatApp 定（REVEAL_STEP 住那边）。 */
  onRevealOlder: () => void;
  onLoadOlder: () => void;
  onReply: (m: ChatMessageDTO) => void;
  onDelete: (m: ChatMessageDTO) => void;
  onAvatarClick: (m: ChatMessageDTO, el: HTMLButtonElement) => void;
  /** 点回复摘要 → 跳到被引用的原消息。 */
  onJumpToReply: (messageId: number) => void;
  /** 点正文里的图床引用图 → 原位放大。 */
  onImageClick: (url: string) => void;
}

function ChatMessageListInner({
  messages,
  groupedFlags,
  folded,
  hasMore,
  loadingOlder,
  unreadAnchor,
  newCount,
  highlightId,
  lastMineId,
  peerLastRead,
  currentUserId,
  currentUsername,
  isAdmin,
  isDirect,
  emptyText,
  onRevealOlder,
  onLoadOlder,
  onReply,
  onDelete,
  onAvatarClick,
  onJumpToReply,
  onImageClick,
}: ChatMessageListProps) {
  return (
    <>
      {/* DOM 上限：超过 CAP 条时从顶部折叠（消息仍在内存里），
          顶部按钮点一下往下放一页 —— 避免长会话把上万个节点堆在 DOM 里 */}
      {folded > 0 ? (
        <button type="button" className="chat-list__older" onClick={onRevealOlder}>
          已折叠 {folded} 条 · 展开更早
        </button>
      ) : (
        hasMore &&
        messages.length > 0 && (
          <button type="button" className="chat-list__older" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? '加载中…' : '加载更早的消息'}
          </button>
        )
      )}
      {messages.length === 0 && <div className="chat-list__empty">{emptyText}</div>}
      {messages.map((m, i, arr) => {
        const prev = i > 0 ? arr[i - 1] : null;
        const showDate = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
        // 同人连续消息：省略时间 / 用户名 / 头像，只在「这一串的第一条」上画。
        // 判据（5 分钟窗口锚在串首、拍一拍与跨日打断）见 markGroupedMessages。
        const grouped = groupedFlags[i];
        // 「以下是新消息」分隔线：进频道时的已读位置之后的第一条
        const showNewSep =
          newCount > 0 && unreadAnchor > 0 && m.id > unreadAnchor && (!prev || prev.id <= unreadAnchor);
        return (
          <Fragment key={m.id}>
            {showDate && (
              <div className="chat-date-sep">
                <span>{fmtDay(m.created_at)}</span>
              </div>
            )}
            {showNewSep && <div className="chat-list__new-sep">以下是新消息</div>}
            <ChatMessageItem
              msg={m}
              isMine={m.author.id === currentUserId}
              canDelete={m.author.id === currentUserId || isAdmin}
              currentUserId={currentUserId}
              currentUsername={currentUsername}
              highlighted={highlightId === m.id}
              grouped={grouped}
              receipt={m.id === lastMineId && isDirect ? (peerLastRead >= m.id ? 'read' : 'unread') : null}
              onReply={onReply}
              onDelete={onDelete}
              onAvatarClick={onAvatarClick}
              onJumpToReply={onJumpToReply}
              onImageClick={onImageClick}
            />
          </Fragment>
        );
      })}
    </>
  );
}

const ChatMessageList = memo(ChatMessageListInner);
export default ChatMessageList;
