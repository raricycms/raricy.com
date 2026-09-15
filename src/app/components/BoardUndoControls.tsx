'use client';

// ─────────────────────────────────────────────────────────────────────────────
// BoardUndoControls.tsx — 联机悔棋的按钮与回应条（五款棋共用）
//
// 【两种身份看到的不是同一样东西】
//   • 请求方：一个「悔棋」按钮（自己那条待回应时变成「撤回」，服务端上就是同一个接口）。
//   • 对手：一条「对手请求悔棋（撤 N 步）」+ 同意 / 拒绝。
// 谁是哪一半由 `undoRequest.by` 与我的席位比出来（协议里只有席位，没有 userId）。
//
// 【请求不是"暂停"】发起悔棋**不冻结棋局**：不想等了直接走一手就行，请求随局面作废
// （对手那边的那两条按钮也就跟着消失）。所以这里不 disable 棋盘、也不做倒计时。
//
// 【撤几步由服务端算好放在请求里】客户端不重算 undoPlies —— 那句括注是给对手看的，
// 让他知道自己在同意什么（撤 1 步只悔对方那一步；撤 2 步连自己刚应的那一招也一并作废）。
// ─────────────────────────────────────────────────────────────────────────────

import type { Seat, UndoRequest } from '@/lib/board-shared';

export interface BoardUndoControlsProps {
  /** 对局进行中才显示悔棋控件。 */
  playing: boolean;
  /** 我在这一局里是棋手（观众没有悔棋这回事）。 */
  isPlayer: boolean;
  mySeat: Seat | null;
  undoRequest: UndoRequest | null;
  /** 请求方那一半：可不可以点（含"我发过请求、现在要点撤回"）。 */
  canRequest: boolean;
  onRequest: () => void;
  onRespond: (accept: boolean) => void;
}

export default function BoardUndoControls({
  playing,
  isPlayer,
  mySeat,
  undoRequest,
  canRequest,
  onRequest,
  onRespond,
}: BoardUndoControlsProps) {
  if (!playing || !isPlayer || mySeat === null) return null;

  if (undoRequest) {
    // 我发的那条还挂着：同一个按钮用来撤回（服务端 requestUndo 是 toggle）
    if (undoRequest.by === mySeat) {
      return (
        <>
          <span className="board-hint">已请求悔棋（撤 {undoRequest.plies} 步），等对手回应</span>
          <button type="button" className="board-btn" onClick={onRequest}>
            撤回
          </button>
        </>
      );
    }

    // 对手发来的请求：同意 / 拒绝。括注里的步数让他知道自己在同意什么
    return (
      <>
        <span className="board-hint">对手请求悔棋（撤 {undoRequest.plies} 步）</span>
        <button
          type="button"
          className="board-btn board-btn--primary"
          onClick={() => onRespond(true)}
        >
          同意
        </button>
        <button type="button" className="board-btn" onClick={() => onRespond(false)}>
          拒绝
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      className="board-btn"
      onClick={onRequest}
      disabled={!canRequest}
      title={canRequest ? '' : '现在没有可以撤回的棋'}
    >
      悔棋
    </button>
  );
}
