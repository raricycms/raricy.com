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
import { analyzeMoveAt, findBestMove, type MoveAnalysis } from '@/lib/gomoku-ai';

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

  it('对手有活三时必须应对（困难档）', () => {
    const b = position([
      [7, 5, WHITE], [7, 6, WHITE], [7, 7, WHITE],
      [9, 9, BLACK], [10, 10, BLACK],
    ]);
    const m = findBestMove(b, BLACK, { difficulty: 'hard' });
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
  it('有双活三的必胜点时走它（困难档）', () => {
    const b = position([
      [7, 6, BLACK], [7, 8, BLACK], [6, 7, BLACK], [8, 7, BLACK],
      [12, 12, WHITE], [12, 13, WHITE],
    ]);
    expect(findBestMove(b, BLACK, { difficulty: 'hard' })).toMatchObject({ row: 7, col: 7 });
  });

  // 【已知缺口 · 这里刻意没有测试】四三杀走不出来。
  // 局面：黑在 (5,9)-(6,8)-(7,7) 是眠三（另一端被白 (8,6) 堵），在
  // (6,6)-(7,7)-(8,8) 是活三；走 (4,10) 把眠三变冲四、同时留着那个活三 = 四三杀。
  //
  // 引擎找得到它（靠搜索搜出来的），但 **L1 判不出来**：`analyzeMove` 只统计
  // 「这一手造出/延长」的棋型，而那个活三跟 (4,10) 在同一条线上都不在，属于
  // 「落子之后依然存在的既有威胁」，L1 完全不看。要补这个缺口，L1 得改成统计
  // **落子后全盘**的四与活三，而不是只看经过该点的那几条线。
  //
  // 在那之前不写这条断言 —— 写了就是钉一个还没实现的能力（而且它到底靠 L3 能
  // 不能在默认预算内搜出来，随宽度参数漂移，不是一个稳态断言）。
});

// ─── 3. 不变量 ───────────────────────────────────────────────────────────────

describe('不变量 —— 契约与安全网', () => {
  it('返回时棋盘逐格不变（引擎只在内部副本上试算）', () => {
    const b = position([
      [7, 7, BLACK], [7, 8, WHITE], [6, 8, BLACK], [8, 6, WHITE],
      [6, 6, BLACK], [8, 8, WHITE], [5, 9, BLACK], [9, 5, WHITE],
    ]);
    const before = JSON.stringify(b.grid);
    findBestMove(b, BLACK, { difficulty: 'hard' });
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
      const m = findBestMove(b, BLACK, { difficulty: 'hard' });
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
    const m = findBestMove(b, BLACK, { difficulty: 'hard', shouldStop: () => ++calls > 2 });
    // 中止后仍然必须给出一手合法着法
    expect(b.isValidMove(m.row, m.col)).toBe(true);
  });
});
