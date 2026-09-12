'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnlineBoardGame.tsx — 走子类棋的**联机对局壳**（三款棋共用）
//
// 【与单机壳的关系】同一张棋盘（BoardViewProps）、同一套选子交互
// （useMoveSelection）、同一份规则文案（sideName / reasonNote），只是一个把着法
// 交给本地棋盘 submit，一个 POST 给服务端。所以「单机能走的着法联机也能走」是
// 结构上成立的，不是靠两边小心保持同步。
//
// 【联机这边一行规则都不跑】合法着法直接取服务端下发的 `view.legalMoves`
// （见 board-shared.ts 的注释：走子类棋的合法着法依赖棋盘之外的状态，客户端推不出来）。
// 于是客户端**不可能**与服务端的判定 drift —— 它连判都没判。
//
// 【房间行为在 useOnlineRoom 里】连接、重连、可见性、presence、判胜倒计时、
// 再来一局投票与另外几款棋共用同一份实现。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useState } from 'react';
import type { MoveInput, Square } from '@/lib/board-shared';
import { playerOfSeat } from '@/lib/board-shared';
import OnlineRoomPanel, { roomEndNote } from './OnlineRoomPanel';
import { CLAIM_AFTER_MS, useOnlineRoom, type RoomActions } from './useOnlineRoom';
import { useMoveSelection } from './useMoveSelection';
import type { LocalGameSpec } from './board-view';

export interface OnlineBoardGameProps {
  title: string;
  desc: string;
  actions: RoomActions;
  /** 与单机共用的一份"这款棋叫什么"。不需要 createBoard（联机没有本地棋盘）。 */
  spec: Omit<LocalGameSpec, 'createBoard'>;
  initialRoom?: string | null;
  /** 进房后写回 URL 的固定参数（如 `{ mode: 'online' }`）。 */
  urlParams?: Record<string, string>;
}

export default function OnlineBoardGame({
  title,
  desc,
  actions,
  spec,
  initialRoom = null,
  urlParams,
}: OnlineBoardGameProps) {
  const { Board, sideName, reasonNote, isPromotion, promotionChoices } = spec;

  const room = useOnlineRoom(actions, initialRoom, urlParams ? { urlParams } : {});
  const {
    view,
    mySeat,
    isPlayer,
    myTurn,
    canPlay,
    conn,
    error,
    busy,
    copied,
    joinCode,
    setJoinCode,
    oppGone,
    oppGoneMs,
    canClaim,
  } = room;

  /** 待选兵种的升变路径（只有国际象棋会用到）。 */
  const [pending, setPending] = useState<Square[] | null>(null);

  // 服务端说哪些着法合法，客户端就只画这些 —— 自己不判
  const legalMoves = useMemo(() => view?.legalMoves ?? [], [view]);
  const revision = view?.revision ?? 0;

  const locked = !canPlay || pending !== null;

  const onPlay = useCallback(
    (move: MoveInput) => {
      const grid = view?.grid;
      const from = move.path[0];
      const to = move.path[move.path.length - 1];
      if (isPromotion && grid && isPromotion(grid[from[0]][from[1]], to)) {
        setPending(move.path);
        return;
      }
      room.playMove(move);
    },
    [isPromotion, room, view]
  );

  const selection = useMoveSelection(legalMoves, !locked, onPlay, revision);

  const choosePromotion = useCallback(
    (piece: string) => {
      if (!pending) return;
      setPending(null);
      room.playMove({ path: pending, promotion: piece });
    },
    [pending, room]
  );

  // 还没进房：房间面板
  if (!view) {
    return (
      <OnlineRoomPanel
        title={title}
        desc={desc}
        joinCode={joinCode}
        onJoinCodeChange={setJoinCode}
        onCreate={() => void room.createRoom()}
        onJoin={(code) => void room.joinRoom(code)}
        busy={busy}
        error={error}
      />
    );
  }

  const statusText = (() => {
    if (pending) return '选择升变';
    if (view.status === 'waiting') return '等待对手加入…';
    if (view.status === 'won') {
      if (!view.winner) return '对局结束';
      // 观众看的是"谁赢了"，棋手看的是"你赢了/你输了"
      if (!isPlayer) return `${sideName(playerOfSeat(view.winner))}获胜！`;
      const iWon = view.winner === mySeat;
      return (iWon ? '你赢了！' : '你输了') + roomEndNote(view.endReason, iWon ? 'won' : 'lost');
    }
    if (view.status === 'draw') {
      return `和棋！${view.endReason ? reasonNote(view.endReason) : ''}`;
    }
    if (!isPlayer) return '观战中';
    if (oppGone) return '对手已掉线';
    if (!myTurn) return '等对手走棋…';
    return `轮到你走${view.check ? '（被将军）' : ''}`;
  })();

  return (
    <div className="board-card">
      {conn !== 'open' && (
        <div className="board-banner" role="status">
          {conn === 'dead' ? '连接已断开' : '连接中断，正在重连…'}
        </div>
      )}

      {/* 席位栏：座位 id 是 black/white（"第几个座位"），显示名由各棋自己给
          —— 象棋的黑席执红，所以这里显示的是「红方」 */}
      <div className="board-seats">
        <span
          className={`board-seat${
            view.turn === 1 && view.status === 'playing' ? ' board-seat--active' : ''
          }`}
          data-seat="black"
        >
          {sideName(1)}
          {view.seats.black ? ` · ${view.seats.black.name}` : ' · 空位'}
          {view.seats.black && !view.seats.black.connected && '（掉线）'}
          {mySeat === 'black' && ' · 你'}
        </span>
        <span
          className={`board-seat${
            view.turn === 2 && view.status === 'playing' ? ' board-seat--active' : ''
          }`}
          data-seat="white"
        >
          {sideName(2)}
          {view.seats.white ? ` · ${view.seats.white.name}` : ' · 空位'}
          {view.seats.white && !view.seats.white.connected && '（掉线）'}
          {mySeat === 'white' && ' · 你'}
        </span>
        {view.spectatorCount > 0 && (
          <span className="board-seat board-seat--spec">围观 {view.spectatorCount}</span>
        )}
      </div>

      <div className="board-status">{statusText}</div>

      {/* 房号 + 复制链接 */}
      <div className="board-room-bar">
        <span className="board-room-bar__code">房号 {view.code.toUpperCase()}</span>
        <button
          type="button"
          className="board-btn board-btn--small"
          onClick={() => void room.copyLink()}
        >
          {copied ? '已复制' : '复制邀请链接'}
        </button>
        <button type="button" className="board-btn board-btn--small" onClick={room.leave}>
          离开
        </button>
      </div>

      <Board
        grid={view.grid}
        lastMove={view.lastMove}
        highlight={view.highlight}
        check={view.check}
        selection={selection}
        onSquareClick={(r, c) => selection.click([r, c])}
        disabled={locked}
      />

      {pending && promotionChoices && (
        <div className="board-promotion" role="group" aria-label="选择升变的棋子">
          <span className="board-promotion__label">升变为</span>
          {promotionChoices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="board-btn board-btn--small"
              onClick={() => choosePromotion(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}

      {/* 控制 */}
      <div className="board-controls">
        {view.status === 'playing' && isPlayer && (
          <button type="button" className="board-btn" onClick={room.resign}>
            认输
          </button>
        )}
        {view.status === 'playing' && room.oppSeat && oppGone && (
          <button
            type="button"
            className="board-btn"
            onClick={room.claim}
            disabled={!canClaim}
            title={canClaim ? '' : `对手掉线满 ${CLAIM_AFTER_MS / 1000} 秒后可判胜`}
          >
            {canClaim
              ? '判胜'
              : `判胜（${Math.max(0, Math.ceil((CLAIM_AFTER_MS - oppGoneMs) / 1000))}s）`}
          </button>
        )}
        {(view.status === 'won' || view.status === 'draw') && isPlayer && (
          <button type="button" className="board-btn board-btn--primary" onClick={room.rematch}>
            {view.rematchVotes > 0 && view.rematchVotes < 2
              ? '已申请，等对手'
              : '再来一局（需双方同意）'}
          </button>
        )}
        {!isPlayer && (
          <span className="board-hint">你在观战。两席坐满后加入的人自动成为观众。</span>
        )}
      </div>

      {error && <p className="board-room-panel__error">{error}</p>}
    </div>
  );
}
