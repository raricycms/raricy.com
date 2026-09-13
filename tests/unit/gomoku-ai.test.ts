// ─────────────────────────────────────────────────────────────────────────────
// gomoku-ai.test.ts —— 五子棋人机对战引擎。
//
// 【为什么要有这份测试】AI 引擎在此之前**一个单测都没有**：它作为
// `class GomokuAI` 埋在 GomokuLocal.tsx 里，在 node 下跑不起来。引擎抽到
// src/lib/gomoku-ai.ts 之后才第一次可测 —— 这份文件是那次抽取的主要收益。
//
// 【测什么】三层，从细到粗：
//   1. 棋型判定 —— 逐条模式的表驱动，钉住「活四 / 冲四 / 活三 / 边界」的口径。
//      重点是**跳子**：`..X_XX..` 一步能到活四，老实现把它拆成两段数，判不出来。
//   2. 战术题库 —— 给定局面，AI 必须走出正确的一手（成五 / 挡五 / 双三取胜 / 四三杀）。
//   3. 不变量 —— 「不能犯的错」的安全网：能成五必须成五、永不走非法着法、
//      返回时棋盘必须原封不动。这几条比单个局面耐用得多。
//
// 【不测什么】不测具体分值、不测搜索深度、不测耗时。仓库没有墙钟断言的先例
// （慢用例一律靠降规模而不是放宽阈值），搜索规模也用固定节点数而不是时间来钉。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  BLACK,
  GomokuBoard,
  WHITE,
  type Player,
} from '@/lib/gomoku-rules';
import { analyzeMoveAt, findBestMove, type Difficulty, type MoveAnalysis } from '@/lib/gomoku-ai';

// ─── 摆局面的辅助 ────────────────────────────────────────────────────────────
// `.` 空、`X` 黑、`O` 白、`_` 待分析的空点。
// 片段一律**居中**摆放（15 格时贴边），这样片段边缘不会被误当成棋盘边缘 ——
// 要测边界就得显式写满 15 格。

const CENTER = 7;

function place(b: GomokuBoard, row: number, col: number, ch: string): void {
  if (ch === 'X') b.placeStone(row, col, BLACK);
  else if (ch === 'O') b.placeStone(row, col, WHITE);
}

/**
 * 由 ASCII 片段摆出局面，返回棋盘与 `_` 所在的坐标。
 * `_` 必须**有且只有一个** —— 曾经因为对每个 `_` 都赋值而把边界用例的洞
 * 定位到了片段末尾，静默测了另一个点。
 */
function layout(rows: string[]): { board: GomokuBoard; hole: [number, number] } {
  const b = new GomokuBoard();
  const top = rows.length === 15 ? 0 : CENTER - Math.floor(rows.length / 2);
  const holes: Array<[number, number]> = [];
  rows.forEach((row, i) => {
    const left = row.length === 15 ? 0 : CENTER - Math.floor(row.length / 2);
    [...row].forEach((ch, j) => {
      if (ch === '_') holes.push([top + i, left + j]);
      else place(b, top + i, left + j, ch);
    });
  });
  if (holes.length !== 1) throw new Error(`片段里要恰好一个 \`_\`，实际 ${holes.length} 个`);
  return { board: b, hole: holes[0] };
}

/** 分析「在 `_` 处落 player 的子」会造出什么。 */
function analyze(rows: string[], player: Player = BLACK): MoveAnalysis {
  const { board, hole } = layout(rows);
  return analyzeMoveAt(board, hole[0], hole[1], player);
}

/** 这一手落下后是否直接成五（落完即撤，不改棋盘）。 */
function winsByPlaying(board: GomokuBoard, row: number, col: number, player: Player): boolean {
  // 不是空格就抛 —— 否则 placeStone 静默失败、undo 撤掉的是别的子
  if (!board.isValidMove(row, col)) throw new Error(`(${row},${col}) 不是空格`);
  const history = board.getHistory().length;
  board.placeStone(row, col, player);
  const won = board.checkWinAt(row, col, player).won;
  board.undo();
  if (board.getHistory().length !== history) throw new Error('棋盘没还原');
  return won;
}

// ─── 1. 棋型判定 ─────────────────────────────────────────────────────────────

describe('棋型判定 —— 活四与冲四', () => {
  it('两端皆空的四连，补上第四子就是活四（两个成五点）', () => {
    const a = analyze(['..XXX_']);
    expect(a.winCellCount).toBe(2);
    expect(a.winning).toBe(true);
  });

  it('一端被对方堵死的四连只是冲四（一个成五点），不构成必胜手', () => {
    const a = analyze(['OXXX_']);
    expect(a.winCellCount).toBe(1);
    expect(a.winning).toBe(false);
  });

  it('棋盘边上没有「活四」—— 边界就是封堵', () => {
    // 片段写满 15 格才会贴边；居中摆放时左右都还有空位，测不出边界
    const a = analyze(['XXX_...........']);
    expect(a.winCellCount).toBe(1);
    expect(a.winning).toBe(false);
  });
});

describe('棋型判定 —— 跳子（旧实现在这里判错）', () => {
  // 这是整套重写最直接的动机：`..X.XX..` 在中间补一手就是 `..XXXX..`，
  // 两端皆空 = 活四。老实现只数连续段，把它看成一个孤子和一个二。
  it('`..X_XX..` 补中间那手直接成活四', () => {
    const a = analyze(['..X_XX..']);
    expect(a.winCellCount).toBe(2);
    expect(a.winning).toBe(true);
  });

  it('夹心四（差的是中间那格）同样算四', () => {
    // `OX_XX.` 补上中间那格就是 `OXXXX.` —— 左端被堵，成五点只剩右端一个。
    // 左边必须真的放个 `O`：片段是居中摆放的，留 `.` 的话棋盘上那边还是空的，
    // 补中间那手就成了活四。
    const a = analyze(['OX_XX.']);
    expect(a.winCellCount).toBe(1);
    expect(a.winning).toBe(false);
  });
});

describe('棋型判定 —— 活三与双活三', () => {
  it('两端皆空的三算活三，但不是必胜手', () => {
    const a = analyze(['..XX_']);
    expect(a.winCellCount).toBe(0);
    expect(a.openThrees).toBe(1);
    expect(a.winning).toBe(false);
  });

  it('一手同时造出两个方向的活三 = 双活三，是必胜手', () => {
    // 十字：中心补一手，横竖各成一个活三，对手只能挡一边
    const a = analyze(['.X.', 'X_X', '.X.']);
    expect(a.openThrees).toBe(2);
    expect(a.winning).toBe(true);
  });

  it('只有一个方向成三时不叫双活三', () => {
    const a = analyze(['.X.', 'X_X', '...']);
    expect(a.openThrees).toBe(1);
    expect(a.winning).toBe(false);
  });

  // 【跨方向串味的回归网】`dirHasOpenFourNext` 的契约是「只看 dir 这一个方向」，
  // 但实现曾经调的是**四方向**版的 `winCells`。而 `analyzeMove` 进到这个循环时
  // （`wc.length < 2`）全局恰好最多只有 1 个成五点 —— 那唯一的一个如果来自
  // **别的方向**，就会串到本方向头上：本方向补一子只是个冲四（1 个成五点），
  // 加上别处那个「1」就凑成 2，眠三被当成了活三。
  //
  // 下面这个局面正是那个形状：竖线是冲四、横线是眠三，看起来像「四三必胜手」，
  // 但四三必须由**活三**构成，眠三不算数。
  it('另一个方向已有的成五点，不许把本方向的冲四凑成活三', () => {
    const a = analyze([
      '...X...', // 竖线：黑 4,5,6 行
      '...X...',
      '...X...',
      'OXX_...', // 横线：白在左端堵死，黑 5,6 列，`_` 是待分析的 (7,7)
      '...O...', // 竖线下方被白堵死 —— 于是竖线只剩 (3,7) 一个成五点
      '.......',
      '.......',
    ]);
    expect(a.winCellCount).toBe(1); // 竖线那一个成五点
    expect(a.fours).toBe(1); // 只有竖线成四
    expect(a.openThrees).toBe(0); // 横线是眠三；串味的话这里会是 1
    expect(a.winning).toBe(false); // 所以「四三」不成立，没有必胜手
  });
});

// ─── 2. 战术题库 ─────────────────────────────────────────────────────────────

/** 简易局面构造：直接给一串 [行, 列, 黑|白]。 */
function position(cells: Array<[number, number, Player]>): GomokuBoard {
  const b = new GomokuBoard();
  for (const [r, c, p] of cells) b.placeStone(r, c, p);
  return b;
}

describe('战术题库 —— 快路', () => {
  it('空盘走天元（AI 执黑先手的开局）', () => {
    expect(findBestMove(new GomokuBoard(), BLACK)).toMatchObject({ row: 7, col: 7 });
  });

  it('能一步成五时必须成五', () => {
    const b = position([
      [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK],
      [9, 9, WHITE],
    ]);
    const m = findBestMove(b, BLACK);
    expect(winsByPlaying(b, m.row, m.col, BLACK)).toBe(true);
  });

  it('对手的冲四（一端已被堵）必须挡在唯一的成五点', () => {
    // 白四连的左边被黑 (7,2) 堵住 → 只剩 (7,7) 一个成五点，必须占住。
    // 注意不能用**活四**来测：两端皆空的四连是挡不住的，一手只能堵一边。
    const b = position([
      [7, 2, BLACK],
      [7, 3, WHITE], [7, 4, WHITE], [7, 5, WHITE], [7, 6, WHITE],
      [9, 9, BLACK],
    ]);
    expect(findBestMove(b, BLACK)).toMatchObject({ row: 7, col: 7 });
  });

  it('对手有活三时必须应对（普通档）', () => {
    const b = position([
      [7, 5, WHITE], [7, 6, WHITE], [7, 7, WHITE],
      [9, 9, BLACK], [10, 10, BLACK],
    ]);
    const m = findBestMove(b, BLACK, { difficulty: 'normal' });
    // 白方走完这一手后应该拿不到活四
    b.placeStone(m.row, m.col, BLACK);
    for (let c = 3; c <= 9; c++) {
      if (b.isValidMove(7, c)) {
        const a = analyzeMoveAt(b, 7, c, WHITE);
        expect(a.winCellCount, `白在 (7,${c}) 能成活四`).toBeLessThan(2);
      }
    }
  });
});

describe('战术题库 —— 双威胁', () => {
  /** 十字形：黑在 (7,6)(7,8)(6,7)(8,7)，补 (7,7) 同时成两个活三。 */
  const doubleThree = () =>
    position([
      [7, 6, BLACK], [7, 8, BLACK], [6, 7, BLACK], [8, 7, BLACK],
      [12, 12, WHITE], [12, 13, WHITE],
    ]);

  // 【为什么把预算压到 1 个节点】这是在钉 **L1 快路本身**，不是钉搜索。
  // 双活三要三步才兑现（补活四 → 对手挡一端 → 成五），深搜也能找到 —— 用默认
  // 预算测的话，L1 整个删掉这条用例照样绿。预算压到 1 之后搜索一步都跑不动，
  // 走出来的着法只可能来自 L1 的组合判据（四三 / 双活三）。
  it('双活三由 L1 快路直接认出来（搜索预算压到 1）', () => {
    const m = findBestMove(doubleThree(), BLACK, { difficulty: 'normal', maxNodes: 1 });
    // **分值才是这条用例的判据，不是落点**。预算耗尽时引擎退回根节点排序第一的
    // 候选，而 (7,7) 的局部价值本来就最高 —— 光断言落点的话，L1 整块删掉照样绿
    // （实测过：旧引擎在这里也返回 (7,7)，但分值是 0）。
    expect(m).toMatchObject({ row: 7, col: 7 });
    expect(m.score).toBe(100_000_000);
  });

  it('对手的双活三点必须去占掉', () => {
    // 同一个局面换成白方走：白必须抢 (7,7)，否则黑补上就是双活三。
    const m = findBestMove(doubleThree(), WHITE, { difficulty: 'normal', maxNodes: 1 });
    // 【这里曾经还断言 `m.score === 50_000_000`】那条断言钉的是「L1 快路直接返回」
    // 这个**实现细节**。现在挡点不再直接返回、而是交给搜索（见 `findBestMove` 里
    // 关于 mustBlock 的注释），分值自然变成搜索值 —— 断言细节就废了。
    // 留下的是真正要守的性质：**白必须占住那个点**。
    expect(m).toMatchObject({ row: 7, col: 7 });
  });

  it('对手的跳活三（三子中间留空）必须被化解：走完白做不出活四', () => {
    // 白在 (7,5)(7,7)(7,8)，空档 (7,6)。白补上就是 `_OOOO_` 活四，挡不住 ——
    // 黑必须化解。这是老引擎完全看不见的形状：它只数连续子，会把 (7,5) 和
    // (7,7)(7,8) 看成一段孤子和一个二。
    //
    // **断言的是性质，不是某一格**：占空档 (7,6) 能化解，但先堵住一端
    // （(7,4) 或 (7,9)）同样能 —— 那样白补 (7,6) 只剩一个成五点，是个冲四。
    // 原先钉死 (7,6) 是因为快路总是返回那一格，属于把实现细节写进了期望值。
    const b = position([
      [7, 5, WHITE], [7, 7, WHITE], [7, 8, WHITE],
      [5, 5, BLACK], [9, 9, BLACK],
    ]);
    const m = findBestMove(b, BLACK, { difficulty: 'normal' });
    b.placeStone(m.row, m.col, BLACK);
    for (let c = 3; c <= 10; c++) {
      if (b.isValidMove(7, c)) {
        const a = analyzeMoveAt(b, 7, c, WHITE);
        expect(a.winCellCount, `黑走完 (${m.row},${m.col}) 后白在 (7,${c}) 仍能成活四`).toBeLessThan(2);
      }
    }
  });

  it('平静局面不会报出「必胜」（宽度截断出假杀的回归）', () => {
    // 历史上着法生成按启发式截前 N 名，防守方的解招会被挤出候选表，搜索于是
    // 看见一段「对方全程不设防」的连五，报出根本不存在的必胜，接着去走废棋。
    // 表现就是分值贴着 WIN_SCORE。这里钉住「平静局面不许出现必胜分」。
    const b = position([
      [7, 7, BLACK], [7, 9, WHITE], [5, 3, BLACK],
      [9, 5, WHITE], [3, 7, BLACK], [11, 9, WHITE],
    ]);
    const m = findBestMove(b, BLACK, { difficulty: 'normal', maxNodes: 20000 });
    // 5e7 是「挡住对手成五」那条快路使用的分值，必胜手是 1e8
    expect(m.score, `报出了 ${m.score}，像是假杀`).toBeLessThan(50_000_000);
    expect(b.isValidMove(m.row, m.col)).toBe(true);
  });
});

describe('算杀层 —— 两档都不许在平静局面报假杀', () => {
  /** 5 万是「挡住对手成五」那条快路的分值，必胜手是 1 亿。 */
  const NOT_A_WIN = 50_000_000;

  /**
   * 撒在 3 的整数倍格点上的散局。
   *
   * 【为什么用格点而不是随机撒】要让这条用例**永远不会因为局面本身有杀而假红**。
   * 任意两子的切比雪夫距离恒为 3 ⇒ 任何 5 格窗口里最多两子 ⇒ 局面里不可能有
   * 成五、四、活三。于是「引擎报出 ≥5 万」就只可能来自算杀层看走了眼，
   * 不可能是它真找到了什么。
   */
  function scattered(seed: number): GomokuBoard {
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const spots: Array<[number, number]> = [];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) spots.push([3 + 3 * a, 3 + 3 * b]);
    // Fisher–Yates，种子固定 → 局面可复现
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const b = new GomokuBoard();
    spots.slice(0, 6).forEach(([r, c], i) => b.placeStone(r, c, i % 2 === 0 ? BLACK : WHITE));
    return b;
  }

  // 【这条守的是什么】VCT 的判胜条件是「对手的解招集是空的」。**漏掉任何一个
  // 守方解招，就会报出根本不存在的必胜**，然后拿它去走废棋 —— 历史上
  // `buildMoves` 截断 `oppFour` 就是这么让困难档对旧 AI 八局全败的。
  // 两档一起扫：VCF 与 VCT 走的是同一套判胜结构（VCT 目前两档都没开，但用例留着，
  // 重新启用时不会缺守卫）。
  it('无杀局面里报出的分值不许够到「必胜」', () => {
    const tiers: Difficulty[] = ['easy', 'normal'];
    const bad: string[] = [];
    for (let seed = 1; seed <= 3; seed++) {
      for (const p of [BLACK, WHITE] as Player[]) {
        for (const d of tiers) {
          const m = findBestMove(scattered(seed), p, { difficulty: d, maxNodes: 30_000 });
          if (m.score >= NOT_A_WIN) {
            bad.push(`seed=${seed} 档=${d} 执=${p === BLACK ? '黑' : '白'} 报 ${m.score}`);
          }
        }
      }
    }
    expect(bad, `这些局面报出了必胜分：\n${bad.join('\n')}`).toEqual([]);
  });
});

// ─── 3. 不变量 ───────────────────────────────────────────────────────────────

describe('不变量 —— 契约与安全网', () => {
  it('返回时棋盘逐格不变（引擎只在内部副本上试算）', () => {
    const b = position([
      [7, 7, BLACK], [7, 8, WHITE], [6, 8, BLACK], [8, 6, WHITE],
      [6, 6, BLACK], [8, 8, WHITE], [5, 9, BLACK], [9, 5, WHITE],
    ]);
    const before = JSON.stringify(b.grid);
    findBestMove(b, BLACK, { difficulty: 'normal' });
    expect(JSON.stringify(b.grid)).toBe(before);
    expect(b.getHistory()).toHaveLength(8);
  });

  it('永远走空格，绝不走非法着法', () => {
    const b = new GomokuBoard();
    const players: Player[] = [BLACK, WHITE];
    let turn = 0;
    for (let i = 0; i < 12; i++) {
      const p = players[turn];
      const m = findBestMove(b, p, { maxNodes: 3000 });
      expect(m.row, `第 ${i} 手越界`).toBeGreaterThanOrEqual(0);
      expect(m.row).toBeLessThan(15);
      expect(m.col).toBeGreaterThanOrEqual(0);
      expect(m.col).toBeLessThan(15);
      expect(b.isValidMove(m.row, m.col), `第 ${i} 手落在已占位 (${m.row},${m.col})`).toBe(true);
      b.placeStone(m.row, m.col, p);
      if (b.checkWinAt(m.row, m.col, p).won) break;
      turn = 1 - turn;
    }
  });

  it('能给多少必胜局面就抓多少：能成五必须成五', () => {
    // 四个方向、若干位置各造一个「只差一格」的局面，逐一验证
    const cases: Array<Array<[number, number, Player]>> = [
      [[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]],
      [[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK]],
      [[3, 3, BLACK], [4, 4, BLACK], [5, 5, BLACK], [6, 6, BLACK]],
      [[3, 11, BLACK], [4, 10, BLACK], [5, 9, BLACK], [6, 8, BLACK]],
      // 跳四：差的是中间那一格
      [[7, 2, BLACK], [7, 3, BLACK], [7, 4, BLACK], [7, 6, BLACK]],
    ];
    for (const cells of cases) {
      const b = position(cells);
      const m = findBestMove(b, BLACK, { difficulty: 'normal' });
      expect(
        winsByPlaying(b, m.row, m.col, BLACK),
        `局面 ${JSON.stringify(cells)} 走成了 (${m.row},${m.col})，没成五`
      ).toBe(true);
    }
  });

  it('节点预算是确定性的（同参数两次调用结果一致）', () => {
    const mk = (): GomokuBoard =>
      position([
        [7, 7, BLACK], [7, 9, WHITE], [5, 3, BLACK], [9, 5, WHITE],
        [3, 7, BLACK], [11, 9, WHITE],
      ]);
    const a = findBestMove(mk(), BLACK, { maxNodes: 4000 });
    const b = findBestMove(mk(), BLACK, { maxNodes: 4000 });
    expect(a).toEqual(b);
  });

  it('shouldStop 被尊重（用来在局面被重置时收手）', () => {
    const b = position([
      [7, 7, BLACK], [7, 9, WHITE], [5, 3, BLACK], [9, 5, WHITE],
      [3, 7, BLACK], [11, 9, WHITE],
    ]);
    let calls = 0;
    const m = findBestMove(b, BLACK, { difficulty: 'normal', shouldStop: () => ++calls > 2 });
    // 中止后仍然必须给出一手合法着法
    expect(b.isValidMove(m.row, m.col)).toBe(true);
  });
});
