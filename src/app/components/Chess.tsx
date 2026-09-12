'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Chess.tsx — 国际象棋**单机**（同机双人）
//
// 对局逻辑、悔棋、新对局、升变选择全在 LocalBoardGame 里（三款棋共用一份）；
// 「白方黑方怎么念、终局怎么念、升变有哪几种」在 board-specs.tsx（单机与联机
// 共用同一份）。本文件只剩"用哪张棋盘"这一句 —— 这正是共用换来的。
//
// 【单机是匿名可玩的】与五子棋单机同理：不登录、不开专注模式也能直达
// （闸门只加在 ?mode=online 那一支，见 app/game/chess/page.tsx）。
// ─────────────────────────────────────────────────────────────────────────────

import { ChessBoard } from '@/lib/chess-rules';
import LocalBoardGame from './LocalBoardGame';
import { CHESS_SPEC } from './board-specs';

export default function Chess() {
  return <LocalBoardGame {...CHESS_SPEC} createBoard={() => new ChessBoard()} />;
}
