'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnlineTicTacToe.tsx — 井字棋联机对战
//
// 【与 OnlineGomoku 的关系】房间面板、席位栏、连接横幅、判胜倒计时、再来一局这一整套
// 行为都在 useOnlineRoom（一个 hook）里，这里只负责本游戏特有的三件事：画 3×3 棋盘、
// 写状态文案、摆控制按钮。改房间行为请去 hook 或 board-room.ts —— 两个游戏共用那一份。
//
// 【记号口径】先手 X（= 房间层的 black 席 = 建房者），后手 O。这个映射由
// tictactoe-rules 的 X=1 / O=2 决定，与 board-shared 的 FIRST/SECOND 同值，
// 房间层因此能靠 turn 直接换算出「轮到哪一席」。
//
// 【路径字面量必须写全】下面的 ACTIONS 里每条 URL 都是完整字面量：
// scripts/check-links.mjs 静态校验它们有没有对应路由，而拼出来的路径它看不见。
// 详见 useOnlineRoom 的文件头。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from 'react';
import { markOf, O, X } from '@/lib/tictactoe-rules';
import OnlineRoomPanel from './OnlineRoomPanel';
import TicTacToeBoard from './TicTacToeBoard';
import { CLAIM_AFTER_MS, postJson, useOnlineRoom, type RoomActions } from './useOnlineRoom';

/**
 * 井字棋的接口地址。**定义在模块级**：引用恒定，hook 的 useCallback 依赖不必
 * 每次渲染都换新对象（换新会让 SSE 那个 effect 反复重建连接）。
 */
const ACTIONS: RoomActions = {
  create: () => postJson('/api/game/tictactoe/rooms'),
  join: (code) => postJson(`/api/game/tictactoe/rooms/${code}/join`),
  move: (code, row, col) => postJson(`/api/game/tictactoe/rooms/${code}/moves`, { row, col }),
  resign: (code) => postJson(`/api/game/tictactoe/rooms/${code}/resign`),
  claim: (code) => postJson(`/api/game/tictactoe/rooms/${code}/claim`),
  rematch: (code) => postJson(`/api/game/tictactoe/rooms/${code}/rematch`),
  streamUrl: (code) => `/api/game/tictactoe/rooms/${code}/stream`,
  snapshotUrl: (code) => `/api/game/tictactoe/rooms/${code}`,
};

export interface OnlineTicTacToeProps {
  initialRoom?: string | null;
}

export default function OnlineTicTacToe({ initialRoom = null }: OnlineTicTacToeProps) {
  // 只有一个模式，URL 里不需要 mode 参数（五子棋要带 mode=online 才不回落到单机）
  const room = useOnlineRoom(ACTIONS, initialRoom);
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

  const onCellClick = useCallback(
    (row: number, col: number) => {
      if (!canPlay) return;
      room.playMove(row, col);
    },
    [canPlay, room]
  );

  // 还没进房：房间面板
  if (!view) {
    return (
      <OnlineRoomPanel
        title="井字棋 · 联机对战"
        desc="开一间房，把链接发给朋友；也可以输入对方给的房号加入。需要核心用户权限。"
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
    if (view.status === 'waiting') return '等待对手加入…';
    if (view.status === 'won') {
      if (!view.winner) return '对局结束';
      return isPlayer && view.winner === mySeat ? '你赢了！' : '你输了';
    }
    if (view.status === 'draw') return '平局！';
    if (!isPlayer) return '观战中';
    if (oppGone) return '对手已掉线';
    return myTurn ? '轮到你走' : '等对手落子…';
  })();

  return (
    <div className="board-card">
      {conn !== 'open' && (
        <div className="board-banner" role="status">
          {conn === 'dead' ? '连接已断开' : '连接中断，正在重连…'}
        </div>
      )}

      {/* 席位栏 */}
      <div className="board-seats">
        <span
          className={`board-seat${
            view.turn === X && view.status === 'playing' ? ' board-seat--active' : ''
          }`}
          data-seat="black"
        >
          <span className="tictactoe-mark tictactoe-mark--x" aria-hidden="true">
            {markOf(X)}
          </span>
          {view.seats.black?.name ?? '空位'}
          {view.seats.black && !view.seats.black.connected && '（掉线）'}
          {mySeat === 'black' && ' · 你'}
        </span>
        <span
          className={`board-seat${
            view.turn !== X && view.status === 'playing' ? ' board-seat--active' : ''
          }`}
          data-seat="white"
        >
          <span className="tictactoe-mark tictactoe-mark--o" aria-hidden="true">
            {markOf(O)}
          </span>
          {view.seats.white?.name ?? '空位'}
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
        <button type="button" className="board-btn board-btn--small" onClick={() => void room.copyLink()}>
          {copied ? '已复制' : '复制邀请链接'}
        </button>
        <button type="button" className="board-btn board-btn--small" onClick={room.leave}>
          离开
        </button>
      </div>

      <TicTacToeBoard
        grid={view.grid}
        lastMove={view.lastMove}
        winningLine={view.winningLine.length > 0 ? view.winningLine : null}
        onCellClick={onCellClick}
        disabled={!canPlay}
      />

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
