'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Draughts.tsx — 国际跳棋**单机**（同机双人）
//
// 对局逻辑在 LocalBoardGame、棋规文案在 board-specs.tsx（都是三款棋共用/单机联机
// 共用）。跳棋没有升变选择（兵到底线自动成王），所以规格表里不传 isPromotion。
//
// 【连吃是逐跳点的】点一下自己的子，再依次点每个落点 —— 由 useMoveSelection 按
// "路径前缀"推进实现。
// ─────────────────────────────────────────────────────────────────────────────

import { DraughtsBoard } from '@/lib/draughts-rules';
import LocalBoardGame from './LocalBoardGame';
import { DRAUGHTS_SPEC } from './board-specs';

export default function Draughts() {
  return <LocalBoardGame {...DRAUGHTS_SPEC} createBoard={() => new DraughtsBoard()} />;
}
