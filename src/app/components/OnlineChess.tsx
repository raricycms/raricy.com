'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnlineChess.tsx — 国际象棋联机对战
//
// 房间面板、席位栏、连接横幅、判胜倒计时、再来一局、棋盘渲染与选子交互全在
// OnlineBoardGame / useOnlineRoom / useMoveSelection 里（三款走子类棋共用一份）。
// 本文件只剩**接口地址** —— 而它必须是写全的字面量：scripts/check-links.mjs
// 静态校验源码里的接口路径有没有对应路由，`${basePath}/rooms/${code}/moves`
// 在它眼里是两段占位符连在一起，校验不了（路径写错一个字母就是线上 404，
// 且 tsc 与单测都看不见）。详见 useOnlineRoom 的文件头。
//
// 【ACTIONS 定义在模块级】引用恒定，hook 的 useCallback 依赖不必每次渲染都换新对象
// （换新会让 SSE 那个 effect 反复重建连接）。
// ─────────────────────────────────────────────────────────────────────────────

import { postJson, type RoomActions } from './useOnlineRoom';
import OnlineBoardGame from './OnlineBoardGame';
import { CHESS_SPEC } from './board-specs';

const ACTIONS: RoomActions = {
  create: () => postJson('/api/game/chess/rooms'),
  join: (code) => postJson(`/api/game/chess/rooms/${code}/join`),
  move: (code, move) => postJson(`/api/game/chess/rooms/${code}/moves`, move),
  resign: (code) => postJson(`/api/game/chess/rooms/${code}/resign`),
  claim: (code) => postJson(`/api/game/chess/rooms/${code}/claim`),
  rematch: (code) => postJson(`/api/game/chess/rooms/${code}/rematch`),
  streamUrl: (code) => `/api/game/chess/rooms/${code}/stream`,
  snapshotUrl: (code) => `/api/game/chess/rooms/${code}`,
};

export interface OnlineChessProps {
  initialRoom?: string | null;
}

export default function OnlineChess({ initialRoom = null }: OnlineChessProps) {
  return (
    <OnlineBoardGame
      title="国际象棋 · 联机对战"
      desc="开一间房，把链接发给朋友；也可以输入对方给的房号加入。需要核心用户权限。"
      actions={ACTIONS}
      spec={CHESS_SPEC}
      // 单机与联机是同一个路由，靠 ?mode= 区分 —— 进房后必须把它写回 URL，
      // 否则复制出去的邀请链接一刷新就掉回单机模式。
      urlParams={{ mode: 'online' }}
      initialRoom={initialRoom}
    />
  );
}
