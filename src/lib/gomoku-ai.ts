// ─────────────────────────────────────────────────────────────────────────────
// gomoku-ai.ts — 五子棋**人机对战**引擎。
//
// 【为什么在 lib 而不是组件里】原实现是 GomokuLocal.tsx 里的一个 class（从
// Flask 的 ai.js 移植）。埋在客户端组件里有三个后果：node 下跑不起来 → 一个
// 单测都没有 → 棋力退化没人发现。抽出来后 tests/unit/gomoku-ai.test.ts 能完整
// 覆盖它。
//
// 【依赖】只 import 同目录的 gomoku-rules。**不 import 任何 server-only 模块**
// （prisma / next-headers…），浏览器与服务端都能跑；但实际只有单机组件会用它
// —— 联机对战的胜负判定不需要 AI。
//
// 【契约】findBestMove 返回时棋盘必须与调用前**逐格相同**（内部成对
// place/unplace）。测试用 JSON 快照钉住这条。
//
// 【规则口径】完全沿用 gomoku-rules：15×15、黑先、四方向 ≥5 连即胜，
// **长连也算胜**（free-style）。本模块不重新定义任何规则。
//
// 【计时】用 performance.now()，绝不用 Date —— src/lib 受 db-time 静态守卫管辖
// （无参 `new Date()` 会被判红）。performance 在 node 20 与浏览器上都有。
//
// 【分层】由便宜到贵，每层都能独立否决上一层：
//   L0 一步成五 / 一步挡五             —— O(候选数)，永远跑
//   L1 精确棋型分析 + 双威胁组合        —— 判断「这一手是否已经赢了」
//   L2 VCF 连续冲四连杀                —— 确定性推理，能看见远处杀棋
//   L3 迭代加深 Negamax + Alpha-Beta   —— 兜底的通用搜索
//
// 【评估为什么是「5 格窗口计数」】老实现只数**连续**同色子，跳三（○●○●○）与
// 跳四被拆成两段分别计分，等于看不见。窗口计数天然没这个问题：`_X_XX_` 与
// `_XXX__` 的窗口计数完全相同，因为「填哪一格能连成五」本身就允许中间有空格。
// 于是跳子不需要任何特例，还能预计算成一张 3^5 = 243 项的查找表。
//
// 【已知问题 · hard 档还不够强，先别接进 UI】
// L3 是宽度截断的搜索，一旦把防守方的解招挤出候选表，它就会报出并不存在的
// 「必胜」并去追那手废棋 —— 实测 hard 对旧 AI 八局全败，整局几乎每手都报
// 99999996 这种假杀分。改成「防守方不设上限」后假杀消失、分数回到正常评估值，
// 但代价是防守方分支上百，同样的节点预算下自己够得着的深度被吃掉（20000 节点时
// 实际只到深度 4，与 normal 持平），**结果 hard 仍然赢不了旧 AI（0:8），
// 与 normal 的战绩（4:4）相比没有优势**。
//
// 要真正做强，需要在候选生成上做文章（无条件纳入双方所有「能成四」的点，
// 而不是靠启发式排序挤名额），或者上威胁空间搜索 / 置换表。在那之前：
// `hard` 不得接进 UI —— 接进去就是把一个比现状更弱的 AI 给玩家。
// L0/L1/L2 的战术是精确判定的，本身没问题，测试也钉住了。
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLACK,
  BOARD_SIZE,
  EMPTY,
  WHITE,
  type GomokuBoard,
  type Player,
} from './gomoku-rules';

export type Difficulty = 'normal' | 'hard';

export interface AiMove {
  row: number;
  col: number;
}

export interface AiResult extends AiMove {
  /** 该着法的搜索分值（AI 视角）。由 L0/L1/L2 快路给出的手是极大值。 */
  score: number;
  /** 实际完成的搜索深度。0 表示由快路给出。 */
  depth: number;
  /** 消耗的节点数 —— 调参与测试断言都用它，不用墙钟。 */
  nodes: number;
}

export interface AiOptions {
  /** 默认 'normal'。 */
  difficulty?: Difficulty;
  /**
   * 节点预算。与 timeBudgetMs **先到者生效**。
   * 测试里用它替代墙钟 —— 固定节点数才是确定性的（仓库没有墙钟断言的先例）。
   */
  maxNodes?: number;
  /** 墙钟预算（毫秒）。不传则取难度表里的默认值。 */
  timeBudgetMs?: number;
  /** 协作式取消。每 1024 个节点检查一次。 */
  shouldStop?: () => boolean;
}

/** `analyzeMoveAt` 的结果：这一手会造出什么。 */
export interface MoveAnalysis {
  /** 直接成五。 */
  five: boolean;
  /** 成五点数量（去重）。≥2 即活四 —— 对手一手挡不住。 */
  winCellCount: number;
  /** 造出「四」的方向数。≥2 即双四。 */
  fours: number;
  /** 造出活三的方向数。≥2 即双活三。 */
  openThrees: number;
  /**
   * 是否是**必胜手**（对手一手挡不住）。判据是经典的四条组合：
   * 活四 / 双四 / 四三 / 双活三。
   */
  winning: boolean;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const SIZE = BOARD_SIZE;
const CELLS = SIZE * SIZE;

/** 方向向量（与 gomoku-rules 的 DIRECTIONS 同序）：右、下、右下、左下。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/**
 * `W[k]` = 一个「只有我方子与空位、其中 k 个我方子」的 5 格窗口值多少分。
 *
 * 取值由三条不等式反推 —— 这是整套权重里唯一要守的约束：
 *   冲四(1×W[4]) < 双活三(4×W[3]) < 活四(2×W[4])
 *   ⇒ 2·W[3] < W[4] < 4·W[3]
 * 取 W[3]=1000 / W[4]=3000 满足。**要调参只动这个数组**，别去改公式。
 *
 * W[5] 取极大值纯粹是防御：搜索在落子那一瞬间就用 makesFive 判胜了，
 * 叶子理论上不会出现五连。
 */
const W = [0, 1, 30, 1000, 3000, 10_000_000];

/** 成五分。远大于任何评估值，保证「赢」压过一切。 */
const WIN_SCORE = 100_000_000;
const INF = 1e9;

/** 走法排序打包用：先加偏置消掉负数，才能安全地用 `% 256` 取回下标。 */
const SORT_BIAS = 1_000_000;

/**
 * 单元格值 → 窗口表下标的进制数字。外层下标是「谁当自己」。
 * `[BLACK] = [0, 1, 2]`：空格→0、黑子（当自己）→1、白子（当对手）→2。
 */
const DIGIT_AS_ME: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 0, 0],
  [0, 1, 2],
  [0, 2, 1],
];

/**
 * 3^5 = 243 项的窗口查找表。下标是按 3 进制拼出的窗口内容，值为该窗口对
 * 「当自己」那一方的分数：窗口里只要有对手子就一文不值。
 */
const WINDOW_TABLE: Int32Array = (() => {
  const t = new Int32Array(243);
  for (let idx = 0; idx < 243; idx++) {
    let n = idx;
    let mine = 0;
    let blocked = false;
    for (let i = 0; i < 5; i++) {
      const d = n % 3;
      n = (n - d) / 3;
      if (d === 2) {
        blocked = true;
        break;
      }
      if (d === 1) mine++;
    }
    t[idx] = blocked ? 0 : W[mine];
  }
  return t;
})();

/** 一条线的描述：起始格（扁平下标）、步长（扁平下标差）、长度。 */
interface LineDesc {
  start: number;
  step: number;
  len: number;
}

/** 全部长度 ≥5 的线（15 行 + 15 列 + 两条对角方向各 21 条），共 72 条。 */
const LINES: ReadonlyArray<LineDesc> = (() => {
  const out: LineDesc[] = [];
  const add = (r: number, c: number, dr: number, dc: number): void => {
    let len = 0;
    let rr = r;
    let cc = c;
    while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) {
      len++;
      rr += dr;
      cc += dc;
    }
    if (len >= 5) out.push({ start: r * SIZE + c, step: dr * SIZE + dc, len });
  };
  for (let r = 0; r < SIZE; r++) add(r, 0, 0, 1);
  for (let c = 0; c < SIZE; c++) add(0, c, 1, 0);
  for (let r = 0; r < SIZE; r++) add(r, 0, 1, 1);
  for (let c = 1; c < SIZE; c++) add(0, c, 1, 1);
  for (let r = 0; r < SIZE; r++) add(r, SIZE - 1, 1, -1);
  for (let c = 0; c < SIZE - 1; c++) add(0, c, 1, -1);
  return out;
})();

interface Params {
  maxDepth: number;
  candidateWidth: number;
  timeBudgetMs: number;
  /** L1：精确棋型分析 + 双威胁组合。 */
  useThreats: boolean;
  /** L2：VCF 连续冲四连杀。 */
  useVcf: boolean;
  /** 是否随搜索层数收窄候选宽度（见 `Search.widthFor`）。 */
  narrowByPly: boolean;
}

/**
 * 难度参数表。
 *
 * `normal` 刻意沿用被替换掉的那套参数（深度 4 / 宽度 12），对齐「普通」这一档
 * 原有的棋力定位。实测（每手 2 万节点、先后手各半、8 局）与旧 AI 打成 4:4 ——
 * 确实是对齐了，别指望它明显更强。窗口计数看得见跳子，但深度只到 4，优势被
 * 搜索层数抵掉了。
 *
 * 两档都不加随机扰动：保持确定性，测试与复现才有意义。
 */
const PARAMS: Record<Difficulty, Params> = {
  normal: {
    maxDepth: 4,
    candidateWidth: 12,
    timeBudgetMs: 200,
    useThreats: false,
    useVcf: false,
    narrowByPly: false,
  },
  hard: {
    maxDepth: 10,
    candidateWidth: 16,
    timeBudgetMs: 900,
    useThreats: true,
    useVcf: true,
    narrowByPly: true,
  },
};

/** VCF 的递归层上限。每层都要落一子，超过这个深度已不现实。 */
const VCF_MAX_DEPTH = 10;

// ─── 小工具 ──────────────────────────────────────────────────────────────────

function otherOf(p: Player): Player {
  return p === BLACK ? WHITE : BLACK;
}

function inBoard(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// ─── 棋盘状态（扁平数组 + 邻近计数）──────────────────────────────────────────
// 全程用 Uint8Array/Int32Array 而不是对象数组：搜索每层都要枚举候选，而老实现
// 每个节点都建一个 Set + 一个 {row,col} 对象数组，是主要的热点与 GC 来源。

/** 切比雪夫距离 2 以内的格子计数 +delta —— 候选格就是计数 >0 的空格。 */
function bumpNear(near: Int32Array, pos: number, delta: number): void {
  const r0 = (pos / SIZE) | 0;
  const c0 = pos % SIZE;
  for (let dr = -2; dr <= 2; dr++) {
    const r = r0 + dr;
    if (r < 0 || r >= SIZE) continue;
    for (let dc = -2; dc <= 2; dc++) {
      const c = c0 + dc;
      if (c < 0 || c >= SIZE) continue;
      near[r * SIZE + c] += delta;
    }
  }
}

// ─── 棋型判定（精确，用于 L0/L1/L2）─────────────────────────────────────────
// 与窗口计数不同，这里是**精确**的：能区分活四与冲四、活三与眠三。代价高，
// 所以只用在每步一次的威胁分析上，绝不进搜索热循环。

/** 落子在 pos 后是否已成五连。调用前 cells[pos] 必须已经是 player。 */
function makesFive(cells: Uint8Array, pos: number, player: Player): boolean {
  const r0 = (pos / SIZE) | 0;
  const c0 = pos % SIZE;
  for (let d = 0; d < 4; d++) {
    const dr = DIRS[d][0];
    const dc = DIRS[d][1];
    let n = 1;
    for (let s = 1; s <= 4; s++) {
      const rr = r0 + s * dr;
      const cc = c0 + s * dc;
      if (!inBoard(rr, cc) || cells[rr * SIZE + cc] !== player) break;
      n++;
    }
    for (let s = 1; s <= 4; s++) {
      const rr = r0 - s * dr;
      const cc = c0 - s * dc;
      if (!inBoard(rr, cc) || cells[rr * SIZE + cc] !== player) break;
      n++;
    }
    if (n >= 5) return true;
  }
  return false;
}

/**
 * 以中心格为原点，沿 dir 取出 11 格（左右各 5）。越界记为对手子 —— 棋盘边界
 * 就是封堵，这样「边上的三不是活三」自动成立，不需要特判。
 *
 * 取 5 而不是 4 是因为判断活四要再看一格：`_XXXX_` 的第二个成五点在 5 格外。
 */
function segment(cells: Uint8Array, pos: number, player: Player, dir: number): Uint8Array {
  const opp = otherOf(player);
  const r0 = (pos / SIZE) | 0;
  const c0 = pos % SIZE;
  const dr = DIRS[dir][0];
  const dc = DIRS[dir][1];
  const seg = new Uint8Array(11);
  for (let k = -5; k <= 5; k++) {
    const rr = r0 + k * dr;
    const cc = c0 + k * dc;
    if (!inBoard(rr, cc)) seg[k + 5] = opp;
    else if (k === 0) seg[k + 5] = player;
    else seg[k + 5] = cells[rr * SIZE + cc];
  }
  return seg;
}

/**
 * 某个方向上「再填哪一格就能成五」的空格（扁平下标）。
 *
 * 做法：在 11 格窗口里枚举 5 个**包含中心**的 5 格窗口（起点 1..5）。某个窗口
 * 里没有对手子且恰好有 4 个我方子时，它缺的那一格就是成五点 —— 这一步顺带把
 * 跳子处理掉了，因为「差一格」本来就不要求这 4 个子连续。
 *
 * 调用前 cells[pos] 必须已经是 player。
 */
function dirWinCells(cells: Uint8Array, pos: number, player: Player, dir: number): number[] {
  const r0 = (pos / SIZE) | 0;
  const c0 = pos % SIZE;
  const dr = DIRS[dir][0];
  const dc = DIRS[dir][1];
  const seg = segment(cells, pos, player, dir);
  const out: number[] = [];
  for (let s = 1; s <= 5; s++) {
    let mine = 0;
    let blocked = false;
    let hole = -1;
    for (let k = 0; k < 5; k++) {
      const v = seg[s + k];
      if (v === player) mine++;
      else if (v === 0) hole = s + k;
      else {
        blocked = true;
        break;
      }
    }
    if (blocked || mine !== 4) continue;
    const off = hole - 5;
    const rr = r0 + off * dr;
    const cc = c0 + off * dc;
    if (inBoard(rr, cc)) out.push(rr * SIZE + cc);
  }
  return out;
}

/**
 * 落子在 pos 后，四个方向上「再填哪一格就能成五」的空格集合（去重）。
 * 个数就是这一手造出的成五点数量：≥2 活四（对手一手挡不住）、=1 冲四/跳四。
 */
function winCells(cells: Uint8Array, pos: number, player: Player): number[] {
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const list = dirWinCells(cells, pos, player, d);
    for (let i = 0; i < list.length; i++) {
      if (!out.includes(list[i])) out.push(list[i]);
    }
  }
  return out;
}

/** 这一手在几个方向上成四。≥2 即双四。 */
function countFourDirs(cells: Uint8Array, pos: number, player: Player): number {
  let n = 0;
  for (let d = 0; d < 4; d++) {
    if (dirWinCells(cells, pos, player, d).length > 0) n++;
  }
  return n;
}

/**
 * 该方向是否还存在「再走一步能成活四」的空点 —— 即活三。只看一个方向，
 * 调用方对四方向汇总（要求两个**不同方向**都成立，才是双活三）。
 */
function dirHasOpenFourNext(
  cells: Uint8Array,
  pos: number,
  player: Player,
  dir: number
): boolean {
  const r0 = (pos / SIZE) | 0;
  const c0 = pos % SIZE;
  const dr = DIRS[dir][0];
  const dc = DIRS[dir][1];
  for (let k = -5; k <= 5; k++) {
    if (k === 0) continue;
    const rr = r0 + k * dr;
    const cc = c0 + k * dc;
    if (!inBoard(rr, cc)) continue;
    const flat = rr * SIZE + cc;
    if (cells[flat] !== EMPTY) continue;
    cells[flat] = player;
    const open = winCells(cells, pos, player).length >= 2;
    cells[flat] = EMPTY;
    if (open) return true;
  }
  return false;
}

/** 对外的精确分析入口：给定局面与空点，返回这一手会造出什么。 */
export function analyzeMoveAt(
  board: GomokuBoard,
  row: number,
  col: number,
  player: Player
): MoveAnalysis {
  const cells = new Uint8Array(CELLS);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board.grid[r][c];
      if (v !== EMPTY) cells[r * SIZE + c] = v;
    }
  }
  const pos = row * SIZE + col;
  if (cells[pos] !== EMPTY) {
    return { five: false, winCellCount: 0, fours: 0, openThrees: 0, winning: false };
  }
  return analyzeMove(cells, pos, player);
}

function analyzeMove(cells: Uint8Array, pos: number, player: Player): MoveAnalysis {
  cells[pos] = player;
  try {
    if (makesFive(cells, pos, player)) {
      return { five: true, winCellCount: 5, fours: 4, openThrees: 0, winning: true };
    }
    const wc = winCells(cells, pos, player);
    const fours = wc.length > 0 ? countFourDirs(cells, pos, player) : 0;
    let openThrees = 0;
    // 已经成四时就轮不到活三了，省掉这一大块开销
    if (wc.length < 2) {
      for (let d = 0; d < 4; d++) {
        if (dirHasOpenFourNext(cells, pos, player, d)) openThrees++;
      }
    }
    const winning =
      wc.length >= 2 || fours >= 2 || (fours >= 1 && openThrees >= 1) || openThrees >= 2;
    return { five: false, winCellCount: wc.length, fours, openThrees, winning };
  } finally {
    cells[pos] = EMPTY;
  }
}

// ─── 评估 ────────────────────────────────────────────────────────────────────

/**
 * 全盘评估，返回 **player 视角**的分值。
 *
 * 对每条线的每个 5 格窗口：只含 player 的子与空位时加 `W[我方子数]`，只含对手
 * 的子与空位时减 `W[对手子数]`。窗口里同时有两色则一文不值。
 */
function evaluate(cells: Uint8Array, player: Player): number {
  const dMe = DIGIT_AS_ME[player];
  const dOp = DIGIT_AS_ME[otherOf(player)];
  let score = 0;
  for (let li = 0; li < LINES.length; li++) {
    const { start, step, len } = LINES[li];
    // 首个窗口老老实实拼一遍
    let a = 0;
    let b = 0;
    let p = 1;
    for (let k = 0; k < 5; k++) {
      const v = cells[start + k * step];
      a += dMe[v] * p;
      b += dOp[v] * p;
      p *= 3;
    }
    score += WINDOW_TABLE[a] - WINDOW_TABLE[b];
    // 之后滑窗：弹掉最低位、整体除 3、把新格补成最高位（3^4 = 81）。
    // 除 3 一定整除 —— 减掉的正是 k=0 那一项。
    for (let i = 1; i + 5 <= len; i++) {
      a = (a - dMe[cells[start + (i - 1) * step]]) / 3 + dMe[cells[start + (i + 4) * step]] * 81;
      b = (b - dOp[cells[start + (i - 1) * step]]) / 3 + dOp[cells[start + (i + 4) * step]] * 81;
      score += WINDOW_TABLE[a] - WINDOW_TABLE[b];
    }
  }
  return score;
}

/**
 * 走法排序分：`我的局部价值 + 1.05 × 对手的局部价值`。**只用于排序**。
 *
 * 局部价值 = 过该点的所有 5 格窗口查表求和（4 方向 × 5 个偏移 = 20 个窗口），
 * 与 evaluate 同一套权重，所以排序信号与评估口径天然一致，但便宜两个数量级。
 *
 * **两种视角在同一次遍历里算完** —— 窗口集合与视角无关，只有进制数字映射不同。
 * 分开算等于把最热的这个函数白跑两遍。
 */
function orderScore(cells: Uint8Array, pos: number, player: Player): number {
  const dMe = DIGIT_AS_ME[player];
  const dOp = DIGIT_AS_ME[otherOf(player)];
  const r0 = (pos / SIZE) | 0;
  const c0 = pos % SIZE;
  let mine = 0;
  let theirs = 0;
  for (let dir = 0; dir < 4; dir++) {
    const dr = DIRS[dir][0];
    const dc = DIRS[dir][1];
    for (let off = -4; off <= 0; off++) {
      const sr = r0 + off * dr;
      const sc = c0 + off * dc;
      // 窗口是一条直线，只要两个端点都在盘内，中间 3 格必然也在
      if (!inBoard(sr, sc) || !inBoard(sr + 4 * dr, sc + 4 * dc)) continue;
      let a = 0;
      let b = 0;
      let p = 1;
      for (let k = 0; k < 5; k++) {
        const rr = sr + k * dr;
        const cc = sc + k * dc;
        const v = rr === r0 && cc === c0 ? player : cells[rr * SIZE + cc];
        a += dMe[v] * p;
        b += dOp[v] * p;
        p *= 3;
      }
      mine += WINDOW_TABLE[a];
      theirs += WINDOW_TABLE[b];
    }
  }
  return mine + theirs * 1.05;
}

// ─── 搜索 ────────────────────────────────────────────────────────────────────

/**
 * 搜索状态。持有一份扁平的棋盘副本与邻近计数，落子/撤销都成对，
 * 生命周期内不改动调用方的 GomokuBoard —— 这正是「返回时棋盘逐格不变」的来源。
 */
class Search {
  private cells = new Uint8Array(CELLS);
  private near = new Int32Array(CELLS);
  private params: Params;
  private deadline = Infinity;
  private nodeBudget = Infinity;
  private shouldStopFn: (() => boolean) | undefined;
  private stopped = false;
  private checkCountdown = 1024;
  /** 谁在被服务 —— `widthFor` 靠它区分「自己」与「对手」。 */
  private aiPlayer: Player;
  nodes = 0;

  /** 每层复用的候选缓冲，避免热循环里反复分配数组。 */
  private buf: number[][] = [];
  /** 每层复用的排序缓冲（打包值 + 输出），同样是为了不给 GC 添活。 */
  private ordBuf: Array<{ packed: number[]; out: number[] }> = [];

  constructor(params: Params, opts: AiOptions, aiPlayer: Player) {
    this.params = params;
    this.aiPlayer = aiPlayer;
    if (opts.maxNodes !== undefined) {
      this.nodeBudget = opts.maxNodes;
      this.deadline = Infinity;
    }
    if (opts.timeBudgetMs !== undefined) {
      this.deadline = performance.now() + opts.timeBudgetMs;
    } else if (opts.maxNodes === undefined) {
      this.deadline = performance.now() + params.timeBudgetMs;
    }
    this.shouldStopFn = opts.shouldStop;
  }

  loadBoard(board: GomokuBoard): void {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = board.grid[r][c];
        if (v !== EMPTY) {
          const pos = r * SIZE + c;
          this.cells[pos] = v;
          bumpNear(this.near, pos, 1);
        }
      }
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** 候选格：邻近计数 >0 的空格。写进第 layer 层复用的缓冲。 */
  private collect(layer: number): number[] {
    while (this.buf.length <= layer) this.buf.push([]);
    const arr = this.buf[layer];
    arr.length = 0;
    const { near, cells } = this;
    for (let i = 0; i < CELLS; i++) {
      if (near[i] > 0 && cells[i] === EMPTY) arr.push(i);
    }
    return arr;
  }

  /** 根节点候选的对外入口（快路用，不需要排序）。 */
  candidates(): number[] {
    return this.collect(0).slice();
  }

  /** 是否该停下来。每 1024 个节点才查一次时钟，避免热循环里频繁调用。 */
  private aborted(): boolean {
    if (this.stopped) return true;
    if (--this.checkCountdown > 0) return false;
    this.checkCountdown = 1024;
    if (this.nodes >= this.nodeBudget) this.stopped = true;
    else if (performance.now() >= this.deadline) this.stopped = true;
    else if (this.shouldStopFn?.()) this.stopped = true;
    return this.stopped;
  }

  private place(pos: number, player: Player): void {
    this.cells[pos] = player;
    bumpNear(this.near, pos, 1);
  }

  private unplace(pos: number): void {
    this.cells[pos] = EMPTY;
    bumpNear(this.near, pos, -1);
  }

  /** 该空点落子后是否直接成五（落下再撤回）。 */
  private winsBy(pos: number, player: Player): boolean {
    this.place(pos, player);
    const win = makesFive(this.cells, pos, player);
    this.unplace(pos);
    return win;
  }

  // ── L0 ──

  findImmediateWin(cands: readonly number[], player: Player): number {
    for (let i = 0; i < cands.length; i++) {
      if (this.winsBy(cands[i], player)) return cands[i];
    }
    return -1;
  }

  // ── L1 ──

  findWinningMove(cands: readonly number[], player: Player): number {
    for (let i = 0; i < cands.length; i++) {
      if (analyzeMove(this.cells, cands[i], player).winning) return cands[i];
    }
    return -1;
  }

  // ── L2：VCF（连续冲四取胜）──
  //
  // 只搜「我冲四 → 对手唯一应对 → 我再冲四 → …」直到成五。分支极小，但能看见
  // 纯启发式搜索看不到的远处连杀。判失败的三种情形都在这一个函数里：
  //   • 我方这一手没造出四（不是逼着）
  //   • 对手能抢先成五
  //   • 递归下去再也冲不出五

  /** 返回制胜着法，找不到返回 -1。 */
  vcf(player: Player, depth: number): number {
    if (depth <= 0 || this.stopped) return -1;
    const cands = this.collect(20 + depth);
    const opp = otherOf(player);
    for (let i = 0; i < cands.length; i++) {
      const pos = cands[i];
      this.place(pos, player);
      let found = false;

      if (makesFive(this.cells, pos, player)) {
        found = true;
      } else {
        const threats = winCells(this.cells, pos, player);
        if (threats.length > 0) {
          // 我方造出了四 → 对手必须应。但他若能先成五，这条线就废了。
          const oppCands = this.collect(21 + depth);
          if (this.findImmediateWin(oppCands, opp) === -1) {
            if (threats.length >= 2) {
              // 活四：对手一手挡不住
              found = true;
            } else {
              const block = threats[0];
              this.place(block, opp);
              found = this.vcf(player, depth - 1) !== -1;
              this.unplace(block);
            }
          }
        }
      }

      this.unplace(pos);
      if (found) return pos;
      if (this.stopped) return -1;
    }
    return -1;
  }

  // ── L3：迭代加深 Negamax ──

  /**
   * 走法排序：`我的局部价值 + 1.05 × 对手的局部价值`，截取前 width 个。
   *
   * 第二项是关键 —— 老实现只按「我这步能得多少分」排序，完全没算「这步能挡住
   * 对手什么」，挡点被排到后面，alpha-beta 剪枝效率因此很低。
   */
  private orderMoves(player: Player, layer: number, first: number): number[] {
    const cands = this.collect(layer);
    while (this.ordBuf.length <= layer) this.ordBuf.push({ packed: [], out: [] });
    const { packed, out } = this.ordBuf[layer];
    packed.length = 0;
    out.length = 0;
    const n = cands.length;
    if (n === 0) return out;
    for (let i = 0; i < n; i++) {
      const pos = cands[i];
      // **必须取整**：1.05 会引入小数，而下面靠 `% 256` 取回下标 ——
      // 带小数的打包值解出来的坐标是 7.8 这种非法格子。
      const s = Math.round(orderScore(this.cells, pos, player));
      // 打包成 (score + BIAS) * 256 + pos 后按数值倒序排：pos < 256 无损，
      // 省掉比较器闭包与索引数组分配。
      packed.push((s + SORT_BIAS) * 256 + pos);
    }
    packed.sort((a, b) => b - a);
    const width = this.widthFor(layer, player);
    // PV 优先：上一层迭代找到的最佳着法排最前，剪枝收益最大
    if (first >= 0) out.push(first);
    for (let i = 0; i < packed.length && out.length < width; i++) {
      const pos = packed[i] % 256;
      if (pos === first) continue;
      out.push(pos);
    }
    return out;
  }

  /**
   * 每一层的候选宽度。
   *
   * `normal` 全层用同一个宽度 —— 它的定位是「对齐旧的 AI 棋力」，而旧实现就是
   * 深度 4 / 宽度 12 一用到底，收窄会让它比原来更弱。
   *
   * **防守方一律给全部候选，不设上限。** 这不是保守，是正确性要求：只要把防守方
   * 的解招挤出候选表，搜索就会看见一段「对方全程不设防」的连五，报出一个根本
   * 不存在的「必胜」，然后去追那手废棋。实测（hard 对旧 AI）：防守方拿 48 个候选时
   * 整局几乎每一手都报 99999996/99999998 的假杀，0:8 输光；改成不设上限后分数
   * 立刻回到正常的评估值（-3 / 43 / -1057 这种）。
   *
   * **代价很大**：防守方分支动辄上百，节点预算几乎全花在对手身上，同样预算下
   * 自己够得着的深度显著变浅（20000 节点时 hard 实际只到深度 4，与 normal 持平）。
   * 所以 hard 目前**并不比 normal 强**，别把它接进 UI —— 见文件头「已知问题」。
   */
  private widthFor(ply: number, player: Player): number {
    const w = this.params.candidateWidth;
    if (!this.params.narrowByPly) return w;
    if (ply === 0 || player !== this.aiPlayer) return CELLS;
    if (ply <= 2) return Math.max(8, w >> 1);
    return Math.max(5, w >> 2);
  }

  /**
   * 根节点一层搜索。返回 `complete=false` 表示被预算打断，结果不可信 ——
   * 迭代加深要靠这个标志丢弃半截的一层。
   */
  searchRoot(
    aiPlayer: Player,
    depth: number,
    first: number
  ): { pos: number; score: number; complete: boolean } {
    const moves = this.orderMoves(aiPlayer, 0, first);
    let bestPos = moves.length > 0 ? moves[0] : -1;
    let bestScore = -INF;
    let alpha = -INF;
    let complete = true;
    for (let i = 0; i < moves.length; i++) {
      const pos = moves[i];
      this.place(pos, aiPlayer);
      const s = makesFive(this.cells, pos, aiPlayer)
        ? WIN_SCORE
        : -this.negamax(depth - 1, -INF, -alpha, otherOf(aiPlayer), 1);
      this.unplace(pos);
      if (this.stopped) {
        // 被预算打断的一层一律作废，迭代加深会退回上一层的结果。
        // **不能因为「i === 0 时还没评估任何候选」就当它完成** —— 那样
        // bestScore 还停在 -INF，会被当成最佳分采纳（实测过：整手报 -1e9）。
        complete = false;
        break;
      }
      if (s > bestScore) {
        bestScore = s;
        bestPos = pos;
      }
      if (bestScore > alpha) alpha = bestScore;
    }
    return { pos: bestPos, score: bestScore, complete };
  }

  /** Negamax + Alpha-Beta。返回值是**当前走子方视角**的分值。 */
  private negamax(depth: number, alpha: number, beta: number, player: Player, ply: number): number {
    this.nodes++;
    if (this.aborted()) return 0;
    if (depth <= 0) return evaluate(this.cells, player);

    const moves = this.orderMoves(player, ply, -1);
    if (moves.length === 0) return evaluate(this.cells, player);

    let best = -INF;
    for (let i = 0; i < moves.length; i++) {
      const pos = moves[i];
      this.place(pos, player);
      // 越快取胜越好：减去 ply，浅层的胜利分更高
      const s = makesFive(this.cells, pos, player)
        ? WIN_SCORE - ply
        : -this.negamax(depth - 1, -beta, -alpha, otherOf(player), ply + 1);
      this.unplace(pos);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (this.stopped) break;
      if (alpha >= beta) break;
    }
    return best;
  }
}

// ─── 对外入口 ────────────────────────────────────────────────────────────────

/**
 * 求最佳着法。**返回时棋盘恢复原状**（全程只在内部副本上试算）。
 *
 * 空盘返回天元 —— AI 执黑先手时的开局。
 */
export function findBestMove(
  board: GomokuBoard,
  aiPlayer: Player,
  opts: AiOptions = {}
): AiResult {
  const params = PARAMS[opts.difficulty ?? 'normal'];
  const mid = (SIZE / 2) | 0;

  if (board.getHistory().length === 0) {
    return { row: mid, col: mid, score: 0, depth: 0, nodes: 0 };
  }

  const s = new Search(params, opts, aiPlayer);
  s.loadBoard(board);
  const opp = otherOf(aiPlayer);
  const toMove = (pos: number, score: number, depth: number): AiResult => ({
    row: (pos / SIZE) | 0,
    col: pos % SIZE,
    score,
    depth,
    nodes: s.nodes,
  });

  const cands = s.candidates();
  if (cands.length === 0) return { row: mid, col: mid, score: 0, depth: 0, nodes: 0 };

  // L0 —— 一步成五 / 一步挡五
  const myWin = s.findImmediateWin(cands, aiPlayer);
  if (myWin !== -1) return toMove(myWin, WIN_SCORE, 0);
  const oppWin = s.findImmediateWin(cands, opp);
  if (oppWin !== -1) return toMove(oppWin, WIN_SCORE / 2, 0);

  // L1 —— 精确威胁分析：我有必胜手就走；对手有就得抢那个点
  let mustBlock = -1;
  if (params.useThreats) {
    const win = s.findWinningMove(cands, aiPlayer);
    if (win !== -1) return toMove(win, WIN_SCORE, 0);
    mustBlock = s.findWinningMove(cands, opp);
  }

  // L2 —— VCF 连杀。对手有必胜点时也先看一眼：能先杀就不用防守了。
  if (params.useVcf) {
    const v = s.vcf(aiPlayer, VCF_MAX_DEPTH);
    if (v !== -1) return toMove(v, WIN_SCORE, 0);
  }

  if (mustBlock !== -1) return toMove(mustBlock, WIN_SCORE / 2, 0);

  // L3 —— 迭代加深。每完成一层才覆盖结果，预算到点就用上一层的。
  let bestPos = cands[0];
  let bestScore = -INF;
  let reached = 0;
  let pv = -1;
  for (let depth = 2; depth <= params.maxDepth; depth += 2) {
    const r = s.searchRoot(aiPlayer, depth, pv);
    if (!r.complete) break;
    if (r.pos === -1) break;
    bestPos = r.pos;
    bestScore = r.score;
    pv = r.pos;
    reached = depth;
    if (bestScore >= WIN_SCORE / 2) break;
    if (s.isStopped) break;
  }

  // 一层都没跑完（预算极小、或局面大到第一层就超支）：退回根节点的首个候选，
  // 它的分值没有意义，如实报 0，不要把 -INF 当成一个「分数」传出去。
  if (reached === 0) return toMove(bestPos, 0, 0);

  return toMove(bestPos, bestScore, reached);
}
