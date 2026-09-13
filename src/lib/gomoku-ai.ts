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
// 【为什么着法生成是「威胁驱动」而不是「排序截前 N 名」】
// 这是整套引擎最关键的一处，也是踩过坑的地方。直觉做法是把邻近的候选格交给
// 启发式排序、截前 N 名 —— 但那样**防守方的解招会被挤出候选表**，搜索接着就会
// 看见一段「对方全程不设防」的连五，报出一个根本不存在的必胜，然后去走那手
// 废棋。实测那样配的难度档对旧 AI 八局全败，整局几乎每手都报 99999996 这种假杀分。
//
// 正确的做法是让「哪些点必须考虑」由**精确枚举**给出，而不是靠排序去猜。
// 见 `Search.scanThreats`：一遍全盘窗口扫描就能同时拿到双方的成五点与造四点，
// 而「对手的造四点」正是防守方的解招集合。无条件纳入它，假杀就没了。
//
// 另一半是 `buildMoves` 里那条「威胁点再多也要补满宽度」—— 少了它，威胁一多
// 候选表就被对手的威胁占满，引擎只会挨打、做不出自己的棋（实测：困难档执黑
// 四局全部下到满盘和棋，执白反而四局全胜）。
//
// 实测战绩（每手 2 万节点、先后手各半、8 局）：普通档与困难档都是 **8:0** 胜旧 AI。
//
// 【怎么测棋力 —— 别再踩这个坑】用「胜/负」直接 A/B 本引擎的两个版本是**没有
// 分辨力的**：双方同源时，棋局结果由**开局**决定而不是棋力 —— 一个开局要么黑必胜
// 要么白必胜，两色各下一遍必然 1:1。实测过：同引擎自对弈里黑 100% 全胜；把黑的
// 第一手扔到 (2,2)、白占天元，黑照样 100% 全胜；甚至连给白方 10 秒（对 600ms 的
// 黑）都守不住 —— 那些局面的胜负在开局就定了，加深度救不回来。
// 有效做法是**混一批胜负各半的开局**（见 `scripts/gomoku-selfplay.ts` 的开局表），
// 让强的一方在自己吃亏的一半里也能翻盘；只有「本有悬念」的开局才携带棋力信息。
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLACK as RULES_BLACK,
  BOARD_SIZE,
  EMPTY as RULES_EMPTY,
  WHITE as RULES_WHITE,
  type GomokuBoard,
  type Player,
} from './gomoku-rules';

/**
 * 【为什么抄一份本地常量】具名 import 进来的是**活绑定**，在 CJS/ESM 互操作层上
 * 表现为访问器属性读取，而不是普通变量。这三个常量出现在每节点要跑几百遍的热循环
 * 里（`collect` 扫 225 格、`place`/`unplace`、`buildMoves`），CPU profile 实测
 * 「模块绑定访问」这一项吃掉了 31% 的时间 —— 比棋型扫描还多。转存成模块内的普通
 * const 之后就是一次局部读取。
 *
 * 值仍然来自 gomoku-rules，不是另抄一份字面量，所以不存在 drift。
 */
const BLACK = RULES_BLACK;
const WHITE = RULES_WHITE;
const EMPTY = RULES_EMPTY;

export type Difficulty = 'easy' | 'normal' | 'hard';

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
  /** 默认 'easy'。 */
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

/**
 * `SPAN[dir * CELLS + pos]`：低 4 位是「该方向上还能往回走几步」，高 4 位是
 * 「还能往前走几步」，都截到 4。`orderScore` 靠它一次性划出「经过该点的窗口
 * 起点范围」，省掉热循环里那 20 次边界判断（原实现每个窗口调两次 `inBoard`）。
 */
const SPAN: Uint8Array = (() => {
  const t = new Uint8Array(4 * CELLS);
  for (let dir = 0; dir < 4; dir++) {
    const dr = DIRS[dir][0];
    const dc = DIRS[dir][1];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        let back = 0;
        while (back < 4 && inBoard(r - (back + 1) * dr, c - (back + 1) * dc)) back++;
        let fwd = 0;
        while (fwd < 4 && inBoard(r + (fwd + 1) * dr, c + (fwd + 1) * dc)) fwd++;
        t[dir * CELLS + r * SIZE + c] = back | (fwd << 4);
      }
    }
  }
  return t;
})();

interface Params {
  maxDepth: number;
  candidateWidth: number;
  timeBudgetMs: number;
  /** L1：精确棋型分析 + 双威胁组合。 */
  useThreats: boolean;
  /** L2：VCF 连续冲四连杀。 */
  useVcf: boolean;
}

/**
 * 难度参数表 —— 三档：简单 / 普通 / 困难。
 *
 * `easy` 沿用被替换掉的那套搜索参数（深度 4 / 宽度 12），但**着法生成与评估
 * 都换掉了**，所以它并不等于旧 AI：实测（每手 2 万节点、先后手各半、8 局）
 * 8:0 胜旧 AI。真正拉开差距的是威胁驱动的着法生成，不是深度。
 *
 * `normal` 在此之上开 L1 双威胁与 L2 VCF（会做四三 / 双活三，也会算冲四连杀）。
 *
 * 【关于 timeBudgetMs】搜索每次都会吃满它（迭代加深永远搜不完），所以这个值
 * 就是玩家实际等待的时长。三档都跑在 Web Worker 上，主线程全程空闲 ——
 * **不要把它改回主线程**，那样每走一步整页冻死。
 *
 * 【多给时间到底值多少棋力 —— 上一轮（两档时代）的实测分解】用胜负各半的开局
 * 跑对局（见 `scripts/gomoku-selfplay.ts`，那个文件的注释解释了为什么不能用
 * 「谁赢」直接比同源引擎）：
 *   同一套算法 3s vs 600ms        ≈ 65%（52 局 34:18，p≈0.013）
 *   新引擎 vs 旧引擎（同为 600ms） ≈ 54%（80 局 43:37，p≈0.25，**不显著**）
 * 两条反直觉的结论，改这块之前先看一眼：
 *   1. **时间能买到的棋力有上限**。同一套算法多给 5 倍时间只等于「深度 6 →
 *      深度 8」，对局胜率就停在六成多 —— 这不是碾压，别指望靠加时间完胜。
 *   2. **提速本身不等于变强**。600ms 那档新旧引擎都只搜到深度 6，所以 2.4 倍
 *      的节点吞吐在等时间下换不出多一层，胜率自然没差别。提速只在**恰好跨过
 *      一个深度台阶**的地方兑现。想让提速变成棋力，盯「完成深度」这个量，
 *      别盯节点数。
 *
 * 三档都不加随机扰动：保持确定性，测试与复现才有意义。
 */
const PARAMS: Record<Difficulty, Params> = {
  // 简单：默认档。200ms 一手，开局够快，但仍然认得出跳子棋型与一步成五。
  easy: {
    maxDepth: 4,
    candidateWidth: 12,
    timeBudgetMs: 200,
    useThreats: false,
    useVcf: false,
  },
  // 普通：1s 一手。会主动做双威胁、会算 VCF 连杀、会挡对手的双威胁。
  normal: {
    // 深度上限只是护栏，正常情况下够不着 —— 迭代加深永远吃满时间预算，
    // 真正决定停在哪一层的是预算。**别把它调小**：上限卡得太低会让「多给
    // 时间」重新变得没有意义（那正是上一轮「600ms 与 3s 都是深度 6」的
    // 成因之一）。上限只需低于 `L1_LAYER`。
    maxDepth: 14,
    candidateWidth: 16,
    timeBudgetMs: 1000,
    useThreats: true,
    useVcf: true,
  },
  // 困难：3s 一手。**这一档最终要换上性质不同的算法（VCT 威胁空间搜索），
  // 在那个 commit 落地之前它与「普通」同算法，只是时间多 2 秒。**
  hard: {
    maxDepth: 14,
    candidateWidth: 16,
    timeBudgetMs: 3000,
    useThreats: true,
    useVcf: true,
  },
};

/** VCF 的递归层上限。每层都要落一子，超过这个深度已不现实。 */
const VCF_MAX_DEPTH = 10;

/**
 * 各类搜索占用的 `ThreatLists` 层号基址。**互不重叠是硬要求**：层号相同的两次
 * 扫描拿到的是**同一个数组对象**，递归一深就会把外层正在遍历的列表就地清空。
 * 老实现正是踩了这个坑（`collect(20+depth)` 与外层内层相差 1，递归下去正好
 * 覆盖父层的候选表），所以这里把间距拉开到 20。
 */
const VCF_OUT = 20;
const L1_LAYER = 15;
/**
 * 快路（L1/L2/L2.5）能吃掉的时间比例与节点上限。
 *
 * 【为什么快路必须有独立预算】老实现的 `aborted()` 只在 `negamax` 里被调，而
 * VCF 跑在 L3 **之前**，那时 `this.stopped` 恒为 false —— 也就是说时间预算、
 * 节点预算、`shouldStop` 在 VCF 里**全部失效**，只靠深度上限兜底。病理局面下
 * 这会让「3 秒档」思考到几十秒。有了独立预算之后，快路最多吃掉四成时间，
 * 剩下的留给 L3 搜索，不会出现「快路吃光预算、搜索一步没跑、只好退回随手棋」。
 */
const FAST_BUDGET_FRACTION = 0.4;
const FAST_NODE_BUDGET = 60_000;

/** LMR：排序靠前的这几个着法不减层搜（装着造四点与最有希望的做棋点）。 */
const LMR_FULL_MOVES = 3;

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
 * 一个 5 格窗口对**黑方视角**总分的贡献：只有黑子时 `+W[黑子数]`、只有白子时
 * `-W[白子数]`、空窗口或两色都有时 0。
 *
 * 【为什么可以固定成黑方视角】原来那个逐窗口算 `WINDOW_TABLE[a] - WINDOW_TABLE[b]`
 * 的写法（a 以 player 为「我」、b 以对手为「我」），把两项展开就知道差值只可能是
 * 上面三种之一 —— **与 player 无关**。于是 `evaluate(cells, WHITE)` 恒等于
 * `-evaluate(cells, BLACK)`，增量维护一份黑方视角的累加分就够了，取分时翻符号。
 */
function windowValue(black: number, white: number): number {
  if (black > 0) return white > 0 ? 0 : W[black];
  return white > 0 ? -W[white] : 0;
}

/**
 * 走法排序分：`我的局部价值 + 1.05 × 对手的局部价值`。**只用于排序**。
 *
 * 局部价值 = 过该点的所有 5 格窗口查表求和（4 方向 × 最多 5 个偏移 = 20 个窗口），
 * 与 evaluate 同一套权重，所以排序信号与评估口径天然一致。
 *
 * 【为什么是「一趟读 9 格 + 滑窗」而不是「每个窗口读 5 格」】这是全引擎最热的
 * 函数：`buildMoves` 对**每一个**候选格都要调它一次，中盘上百个候选就是每节点
 * 上万次读取。原实现每个窗口从零拼一遍 5 格（4×5×5 = 100 次读取 + 20 次边界
 * 判断），而同一个方向上相邻窗口有 4 格是重叠的 —— 一次读满 9 格（-4..+4）
 * 之后，沿方向滑动复用（与 evaluate 完全同一套进制滑动），就只剩 13 次读取。
 * 边界也不必再逐窗口判：`SPAN` 预先算好了每个方向能走多远。
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
    const sp = SPAN[dir * CELLS + pos];
    const lo = -(sp & 15);
    const hi = (sp >> 4) - 4;
    // 空区间 = 这个方向上摆不下一个 5 格窗口
    if (lo > hi) continue;
    const dr = DIRS[dir][0];
    const dc = DIRS[dir][1];
    const step = dr * SIZE + dc;
    // 起点窗口老老实实拼一遍 —— 落在 [lo, hi] 里就保证 5 格全在盘内
    let a = 0;
    let b = 0;
    let p = 1;
    for (let k = 0; k < 5; k++) {
      const off = lo + k;
      const v = off === 0 ? player : cells[pos + off * step];
      a += dMe[v] * p;
      b += dOp[v] * p;
      p *= 3;
    }
    mine += WINDOW_TABLE[a];
    theirs += WINDOW_TABLE[b];
    // 之后滑窗：弹掉最低位、整体除 3、把新格补成最高位（3^4 = 81）
    for (let off = lo + 1; off <= hi; off++) {
      const o = off - 1;
      const n = off + 4;
      const vo = o === 0 ? player : cells[pos + o * step];
      const vi = n === 0 ? player : cells[pos + n * step];
      a = (a - dMe[vo]) / 3 + dMe[vi] * 81;
      b = (b - dOp[vo]) / 3 + dOp[vi] * 81;
      mine += WINDOW_TABLE[a];
      theirs += WINDOW_TABLE[b];
    }
  }
  return mine + theirs * 1.05;
}

// ─── 威胁扫描 ────────────────────────────────────────────────────────────────

/**
 * 一次全盘窗口扫描的产出：双方各自的「成五点」与「造四点」。
 *
 * 这四个列表直接就是着法生成的骨架（见 `Search.buildMoves`）—— 有了它们，
 * 「哪些点必须考虑」是**精确枚举**出来的，不靠启发式排序去猜。
 */
interface ThreatLists {
  /** 我方落子即成的点。 */
  meFive: Int32Array;
  /** 我方落子即造出「四」的点（补一格就成五）。 */
  meFour: Int32Array;
  /** 对手落子即成的点 —— 这些是必须堵的。 */
  oppFive: Int32Array;
  /** 对手落子即造出四的点 —— 这些是防守方的解招，一个都不许漏。 */
  oppFour: Int32Array;
  seenMeFive: Int32Array;
  seenMeFour: Int32Array;
  seenOppFive: Int32Array;
  seenOppFour: Int32Array;
  meFiveN: number;
  meFourN: number;
  oppFiveN: number;
  oppFourN: number;
}

/** 按「代」去重地写入，返回新的计数 —— 同一个点会被多条线、多个窗口重复命中。 */
function pushUnique(
  list: Int32Array,
  seen: Int32Array,
  n: number,
  pos: number,
  gen: number
): number {
  if (pos < 0 || seen[pos] === gen) return n;
  seen[pos] = gen;
  list[n] = pos;
  return n + 1;
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
  /** 每层复用的排序缓冲，同样是为了不给 GC 添活。 */
  private rankBufs: number[][] = [];
  /** 每层复用的着法缓冲（`buildMoves` 的产出）。 */
  private moveBufs: number[][] = [];
  /** 每层着法缓冲里「启发式段」的起止下标，见 `buildMoves` 与 LMR。 */
  private heurFrom: number[] = [];
  private heurTo: number[] = [];
  /** 每层的威胁扫描结果。 */
  private threats: ThreatLists[] = [];
  /** 威胁扫描的去重「代」号，每次扫描自增。 */
  private threatGen = 0;
  /**
   * `buildMoves` 用：「这一格已经在候选表里了吗」的 O(1) 判据（配 `moveGen` 代）。
   * 原实现用 `out.includes(pos)`，在「威胁点 + 上百个启发式候选」的循环里是
   * O(n²) 的线性扫。代号的用法与 `pushUnique` 一致：不清理，只比对。
   */
  private inMoves = new Int32Array(CELLS);
  private moveGen = 0;
  /**
   * 全盘窗口累加分，**黑方视角**（`windowValue` 的口径）。由 `place`/`unplace`
   * 增量维护 —— 绝不要直接写 `this.cells[...]`，那会让它与棋盘悄悄失配。
   * 唯一的例外是 `dirHasOpenFourNext` 在 `analyzeMove` 里的临时借位，它在同一
   * 次调用内成对复原，期间不读分。
   */
  private evalSum = 0;
  /** 快路是否已超支（只掐快路，不影响 L3，见 `abortedFast`）。 */
  private fastStopped = false;
  private fastDeadline = Infinity;
  private fastNodeLimit = Infinity;

  private rankBuf(layer: number): number[] {
    while (this.rankBufs.length <= layer) this.rankBufs.push([]);
    return this.rankBufs[layer];
  }

  private moveBuf(layer: number): number[] {
    while (this.moveBufs.length <= layer) this.moveBufs.push([]);
    return this.moveBufs[layer];
  }

  private threatAt(layer: number): ThreatLists {
    while (this.threats.length <= layer) {
      this.threats.push({
        meFive: new Int32Array(CELLS),
        meFour: new Int32Array(CELLS),
        oppFive: new Int32Array(CELLS),
        oppFour: new Int32Array(CELLS),
        seenMeFive: new Int32Array(CELLS),
        seenMeFour: new Int32Array(CELLS),
        seenOppFive: new Int32Array(CELLS),
        seenOppFour: new Int32Array(CELLS),
        meFiveN: 0,
        meFourN: 0,
        oppFiveN: 0,
        oppFourN: 0,
      });
    }
    return this.threats[layer];
  }

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
    // 快路预算（见 `abortedFast`）。时间上取总预算的一个比例；节点上，若调用方
    // 给了 `maxNodes`（测试用的确定性口径）就与它共用 —— 否则快路会绕过那个上限，
    // 把「预算压到 1 个节点，答案只可能来自 L1 快路」这类用例悄悄变成假绿。
    const now = performance.now();
    this.fastDeadline =
      this.deadline === Infinity ? Infinity : now + (this.deadline - now) * FAST_BUDGET_FRACTION;
    this.fastNodeLimit = this.nodeBudget === Infinity ? FAST_NODE_BUDGET : this.nodeBudget;
  }

  loadBoard(board: GomokuBoard): void {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = board.grid[r][c];
        // 走 `place` 而不是直接写 cells —— 这样 evalSum 与 near 的初值由同一条
        // 路径产生，不可能出现「摆子忘了维护增量」那类只有搜索变弱、不报错的 bug。
        if (v !== EMPTY) this.place(r * SIZE + c, v);
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

  /**
   * 快路（L1 / VCF / VCT）专用的预算检查。与 `aborted` 分开的理由见
   * `FAST_BUDGET_FRACTION`：快路超支只该让**快路自己**收手，不该把 L3 搜索也
   * 一起掐掉 —— 那会让引擎退回随手棋。节点同样计进 `this.nodes`，所以
   * `AiResult.nodes` 的口径不变。
   */
  private abortedFast(): boolean {
    this.nodes++;
    if (this.stopped || this.fastStopped) return true;
    // 节点上限**每次都查**（一次整数比较，可以忽略），时钟才按 1024 的节奏查。
    // 两者合在一起按节奏查是错的：`maxNodes: 1` 这种极小预算下，第一次调用时
    // 节点数还落在节拍之外，快路会一路跑下去 —— 那正好废掉「预算压到 1 个节点、
    // 答案只可能来自 L1 快路」这类用例的前提。
    if (this.nodes >= this.fastNodeLimit) {
      this.fastStopped = true;
      return true;
    }
    if ((this.nodes & 1023) !== 0) return false;
    if (performance.now() >= this.fastDeadline) this.fastStopped = true;
    else if (this.shouldStopFn?.()) this.fastStopped = true;
    return this.fastStopped;
  }

  /**
   * 落子 / 撤子时增量维护 `evalSum` —— 返回「过 `pos` 的所有窗口」贡献值的变化量。
   *
   * 【为什么要增量】全盘评估原本要扫 594 个窗口（约 1200 次读取），而它跑在**每个
   * 叶子**上，叶子又占节点总数的大半。改动一格只影响**过该点的窗口** —— 4 个方向、
   * 每个方向最多 5 个窗口包含它（共 ≤20 个），其余窗口的值一个都没变，重算纯属浪费。
   *
   * 【为什么每格只读 4 格】窗口里恰好只有一格会变（`pos` 自己，它在窗口内的偏移是
   * `-o`）。而 `place` 只落在空格上、`unplace` 只撤销自己的子，所以那一格的**旧值
   * 恒为已知**（由 `oldValue` 传入），不必读。
   *
   * 【o 的范围怎么来的】把窗口起点相对 `pos` 的偏移记作 o，窗口覆盖 `o..o+4`；则
   * `pos` 在窗口里 ⟺ `o ∈ [-4, 0]`，窗口不出界 ⟺ `o >= -back` 且 `o + 4 <= fwd`。
   * `SPAN` 存的正是这两个量（各截到 4，截断在这里是安全的：我们本来也只要到 4）。
   */
  private stepEval(pos: number, oldValue: number, newValue: number): number {
    const cells = this.cells;
    let delta = 0;
    for (let dir = 0; dir < 4; dir++) {
      const sp = SPAN[dir * CELLS + pos];
      const back = sp & 15;
      const fwd = sp >> 4;
      const oLo = back >= 4 ? -4 : -back;
      const oHi = fwd >= 4 ? 0 : fwd - 4;
      if (oLo > oHi) continue;
      const step = DIRS[dir][0] * SIZE + DIRS[dir][1];
      for (let o = oLo; o <= oHi; o++) {
        let black = 0;
        let white = 0;
        for (let k = 0; k < 5; k++) {
          if (o + k === 0) continue;
          const v = cells[pos + (o + k) * step];
          if (v === BLACK) black++;
          else if (v === WHITE) white++;
        }
        delta +=
          windowValue(black + (newValue === BLACK ? 1 : 0), white + (newValue === WHITE ? 1 : 0)) -
          windowValue(black + (oldValue === BLACK ? 1 : 0), white + (oldValue === WHITE ? 1 : 0));
      }
    }
    return delta;
  }

  /** 当前局面对 `player` 的评估分（`evalSum` 是黑方视角，见 `windowValue`）。 */
  private evaluateFor(player: Player): number {
    return player === BLACK ? this.evalSum : -this.evalSum;
  }

  private place(pos: number, player: Player): void {
    this.evalSum += this.stepEval(pos, EMPTY, player);
    this.cells[pos] = player;
    bumpNear(this.near, pos, 1);
  }

  private unplace(pos: number): void {
    this.evalSum += this.stepEval(pos, this.cells[pos], EMPTY);
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

  /**
   * 候选里有没有「必胜手」—— 落子后对手一手挡不住。
   *
   * 判据是经典的四条必胜组合，全部走 `analyzeMove` 的精确判定，不吃评估权重：
   *   活四 / 双四（**成五点 ≥2**，对手堵掉一个还剩一个）
   *   四三 / 双活三（两步之后成活的四，对手同样一手挡不住）
   *
   * 【不能用「造四点 ≥2」代替成五点 ≥2】看着像，其实是错的：同一条线上的两个
   * 造四点（比如 `XX_X_`，两个空位都能补成四）每个都只是会被堵掉的冲四，走成
   * 一个冲四、对手挡住、另一个照样被挡，**根本不是杀**。这个错我犯过一次 ——
   * 表现是困难档一路报「必胜」却越走越亏，最后输棋。差别在于：造四点是
   * 「我有几种方式做四」，成五点才是「我有几个点能直接成五」。
   *
   * 【四三 / 双活三为什么要加「对手没有冲四」这道闸】它们两步之后才兑现：
   * 我先造双威胁，对手若能**冲四逼应**，我就得先去挡，威胁被拆掉。对手没有
   * 冲四（`oppFourN === 0`）时它们才是真正无解的 —— 对手只能干看着我把三变成
   * 活四。对手真有冲四的场面交给 L2 的 VCF 去算，这里不越权。
   *
   * 【调用前提】只在对手没有即成五点时才调（`findBestMove` 里 L0 已经先判过），
   * 否则对手会先成五，我这边的活四不作数。
   */
  findWinningMove(cands: readonly number[], player: Player): number {
    for (let i = 0; i < cands.length; i++) {
      const pos = cands[i];
      // `analyzeMove` 自己会落子再撤回，所以必须在 place 之前调（它要求该格为空）
      const a = analyzeMove(this.cells, pos, player);
      // 成五 / 活四 / 双四：对手一手挡不住
      if (a.five || a.winCellCount >= 2) return pos;
      // 四三 / 双活三：同样是必胜手，但**前提是对手没有冲四** —— 他冲四逼应
      // 就能把我的双威胁拆掉。对手真有冲四时该由 L2 的 VCF 去算，这里不越权。
      if (!((a.fours >= 1 && a.openThrees >= 1) || a.openThrees >= 2)) continue;
      this.place(pos, player);
      const t = this.scanThreats(player, L1_LAYER);
      const oppForcing = t.oppFiveN > 0 || t.oppFourN > 0;
      this.unplace(pos);
      if (!oppForcing) return pos;
    }
    return -1;
  }

  // ── L2：VCF（连续冲四取胜）──
  //
  // 只搜「我冲四 → 对手唯一应对 → 我再冲四 → …」直到成五。分支极小，但能看见
  // 纯启发式搜索看不到的远处连杀。
  //
  // 【这一版换掉了候选生成】老实现每个节点扫 225 格收候选，再对每个候选落子 +
  // `winCells` 试一下「是不是冲四」，并且**在候选循环体内**又扫一次 225 格去查
  // 对手能不能成五。现在整件事由一次 `scanThreats` 做完：它产出的 `meFour` 就是
  // 「落子即造四」的点集（3 我/2 空的窗口里的那两个空位），与老实现那个
  // 「落子后 winCells 非空」的判据**逐点等价**，而且一次全盘窗口扫描比
  // 225 格扫描 + 225 次落子试算便宜得多。
  //
  // 【顺带修掉一个真 bug】老实现用 `collect(20+depth)` 取外层候选、递归里用
  // `collect(21+(depth-1))` 取内层 —— 两者是**同一个数组对象**（层号都是 20+depth），
  // 于是递归返回后父层正在遍历的候选表已被就地清空重填，父层接着遍历的是**别人的
  // 候选**。表现为「漏掉一部分连杀」（不会报假杀，因为每个候选仍然要过验证），
  // 属于那种只有棋力变弱、不报错的缺陷。现在层基址间距拉到 20，不再重叠。

  /** 返回制胜着法，找不到返回 -1。 */
  vcf(player: Player, depth: number): number {
    if (depth <= 0 || this.abortedFast()) return -1;
    const t = this.scanThreats(player, VCF_OUT + depth);
    // 轮到我而我能成五 —— 直接赢（递归里这一支是必需的，根节点上层已经判过）
    if (t.meFiveN > 0) return t.meFive[0];

    const opp = otherOf(player);
    const fours = t.meFour;
    const foursN = t.meFourN;
    for (let i = 0; i < foursN; i++) {
      const pos = fours[i];
      // 对手能先成五，这条线就废了 —— 他比我的冲四快一步。
      // 用 `oppFiveLeft` 而不是直接看 `t.oppFiveN`：定理保证**我落子绝不会给
      // 对手造出新的成五点**，所以只需扣掉「我正好占掉的那个」。
      if (this.oppFiveLeft(t, pos) > 0) continue;

      this.place(pos, player);
      const wc = winCells(this.cells, pos, player);
      let found = false;
      if (wc.length >= 2) {
        // 活四 / 双四：对手一手挡不住
        found = true;
      } else if (wc.length === 1) {
        // 冲四：对手只有这一个解招，替他落上再看下一层
        this.place(wc[0], opp);
        found = this.vcf(player, depth - 1) !== -1;
        this.unplace(wc[0]);
      }
      this.unplace(pos);

      if (found) return pos;
      if (this.stopped) return -1;
    }
    return -1;
  }

  /** 我落在 `pos` 之后，对手还剩几个成五点（见 `vcf` 里引用那条定理）。 */
  private oppFiveLeft(t: ThreatLists, pos: number): number {
    for (let i = 0; i < t.oppFiveN; i++) {
      if (t.oppFive[i] === pos) return t.oppFiveN - 1;
    }
    return t.oppFiveN;
  }

  // ── L3：迭代加深 Negamax ──

  /**
   * 扫一遍全盘窗口，产出双方的成五点与造四点。
   *
   * 【为什么一遍窗口扫描就够，不需要棋型识别】窗口是**连续五格**，于是：
   *   • 5 个我方子 + 0 个对方子   → 已成五（调用方负责，这里不收集）
   *   • 4 个我方子 + 1 个空       → 那个空位是**成五点**
   *   • 3 个我方子 + 2 个空       → 两个空位都是**造四点**
   * 「五格里有四个我的子」按定义就是一个四 —— 再补一格必成五，所以那两个空位
   * 都是「落子即造四」的点。跳子、夹心、边角全都自动成立，没有特例。
   *
   * 关键的是这个视角是**全盘**的：它不看「这一手经过了哪条线」，所以对手在
   * 别处布下的三、四一样会被收进 oppFour —— 那正是防守方的解招集合。
   */
  private scanThreats(player: Player, layer: number): ThreatLists {
    const t = this.threatAt(layer);
    t.meFiveN = 0;
    t.meFourN = 0;
    t.oppFiveN = 0;
    t.oppFourN = 0;
    const gen = ++this.threatGen;
    const cells = this.cells;
    for (let li = 0; li < LINES.length; li++) {
      const { start, step, len } = LINES[li];
      for (let i = 0; i + 5 <= len; i++) {
        const base = start + i * step;
        let meN = 0;
        let oppN = 0;
        let e0 = -1;
        let e1 = -1;
        for (let k = 0; k < 5; k++) {
          const pos = base + k * step;
          const v = cells[pos];
          if (v === EMPTY) {
            if (e0 < 0) e0 = pos;
            else if (e1 < 0) e1 = pos;
          } else if (v === player) meN++;
          else oppN++;
        }
        if (oppN === 0) {
          if (meN === 4) {
            t.meFiveN = pushUnique(t.meFive, t.seenMeFive, t.meFiveN, e0, gen);
          } else if (meN === 3) {
            t.meFourN = pushUnique(t.meFour, t.seenMeFour, t.meFourN, e0, gen);
            t.meFourN = pushUnique(t.meFour, t.seenMeFour, t.meFourN, e1, gen);
          }
        }
        if (meN === 0) {
          if (oppN === 4) {
            t.oppFiveN = pushUnique(t.oppFive, t.seenOppFive, t.oppFiveN, e0, gen);
          } else if (oppN === 3) {
            t.oppFourN = pushUnique(t.oppFour, t.seenOppFour, t.oppFourN, e0, gen);
            t.oppFourN = pushUnique(t.oppFour, t.seenOppFour, t.oppFourN, e1, gen);
          }
        }
      }
    }
    return t;
  }

  /**
   * 威胁驱动的着法生成。返回顺序就是优先级：
   *   1. 对手能成五 → **只有挡点**（我方能成五已在调用方判掉，会更早返回）
   *   2. 双方所有「造四点」—— 一个都不许砍
   *   3. 启发式补足到 `candidateWidth`
   *
   * 第 2 条是这套引擎能不能下棋的关键。前一版把候选一律交给启发式排序再截前
   * N 名，于是**防守方的解招被挤出候选表**：搜索接着就会看见一段「对方全程
   * 不设防」的连五，报出一个根本不存在的必胜，然后去走那手废棋。实测那样配的
   * 困难档对旧 AI 八局全败，整局几乎每手都报 99999996 这种假杀分。
   * 把 `oppFour` 无条件纳入之后，解招再也不会被截断，假杀随之消失。
   *
   * 第 1 条顺带把树砍小了：强制挡的分支通常只有 1~3，比按启发式铺开便宜得多。
   */
  private buildMoves(player: Player, ply: number, t: ThreatLists, first: number): number[] {
    const out = this.moveBuf(ply);
    out.length = 0;
    const gen = ++this.moveGen;

    if (t.oppFiveN > 0) {
      for (let i = 0; i < t.oppFiveN; i++) {
        const p = t.oppFive[i];
        if (this.inMoves[p] === gen) continue;
        this.inMoves[p] = gen;
        out.push(p);
      }
      return out;
    }

    for (let i = 0; i < t.meFourN; i++) {
      const p = t.meFour[i];
      if (this.inMoves[p] === gen) continue;
      this.inMoves[p] = gen;
      out.push(p);
    }

    // 启发式补足：**威胁点再多也要补满宽度**，不能写成「没满才补」。
    // 写成「没满才补」时，对手的威胁一多，候选表就被 oppFour 占满，引擎只会
    // 一味挨打、做不出自己的棋 —— 实测表现是困难档执黑 4 局全部下到满盘和棋
    // （执白反而 4 局全胜、52 手结束，因为后手本来就该以应对为主）。
    //
    // 这一段的下标记下来给 LMR 用：**只有启发式着法允许减层搜**。减到威胁着法
    // 头上就等于把防守方的解招剪掉，假杀会立刻回来。
    const width = this.params.candidateWidth;
    this.heurFrom[ply] = out.length;
    const packed = this.rankBuf(ply);
    packed.length = 0;
    const { near, cells } = this;
    // 与 `collect` 融合成一个 225 格的全扫：省掉一个中间数组，也省一遍遍历
    for (let i = 0; i < CELLS; i++) {
      if (near[i] > 0 && cells[i] === EMPTY && this.inMoves[i] !== gen) {
        // **必须取整**：1.05 会引入小数，而下面靠 `% 256` 取回下标 ——
        // 带小数的打包值解出来的坐标是 7.8 这种非法格子。
        const s = Math.round(orderScore(cells, i, player));
        packed.push((s + SORT_BIAS) * 256 + i);
      }
    }
    packed.sort((a, b) => b - a);
    for (let i = 0; i < packed.length && out.length < width; i++) {
      const p = packed[i] % 256;
      this.inMoves[p] = gen;
      out.push(p);
    }
    this.heurTo[ply] = out.length;

    // 对手的造四点：**一个都不许漏**，这是不产生假杀的关键。排在最后是为了
    // 不挤占做棋的名额 —— 顺序不影响正确性，alpha-beta 的剪枝只会剪掉更差的
    // 着法，而假杀来自「根本没生成」，不来自「生成后被剪」。
    for (let i = 0; i < t.oppFourN; i++) {
      const p = t.oppFour[i];
      if (this.inMoves[p] === gen) continue;
      this.inMoves[p] = gen;
      out.push(p);
    }

    // PV 优先：上一层迭代找到的最佳着法排最前，剪枝收益最大。
    // 放在最后做，免得它占掉一个名额。多搜一手不会带来假杀（假杀来自**漏搜**
    // 解招），所以即使它不在候选集里也值得先搜。
    if (first >= 0) {
      const at = out.indexOf(first);
      if (at > 0) out.splice(at, 1);
      out.unshift(first);
    }
    return out;
  }

  /**
   * 对手在 `m` 落子之后，**还有没有**即成五点 —— 也就是轮到对手时他能不能立刻成五。
   *
   * 【为什么这是个 O(1) 的问题】一条定理：**我方落子绝不会给对手造出新的成五点**。
   * 因为「对手的成五点 c」要求某个 5 格窗口里已经有 4 个对手子、c 空着 —— 该窗口
   * 已经没有别的空位了，所以它不可能包含我刚落的那一子。于是对手的成五点集合
   * 只会**减少**，减少的唯一方式就是我正好占掉其中一个。
   *
   * 这条定理让「叶节点是否被将杀」不必再扫一遍全盘：父节点本来就算过对手的成五
   * 点（`scanThreats` 一次给出双方），这里只需看看除了 `m` 之外还剩没剩。
   */
  private oppFiveSurvives(t: ThreatLists, m: number): boolean {
    for (let i = 0; i < t.oppFiveN; i++) {
      if (t.oppFive[i] !== m) return true;
    }
    return false;
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
    const t = this.scanThreats(aiPlayer, 0);
    // 轮到我而我能成五 → 直接就是这一手
    if (t.meFiveN > 0) return { pos: t.meFive[0], score: WIN_SCORE, complete: true };
    const moves = this.buildMoves(aiPlayer, 0, t, first);
    let bestPos = moves.length > 0 ? moves[0] : -1;
    let bestScore = -INF;
    let alpha = -INF;
    let complete = true;
    for (let i = 0; i < moves.length; i++) {
      const pos = moves[i];
      const childCanWin = this.oppFiveSurvives(t, pos);
      this.place(pos, aiPlayer);
      const s = makesFive(this.cells, pos, aiPlayer)
        ? WIN_SCORE
        : -this.negamax(depth - 1, -INF, -alpha, otherOf(aiPlayer), 1, childCanWin);
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

  /**
   * Negamax + Alpha-Beta。返回值是**当前走子方视角**的分值。
   *
   * `canWinNow` = 「本节点的走子方现在就能成五」，由父节点用 `oppFiveSurvives` 算好
   * 传下来。它只在 `depth <= 0` 那一支用得上，但那一支正是**地平线**：如果叶子不
   * 知道对手下一步就能成五，整棵搜索的偶数层深度就都白加了 —— 每一条线的最末端
   * 都是瞎的，白方尤其吃亏（防守全靠看清对方下一手能不能成五）。老实现就是
   * `depth <= 0` 直接 `evaluate`，实测同等算力下白方守不住任何一条杀棋。
   *
   * 【为什么不让叶子自己扫一遍】`scanThreats` 要扫全盘 594 个窗口，而叶子占了
   * 节点总数的大半 —— 那样等于凭空多出一大块开销。父节点本来就已经算出对手的
   * 成五点了，传下来是免费的。
   */
  private negamax(
    depth: number,
    alpha: number,
    beta: number,
    player: Player,
    ply: number,
    canWinNow: boolean
  ): number {
    this.nodes++;
    if (this.aborted()) return 0;
    // 地平线：走子方立刻能成五，就不该再看静态分了
    if (depth <= 0) return canWinNow ? WIN_SCORE - ply : this.evaluateFor(player);

    const t = this.scanThreats(player, ply);
    // 轮到我了而我能成五 —— 这一层就赢了，不必再往下搜。
    // 这比「落子后检查 makesFive」更早一步，顺便把成五的树砍掉一大块。
    if (t.meFiveN > 0) return WIN_SCORE - ply;

    const moves = this.buildMoves(player, ply, t, -1);
    if (moves.length === 0) return this.evaluateFor(player);

    let best = -INF;
    for (let i = 0; i < moves.length; i++) {
      const pos = moves[i];
      // 后续着法先按减两层搜（LMR）：它们本来就被排序排在后面，多半不会好过
      // 前面那些；真要是好过，下面会以完整深度重搜一遍。
      // **只减启发式那一段**（`heurFrom..heurTo`）—— 威胁着法（我的造四点、
      // 对手的造四点）一律全深度，减到它们头上就等于把防守方的解招剪掉。
      const reduced =
        depth >= 3 && i >= this.heurFrom[ply] && i < this.heurTo[ply] && i >= LMR_FULL_MOVES
          ? depth - 2
          : depth - 1;

      const childCanWin = this.oppFiveSurvives(t, pos);
      this.place(pos, player);
      // 越快取胜越好：减去 ply，浅层的胜利分更高
      let s = makesFive(this.cells, pos, player)
        ? WIN_SCORE - ply
        : -this.negamax(reduced, -beta, -alpha, otherOf(player), ply + 1, childCanWin);
      // 减层搜出来的着法若真的超过 alpha，就按原深度重搜，免得误剪
      if (reduced < depth - 1 && s > alpha) {
        s = -this.negamax(depth - 1, -beta, -alpha, otherOf(player), ply + 1, childCanWin);
      }
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
  const params = PARAMS[opts.difficulty ?? 'easy'];
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
