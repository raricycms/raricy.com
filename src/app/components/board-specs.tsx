'use client';

// ─────────────────────────────────────────────────────────────────────────────
// board-specs.tsx — 三款走子类棋的**规格表**（单机与联机共用同一份）
//
// 【为什么只有一份】「某一方叫什么」「终局怎么念」「要不要问升变」这三件事与
// "对手坐在对面还是隔着网线"毫无关系。单机与联机各写一份的话，迟早出现
// "单机里叫红方、联机里叫黑方"或者"联机忘了加（困毙）这个括注"—— 两者都不会
// 让任何测试转红，只会让玩家觉得两款入口不像同一个游戏。
//
// 【各自不同的那部分确实是不同的】同样一个 `no-moves`：象棋读作「困毙」、
// 跳棋读作「无子可走」；同样一个 `fifty-move`：象棋是 60 回合无吃子、
// 跳棋是 25 回合只有王在动。所以文案表是按棋各写各的，不强行统一。
// ─────────────────────────────────────────────────────────────────────────────

import type { EndReason, Player } from '@/lib/board-shared';
import { WHITE as CHESS_WHITE, isPromotionMove } from '@/lib/chess-rules';
import { RED } from '@/lib/xiangqi-rules';
import { WHITE as DRAUGHTS_WHITE } from '@/lib/draughts-rules';
import ChessBoardView from './ChessBoard';
import DraughtsBoardView from './DraughtsBoard';
import XiangqiBoardView from './XiangqiBoard';
import type { BoardSpec } from './board-view';

/** 升变可选的四种。**没有王** —— 升变成王不是合法着法。 */
const PROMOTION_CHOICES = [
  { value: 'q', label: '后' },
  { value: 'r', label: '车' },
  { value: 'b', label: '象' },
  { value: 'n', label: '马' },
] as const;

export const CHESS_SPEC: BoardSpec = {
  Board: ChessBoardView,
  sideName: (player: Player) => (player === CHESS_WHITE ? '白方' : '黑方'),
  reasonNote: (reason: EndReason) => {
    switch (reason) {
      case 'checkmate':
        return '（将死）';
      // 国际象棋的"无棋可走"是**和棋**（逼和），与中国象棋的困毙判负正好相反
      case 'stalemate':
        return '（逼和）';
      case 'fifty-move':
        return '（五十回合内无吃子、无兵动）';
      case 'insufficient-material':
        return '（子力不足）';
      case 'repetition':
        return '（三次重复局面）';
      default:
        return '';
    }
  },
  isPromotion: isPromotionMove,
  promotionChoices: PROMOTION_CHOICES,
};

export const XIANGQI_SPEC: BoardSpec = {
  Board: XiangqiBoardView,
  // 红先：先手席显示成「红方」（席位 id 是 black，那是"第几个座位"不是颜色）
  sideName: (player: Player) => (player === RED ? '红方' : '黑方'),
  reasonNote: (reason: EndReason) => {
    switch (reason) {
      case 'checkmate':
        return '（将死）';
      // 困毙是象棋特有的：无棋可走**判负**，不是和棋
      case 'no-moves':
        return '（困毙）';
      case 'no-capture':
        return '（60 回合无吃子）';
      case 'perpetual-check':
        return '（长将判负）';
      case 'repetition':
        return '（三次重复局面）';
      default:
        return '';
    }
  },
};

export const DRAUGHTS_SPEC: BoardSpec = {
  Board: DraughtsBoardView,
  sideName: (player: Player) => (player === DRAUGHTS_WHITE ? '白方' : '黑方'),
  reasonNote: (reason: EndReason) => {
    switch (reason) {
      // 无子可动（被吃光或全被封死）→ 判负
      case 'no-moves':
        return '（无子可走）';
      // 同一个 reason 在象棋是 60 回合无吃子，在这里是 25 回合只有王在动
      case 'fifty-move':
        return '（25 回合只有王在动且无吃子）';
      case 'repetition':
        return '（三次重复局面）';
      default:
        return '';
    }
  },
};
