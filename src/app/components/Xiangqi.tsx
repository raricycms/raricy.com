'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Xiangqi.tsx — 中国象棋**单机**（同机双人）
//
// 对局逻辑在 LocalBoardGame、棋规文案在 board-specs.tsx（都是三款棋共用/单机联机
// 共用）。象棋没有升变，所以规格表里不传 isPromotion。
//
// 【红先】先手席显示为「红方」—— 席位 id 叫 `black`（"第几个座位"，不是颜色），
// 两者的映射在 board-specs.tsx 里，别混。
// ─────────────────────────────────────────────────────────────────────────────

import { XiangqiBoard } from '@/lib/xiangqi-rules';
import LocalBoardGame from './LocalBoardGame';
import { XIANGQI_SPEC } from './board-specs';

export default function Xiangqi() {
  return <LocalBoardGame {...XIANGQI_SPEC} createBoard={() => new XiangqiBoard()} />;
}
