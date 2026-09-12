// ─────────────────────────────────────────────────────────────────────────────
// board-view.ts — 走子类棋的**客户端共用契约**（纯类型，无运行时代码）
//
// 【为什么要有它】三款棋的棋盘组件、单机对局壳、联机对局壳长得几乎一样：
// 棋盘渲染拿同一组 props，单机与联机各自驱动同一个棋盘。
// 把这些形状写在一处，是为了让「三款棋共用同一个单机壳」（LocalBoardGame）成为
// 可能 —— 否则就得写三份几乎逐字相同的对局逻辑，而它们必然慢慢分叉。
//
// 【棋盘类的共同形状】三款棋的棋盘（ChessBoard / XiangqiBoard / DraughtsBoard）
// 都满足 `LocalGameBoard`：它们本来就都实现了房间层的 RoomBoard，再各自多一个
// `generateMoves` 给客户端算合法落点（只为提示，服务端仍会重判）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ComponentType } from 'react';
import type { EndReason, Move, MoveInput, Outcome, Player, Square } from '@/lib/board-shared';
import type { MoveSelection } from './useMoveSelection';

/** 三款棋的棋盘渲染组件共用的 props。 */
export interface BoardViewProps {
  /** 服务端权威棋盘（联机）或本地棋盘（单机）。取值语义由各棋自己定义。 */
  grid: number[][];
  /** 最后一手走过的整条路径。 */
  lastMove: Move | null;
  /** 终局高亮：落子类是成线的那几格，走子类通常是被将死 / 困毙的王。 */
  highlight: Square[];
  /** 轮到走棋那一方被将军时，王的格子；否则 null。跳棋没有将军，恒为 null。 */
  check: Square | null;
  selection: MoveSelection;
  onSquareClick: (row: number, col: number) => void;
  /** 点不动（轮不到你 / 观战 / 断线 / 已终局）。棋盘照常显示。 */
  disabled: boolean;
}

/**
 * 本地对局用得上的棋盘能力。三款棋的棋盘类**结构上**都满足它。
 * 与房间层的 RoomBoard 相比多了 `generateMoves` 与 `undo`，少了 `rows/cols` 之外的
 * 房间概念 —— 单机不需要房间。
 */
export interface LocalGameBoard {
  readonly rows: number;
  readonly cols: number;
  grid: number[][];
  /** 轮到哪一方（1 = 先手）。 */
  turn: Player;
  /** 回到开局。 */
  reset(): void;
  /** 走一手；非法返回 null 且棋盘不动。 */
  submit(player: Player, move: MoveInput): Outcome | null;
  getLastMove(): Move | null;
  /** 当前走子方的全部合法着法（客户端算，只为提示）。 */
  generateMoves(color: Player): MoveInput[];
  /** 撤销最后一手。没有可撤的返回 false。 */
  undo(): boolean;
}

/**
 * 一种棋**除了造棋盘之外**的全部差异。单机壳与联机壳共用同一份
 * （见 board-specs.tsx）—— 否则"某一方叫什么""终局怎么念"会在单机与联机两处
 * 各写一份，然后慢慢分叉成"单机叫红方、联机叫黑方"这种没人会立刻发现的错。
 */
export interface BoardSpec {
  /** 画棋盘的那个组件。 */
  Board: ComponentType<BoardViewProps>;
  /** 某一方的名字（"红方" / "白方"…）。 */
  sideName: (player: Player) => string;
  /**
   * 终局原因 → 一句括注。**各棋文案不同**：同样一个 `no-moves`，
   * 象棋读作「困毙」、跳棋读作「无子可走」；`fifty-move` 在象棋是 60 回合无吃子、
   * 在国际跳棋是 25 回合只有王在动。所以不共用文案表，各棋自己写。
   */
  reasonNote: (reason: EndReason) => string;
  /**
   * 这一手是不是"必须先问兵种"的升变（只有国际象棋有）。
   * 不给就表示这款棋没有升变选择，落子即定。
   */
  isPromotion?: (cell: number, to: Square) => boolean;
  /** 升变可选的兵种。有 `isPromotion` 时才用得上。 */
  promotionChoices?: ReadonlyArray<{ value: string; label: string }>;
}

/** 单机壳要的全部东西 = 一款棋的规格 + 造棋盘的能力。 */
export interface LocalGameSpec extends BoardSpec {
  /** 造一张新棋盘（"新对局"用）。 */
  createBoard: () => LocalGameBoard;
}
