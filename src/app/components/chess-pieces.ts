// ─────────────────────────────────────────────────────────────────────────────
// chess-pieces.ts —— 棋子的**外观**：图形文件路径与中文名。
//
// 【界面归这里，规则不在这里】棋子长什么样、叫什么名字是显示层的事；它能不能走到
// 那一格是 chess-rules 的事。这份文件只做前一半，所以它没有任何判定逻辑。
//
// 【为什么单独一份】棋盘（ChessBoard）与规格表（board-specs 的升变选择条）都要问
// 「这一格 → 哪一个图形文件」。两处各写一份的话，将来改文件名必然漏一处 —— 而缺图
// 是**全静默**的：SVG 404 不报错、构建不失败、单测也看不见，只有肉眼能发现。
//
// 【为什么是文件而不是字形】（2026-09 改）棋子此前是 Unicode 字形（♟♞♝♜♛♚）加一层
// text-shadow 描边。那等于把观感交给用户设备的字体，实测四件事都会翻车：
//   · `'Segoe UI Symbol', 'Noto Sans Symbols 2', serif` 这个字体栈在 Android / iOS 上
//     名存实亡，直接落到 `serif`，字形由设备决定；
//   · `♟`（U+265F）是 emoji 码位，文字字体缺字形时会被彩色 emoji 字体接走，
//     于是 color 与 text-shadow 全部失效 —— 整盘只有兵长得不一样；
//   · 白子靠 1px text-shadow 模拟描边，在浅格上本来就是勉强够看；
//   · `font-size` 只定 em 框，墨迹占 em 的比例仍由字体决定，同一段 CSS 在不同设备上
//     得到不同大小的棋子。
// 换成矢量后，尺寸、比例、描边宽度、配色**全部由我们决定**，与设备字体无关。
//
// 【图形是第三方素材】`public/static/img/chess/` 下 12 个 SVG，作者 Cburnett，
// BSD 3-Clause（全文与出处见同目录 LICENSE.txt）。**白子与黑子是两套不同的文件**，
// 不是同一张图换填充色 —— 白子是白填充 + 深色描边，黑子是黑填充 + 浅色细节线。
// 所以别想当然地「一张图 + CSS 上色」。
// ─────────────────────────────────────────────────────────────────────────────

import {
  BISHOP,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  colorOf,
  typeOf,
  type PieceType,
} from '@/lib/chess-rules';

/** 兵种 → 素材文件名里的那个字母（与 FEN、glyphOf 同一口径）。 */
const LETTER: Record<PieceType, string> = {
  [PAWN]: 'p',
  [KNIGHT]: 'n',
  [BISHOP]: 'b',
  [ROOK]: 'r',
  [QUEEN]: 'q',
  [KING]: 'k',
};

/** 兵种 → 中文名。给 aria-label 用 —— 字形退休后，读屏该念的是这个。 */
const NAME: Record<PieceType, string> = {
  [PAWN]: '兵',
  [KNIGHT]: '马',
  [BISHOP]: '象',
  [ROOK]: '车',
  [QUEEN]: '后',
  [KING]: '王',
};

/**
 * 棋子格子的图形路径（空格返回 null）。入参是**格子取值**而不是 (兵种, 颜色)，
 * 是为了与 chess-rules 的 `glyphOf(cell)` 同构 —— 调用方手上有的就是 cell，
 * 不该为了渲染再去拆一遍编码、更不该为此写类型断言。
 */
export function pieceIconSrc(cell: number): string | null {
  const t = typeOf(cell);
  if (t === 0) return null;
  return `/static/img/chess/Chess_${LETTER[t]}${colorOf(cell) === WHITE ? 'l' : 'd'}t45.svg`;
}

/** 棋子的中文名（"白兵" / "黑后"），空格返回空串。 */
export function pieceName(cell: number): string {
  const t = typeOf(cell);
  if (t === 0) return '';
  return `${colorOf(cell) === WHITE ? '白' : '黑'}${NAME[t]}`;
}
