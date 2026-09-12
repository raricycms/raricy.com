// ─────────────────────────────────────────────────────────────────────────────
// xiangqi-rules.test.ts —— 中国象棋规则的**正确性钉子**
//
// 【perft 是主角】单条用例只能验证"你想得到的情形"；规则写错的典型形态是某条规则
// **整体**写错（炮能落空格越过炮架、象过河、兵倒退），而这类错误几乎必然让整棵走法
// 树的节点数偏离通行值。下面三组数字对不上就是规则错了，**不要去改期望值**。
//
// 本次就靠它抓到一个真错误：炮在翻过炮架之后还能落到空格上（开局 perft 因此是
// 48 而不是 44）。
//
// 【数字来源】中国象棋 perft 的通行值（象棋巫师 / ElephantEye 等引擎与多个开源
// 实现一致）：开局 44 / 1920 / 79666 / 3290240。
// 第 4 层要 8 秒，不进 CI（第 3 层 0.2 秒已能区分绝大多数规则错误）。
//
// 【摆测试局面时的坑】两个王**不能在同一直线上照面**（飞将），否则那整个局面就是
// 非法的 —— 任何着法都会被 legality 过滤掉，测试会以"一个着法都没有"的形式失败，
// 看起来像走法生成坏了。所以下面的局面一律把两个王错开列：红王放 (9,3)、
// 黑王放 (0,5)。只有"飞将"那一组**故意**把它们摆在同一列上。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  CANNON,
  CHARIOT,
  ELEPHANT,
  EMPTY,
  KING,
  PAWN,
  RED,
  XiangqiBoard,
  colorOf,
  glyphOf,
  piece,
  typeOf,
  type Color,
} from '@/lib/xiangqi-rules';
import type { MoveInput, Square } from '@/lib/board-shared';

/** 两个王错开列的"空盘"，供下面拼局面用。 */
const RED_K = '3K5'; // 红王 (9,3)
const BLACK_K = '5k3'; // 黑王 (0,5)

function board(fen?: string): XiangqiBoard {
  const b = new XiangqiBoard();
  if (fen) b.loadFen(fen);
  return b;
}

function play(b: XiangqiBoard, from: Square, to: Square) {
  const outcome = b.submit(b.turn, { path: [from, to] });
  if (!outcome) throw new Error(`预期合法却被拒：${from} → ${to}`);
  return outcome;
}

/** 某个子能走到哪些格子（只数这个子的着法）。 */
function targets(b: XiangqiBoard, color: Color, from: Square): string[] {
  return b
    .generateMoves(color)
    .filter((m) => m.path[0][0] === from[0] && m.path[0][1] === from[1])
    .map((m) => `${m.path[1][0]},${m.path[1][1]}`)
    .sort();
}

function snapshot(b: XiangqiBoard): string {
  return JSON.stringify({
    grid: b.grid,
    turn: b.turn,
    noCapture: b.noCapture,
    last: b.getLastMove(),
  });
}

describe('中国象棋：编码与开局', () => {
  it('棋子编码红 1..7 / 黑 9..15，红黑用不同的字', () => {
    expect(piece(RED, CHARIOT)).toBe(5);
    expect(piece(BLACK, CHARIOT)).toBe(13);
    expect(colorOf(5)).toBe(RED);
    expect(colorOf(13)).toBe(BLACK);
    expect(typeOf(13)).toBe(CHARIOT);
    expect(glyphOf(piece(RED, KING))).toBe('帥');
    expect(glyphOf(piece(BLACK, KING))).toBe('將');
    expect(glyphOf(piece(RED, ELEPHANT))).toBe('相');
    expect(glyphOf(piece(BLACK, ELEPHANT))).toBe('象');
    expect(glyphOf(piece(RED, CANNON))).toBe('炮');
    expect(glyphOf(piece(BLACK, CANNON))).toBe('砲');
  });

  it('标准开局摆子正确、**红先**（与另两款棋白先相反）', () => {
    const b = board();
    expect(b.rows).toBe(10);
    expect(b.cols).toBe(9);
    expect(b.turn).toBe(RED);
    expect(RED).toBe(1); // 房间层先手席
    expect(b.at(0, 4)).toBe(piece(BLACK, KING));
    expect(b.at(9, 4)).toBe(piece(RED, KING));
    expect(b.at(0, 0)).toBe(piece(BLACK, CHARIOT));
    expect(b.at(2, 1)).toBe(piece(BLACK, CANNON));
    expect(b.at(3, 0)).toBe(piece(BLACK, PAWN));
    expect(b.at(6, 0)).toBe(piece(RED, PAWN));
    expect(b.at(7, 1)).toBe(piece(RED, CANNON));
    expect(b.at(4, 4)).toBe(EMPTY);
  });
});

describe('中国象棋：perft —— 走法生成的正确性硬锚', () => {
  it('开局 44 / 1920 / 79666', () => {
    const b = board();
    expect(b.perft(1)).toBe(44);
    expect(b.perft(2)).toBe(1920);
    expect(b.perft(3)).toBe(79666);
  });
});

describe('中国象棋：马的蹩腿', () => {
  it('腿没被堵时八个方向都能走', () => {
    const b = board(`${BLACK_K}/9/9/9/9/4N4/9/9/9/${RED_K} w - - 0 1`);
    expect(targets(b, RED, [5, 4])).toEqual(
      ['3,3', '3,5', '4,2', '4,6', '6,2', '6,6', '7,3', '7,5'].sort()
    );
  });

  it('腿被堵住的两个方向走不了（走"日"先直行的那一格必须空）', () => {
    // 黑卒在 (4,4)，正好是红马 (5,4) 往上两条的腿
    const b = board(`${BLACK_K}/9/9/9/4p4/4N4/9/9/9/${RED_K} w - - 0 1`);
    const t = targets(b, RED, [5, 4]);
    expect(t).not.toContain('3,3');
    expect(t).not.toContain('3,5');
    expect(t).toHaveLength(6);
    // 与那条腿无关的方向不受影响
    expect(t).toContain('4,2'); // 腿是 (5,3)
    expect(t).toContain('6,6'); // 腿是 (5,5)
  });
});

describe('中国象棋：象的塞眼与不过河', () => {
  it('田字中心有子就走不了（塞象眼）', () => {
    // 红相 (9,2)；黑卒堵在 (8,3)，正好是通往 (7,4) 的眼
    const blocked = board(`${BLACK_K}/9/9/9/9/9/9/9/3p5/2B1K4 w - - 0 1`);
    expect(targets(blocked, RED, [9, 2])).toContain('7,0'); // 眼 (8,1) 空着
    expect(targets(blocked, RED, [9, 2])).not.toContain('7,4'); // 眼 (8,3) 被堵

    const open = board(`${BLACK_K}/9/9/9/9/9/9/9/9/2B1K4 w - - 0 1`);
    expect(targets(open, RED, [9, 2])).toEqual(['7,0', '7,4']);
  });

  it('**象不过河**：跨河的田字落点被排除（行 ≤ 4 是黑方半场）', () => {
    // 红相在 (6,4)：往上是 (4,2)/(4,6)（过河，不许），往下是 (8,2)/(8,6)（可以）
    const b = board(`${BLACK_K}/9/9/9/9/9/4B4/9/9/${RED_K} w - - 0 1`);
    expect(targets(b, RED, [6, 4])).toEqual(['8,2', '8,6']);
  });
});

describe('中国象棋：炮翻山', () => {
  // 红炮 (5,0)；黑卒 (3,0) 当炮架；黑车 (1,0) 在炮架之外
  const FEN = `4k4/r8/9/p8/9/C8/9/9/9/3K5 w - - 0 1`;

  it('炮架**之前**的空格可以走', () => {
    expect(targets(board(FEN), RED, [5, 0])).toContain('4,0');
  });

  it('炮架**之后**的空格不能走（这是本次 perft 抓到的那个错）', () => {
    const t = targets(board(FEN), RED, [5, 0]);
    expect(t).not.toContain('2,0'); // 跳过了 (3,0) 的炮架，不能再落空格
    expect(t).not.toContain('0,0');
  });

  it('翻过炮架可以吃第一个敌子', () => {
    expect(targets(board(FEN), RED, [5, 0])).toContain('1,0'); // 吃掉 (1,0) 的黑车
  });

  it('没有炮架就吃不掉', () => {
    const b = board('4k4/r8/9/9/9/C8/9/9/9/3K5 w - - 0 1');
    expect(targets(b, RED, [5, 0])).not.toContain('1,0');
  });

  it('将军判定也认炮翻山', () => {
    // 黑王 (0,4)，红炮 (5,4)，中间 (3,4) 有黑卒当炮架 → 黑方被将军
    const b = board('4k4/9/9/4p4/9/4C4/9/9/9/3K5 b - - 0 1');
    expect(b.inCheck(BLACK)).toBe(true);
    // 挪走炮架就不再是将
    const c = board('4k4/9/9/9/9/4C4/9/9/9/3K5 b - - 0 1');
    expect(c.inCheck(BLACK)).toBe(false);
  });
});

describe('中国象棋：兵/卒', () => {
  it('过河前只能直进一格', () => {
    const b = board(`${BLACK_K}/9/9/9/9/9/P8/9/9/${RED_K} w - - 0 1`);
    expect(targets(b, RED, [6, 0])).toEqual(['5,0']);
  });

  it('过河后可以横走，但**永远不能后退**', () => {
    const b = board(`${BLACK_K}/9/9/9/P8/9/9/9/9/${RED_K} w - - 0 1`);
    const t = targets(b, RED, [4, 0]);
    expect(t).toContain('3,0'); // 直进
    expect(t).toContain('4,1'); // 横走
    expect(t).not.toContain('5,0'); // 后退 —— 不许
  });

  it('黑卒方向相反：过河前只能往下，过河后才能横走', () => {
    const notCrossed = board(`${BLACK_K}/9/9/p8/9/9/9/9/9/${RED_K} b - - 0 1`);
    expect(targets(notCrossed, BLACK, [3, 0])).toEqual(['4,0']);

    const crossed = board(`${BLACK_K}/9/9/9/9/p8/9/9/9/${RED_K} b - - 0 1`);
    const t = targets(crossed, BLACK, [5, 0]);
    expect(t).toContain('6,0');
    expect(t).toContain('5,1');
    expect(t).not.toContain('4,0');
  });
});

describe('中国象棋：飞将', () => {
  // 【这一组故意把两个王摆在同一列上】红王 (9,4)、黑王 (0,4)，红车 (5,4) 挡在中间
  const FEN = '4k4/9/9/9/9/4R4/9/9/9/4K4 w - - 0 1';

  it('把挡在中间的子挪开 → 两王照面 → 非法', () => {
    const b = board(FEN);
    const before = snapshot(b);
    expect(b.submit(RED, { path: [[5, 4], [5, 3]] })).toBeNull();
    expect(snapshot(b)).toBe(before);
  });

  it('沿着同一条线挪（仍然挡着）就合法', () => {
    const b = board(FEN);
    expect(b.submit(RED, { path: [[5, 4], [4, 4]] })).not.toBeNull();
  });

  it('王自己也不能走到与对方王照面的位置', () => {
    // 红王 (9,3) → (9,4) 就与黑王 (0,4) 照面
    const b = board('4k4/9/9/9/9/9/9/9/9/3K5 w - - 0 1');
    expect(b.submit(RED, { path: [[9, 3], [9, 4]] })).toBeNull();
  });
});

describe('中国象棋：终局', () => {
  it('将死判负，赢家是刚走完的那一方', () => {
    // 红车走到 (0,0) 沿底线将，另一车在 (1,1) 封住 (1,4)
    const b = board('4k4/1R7/R8/9/9/9/9/9/9/3K5 w - - 0 1');
    const outcome = play(b, [2, 0], [0, 0]);
    expect(outcome.status).toBe('won');
    expect(outcome.status === 'won' && outcome.reason).toBe('checkmate');
    expect(outcome.status === 'won' && outcome.winner).toBe(RED);
  });

  it('**困毙判负**（无棋可走但未被将军）—— 与国际象棋的逼和判和相反', () => {
    // 红车封住 (0,3)、(0,5)、(1,4)，黑王动不了；但黑王此刻并未被将军
    const b = board('4k4/9/3R1R3/R8/9/9/9/9/9/3K5 w - - 0 1');
    const outcome = play(b, [3, 0], [1, 0]);

    // 先确认这确实不是将死，而是困毙
    expect(b.inCheck(BLACK)).toBe(false);
    expect(b.generateMoves(BLACK)).toHaveLength(0);

    expect(outcome.status).toBe('won');
    expect(outcome.status === 'won' && outcome.reason).toBe('no-moves');
    expect(outcome.status === 'won' && outcome.winner).toBe(RED); // 走不动的是黑方 → 红胜
  });

  it('60 回合（120 半回合）无吃子判和', () => {
    const b = board(`${BLACK_K}/9/9/9/9/9/9/9/9/3K1R3 w - - 119 1`);
    const outcome = play(b, [9, 5], [8, 5]);
    expect(outcome.status).toBe('draw');
    expect(outcome.status === 'draw' && outcome.reason).toBe('no-capture');
  });

  it('吃子会把无吃子计数清零，于是不判和', () => {
    // 计数已经 119，但这一手吃掉了黑卒 → 计数归零
    // 行 9 = "R4p3"：红车 (9,0)、黑卒 (9,5)；红王在 (7,3) 让开第 9 行
    const b = board(`${BLACK_K}/9/9/9/9/9/9/3K5/9/R4p3 w - - 119 1`);
    const outcome = play(b, [9, 0], [9, 5]);
    expect(b.noCapture).toBe(0);
    expect(outcome.status).toBe('playing');
  });

  it('三次重复局面判和', () => {
    const b = board('r4k3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1');
    for (let round = 0; round < 2; round++) {
      play(b, [9, 0], [8, 0]); // 红车
      play(b, [0, 0], [1, 0]); // 黑车
      play(b, [8, 0], [9, 0]);
      const last = play(b, [1, 0], [0, 0]);
      if (round === 0) expect(last.status).toBe('playing');
      else {
        expect(last.status).toBe('draw');
        expect(last.status === 'draw' && last.reason).toBe('repetition');
      }
    }
  });

  it('**长将判负**：一直在将军的那一方输（走的人输，不是走的人赢）', () => {
    // 红车在 (0,0) 与 (1,0) 之间来回，每一步都将军；黑王在 (0,4)/(1,4) 之间躲
    const b = board(`4k4/R8/9/9/9/9/9/9/9/3K5 w - - 0 1`);
    let last;
    for (let round = 0; round < 2; round++) {
      play(b, [1, 0], [0, 0]); // 红车 → 底线将军
      play(b, [0, 4], [1, 4]); // 黑王躲
      play(b, [0, 0], [1, 0]); // 红车 → 又是一将
      last = play(b, [1, 4], [0, 4]); // 黑王躲回来 → 局面第 2/3 次出现
      if (round === 0) expect(last.status).toBe('playing');
    }
    expect(last!.status).toBe('won');
    expect(last!.status === 'won' && last!.reason).toBe('perpetual-check');
    // 长将的是红方 → **红方判负**，赢家是黑方。
    // 若按"走的人赢"去推就会得到相反的结果，这条用例专门钉住它。
    expect(last!.status === 'won' && last!.winner).toBe(BLACK);
  });
});

describe('中国象棋：submit 的契约', () => {
  it('非法着法返回 null，**棋盘一点没动**', () => {
    const b = board();
    const before = snapshot(b);
    expect(b.submit(RED, { path: [[9, 0], [8, 0], [7, 0]] })).toBeNull(); // 车不能连走
    expect(b.submit(RED, { path: [[9, 2], [5, 2]] })).toBeNull(); // 象不能过河
    expect(b.submit(RED, { path: [[6, 0], [5, 1]] })).toBeNull(); // 兵不能斜走
    expect(b.submit(RED, { path: [[9, 0], [99, 99]] })).toBeNull();
    expect(b.submit(RED, { path: [] })).toBeNull();
    expect(snapshot(b)).toBe(before);
  });

  it('轮次不对的一手被拒', () => {
    const b = board();
    expect(b.submit(BLACK, { path: [[3, 0], [4, 0]] })).toBeNull();
  });

  it('对任何垃圾输入都不抛异常', () => {
    const b = board();
    const junk: unknown[] = [
      { path: [[NaN, 0], [0, 0]] },
      { path: [[1.5, 1], [0, 0]] },
      { path: [[0, 0], [null, 0]] },
      { path: 'nope' },
      {},
      { path: [[9, 0], [8, 0]], promotion: 42 },
    ];
    for (const j of junk) {
      expect(() => b.submit(RED, j as MoveInput), JSON.stringify(j)).not.toThrow();
      expect(b.submit(RED, j as MoveInput), JSON.stringify(j)).toBeNull();
    }
  });

  it('走法生成不会污染 lastMove', () => {
    const b = board();
    play(b, [6, 0], [5, 0]);
    const before = b.getLastMove();
    b.generateMoves(RED);
    b.generateMoves(BLACK);
    expect(b.getLastMove()).toEqual(before);
  });
});

describe('中国象棋：reset 与全新棋盘等价', () => {
  it('走过棋之后 reset，与刚 new 出来的一模一样', () => {
    const b = board();
    play(b, [7, 1], [7, 4]); // 炮二平五
    play(b, [2, 7], [2, 4]); // 炮8平5
    play(b, [9, 1], [7, 2]); // 马二进三

    b.reset();
    const fresh = new XiangqiBoard();
    expect(snapshot(b)).toBe(snapshot(fresh));
    expect(b.repetitionCount()).toBe(1);
  });
});
