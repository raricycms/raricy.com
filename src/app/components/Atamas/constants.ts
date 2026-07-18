// ─────────────────────────────────────────────────────────────────────────────
// ATÅMAS — 常量与类型（对齐 Flask 侧 app/static/js/game/atamas/core.js）
//
// BASECOLORS / FRONTCOLORS：每个数字值 → 圆盘配色（值 v 用索引 (v-1) % len）。
// 数组内容与原 core.js 逐字一致，不做增删。
// ─────────────────────────────────────────────────────────────────────────────

// 允许临时出现第 21 个元素以便触发合并
export const MAX_ELEMENTS = 21;

export const BASECOLORS: string[] = [
  '#ffcccc', '#fce9cf', '#86e074', '#5fd87b',
  '#20a20f', '#81492a', '#b0bae6', '#ff0300', '#b0bae6',
  '#ff38b5', '#fadd3d', '#fc7c16', '#81b3d7', '#1b3bfa',
  '#c19cc3', '#fffa00', '#32fc03', '#d0fec5', '#a122f7',
  '#5b96be', '#b663ac', '#78cbff', '#e61a00', '#00009e',
  '#a9099e', '#b57200', '#0000af', '#b8bcbd', '#2247dd',
  '#8f9082', '#9ee474', '#7e6fa6', '#75d058', '#9aef10',
  '#7f3103', '#fabff3', '#ff0099', '#00ff27', '#67988e',
  '#00ff00', '#4cb276', '#b486b0', '#cdb0ca', '#cfb8ae',
  '#ced2ab', '#c2c4b9', '#b8bcbd', '#f31fe0', '#d781bc',
  '#9b8fb9', '#d88350', '#ada252', '#8f1f8b', '#9ba1f8',
  '#0fffb9', '#1ef02d', '#5ac44a', '#d1fd06', '#fde206',
  '#fc8e07', '#0000f5', '#fc067d', '#fb08d5', '#c004ff',
  '#7104fe', '#3106fc', '#073ffe', '#497339', '#0000e0',
  '#27fdf4', '#27fdb5', '#b4b45a', '#b79b56', '#8e8a80',
  '#b3b18e', '#c9b179', '#c9cf73', '#ccc6bf', '#feb338',
  '#d3b8cb', '#96896d', '#53535b', '#d230f8', '#0000ff',
  '#0000ff', '#ffff00', '#000000', '#6eaa59', '#659e73',
  '#26fe78', '#29fb35', '#7aa1aa', '#4d4d4d', '#4d4d4d',
  '#4d4d4d', '#4d4d4d',
];

export const FRONTCOLORS: string[] = [
  '#006666', '#004488', '#7a0066', '#8a004f',
  '#c040ff', '#7fffd5', '#4d004d', '#00ffff', '#4d004d',
  '#008800', '#0033aa', '#0055cc', '#803000', '#ffd400',
  '#005588', '#ff00ff', '#004400', '#ffff66', '#66ffff',
  '#66ff66', '#663300', '#00ffff', '#00ffff', '#ffff66',
  '#00ff66', '#66ffff', '#ffff66', '#333333', '#ffdd55',
  '#e0e0ff', '#550055', '#ffff99', '#5500aa', '#550088',
  '#66ffff', '#00ff99', '#00aa55', '#aa00aa', '#ff66cc',
  '#aa00aa', '#ff66aa', '#66ff99', '#333366', '#3333aa',
  '#3333aa', '#4444aa', '#333333', '#00aa00', '#004400',
  '#ffff99', '#004488', '#333388', '#66ff66', '#ffff66',
  '#aa0066', '#aa0000', '#004488', '#0000aa', '#0000aa',
  '#0000aa', '#ffff66', '#00aa88', '#00aa44', '#44ff66',
  '#88ff66', '#ccff66', '#ffff66', '#b4d68f', '#ffff66',
  '#aa0066', '#aa0044', '#4444aa', '#333388', '#6666ff',
  '#4444ff', '#3333ff', '#3333ff', '#333333', '#0044aa',
  '#333388', '#6666cc', '#cccccc', '#00aa00', '#ffff66',
  '#ffff66', '#0000ff', '#ffff00', '#ff66ff', '#ff99cc',
  '#aa00ff', '#aa00ff', '#ffcc66', '#ffff66', '#ffff66',
  '#ffff66', '#ffff66', '#ffff66',
];

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type ElementType = 'number' | 'plus';

/** 圆环上的元素 */
export interface RingElement {
  type: ElementType;
  value: number | null;
  id: number;
  angle: number;
  isAnimating?: boolean;
  animProgress?: number;
  startAngle?: number | null;
  targetAngle?: number;
  isNew?: boolean;
  isBlackGolden?: boolean;
  newlyFormed?: boolean;
}

/** 中心待放置 / 预览队列里的元素 */
export interface PendingElement {
  type: ElementType;
  value: number | null;
  isBlackGolden?: boolean;
  forRound?: number;
}

/** 推给 React 的 UI 快照（对齐原站 DOM 更新点） */
export interface AtamasUiSnapshot {
  score: number;
  maxPlate: number;
  elementCount: number;
  /** 预览队列前 3 个元素（null = 空槽显示 "?"） */
  preview: (PendingElement | null)[];
  recall: { disabled: boolean; text: string; title: string };
  /** messageBox.innerHTML 对应内容（可含 HTML） */
  message: string;
  /** currentAction 文案 */
  currentAction: string;
}
