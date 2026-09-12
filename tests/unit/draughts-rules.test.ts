// ─────────────────────────────────────────────────────────────────────────────
// draughts-rules.test.ts —— 国际跳棋规则的**正确性钉子**
//
// 【perft 是主角】跳棋的规则里有两类"整体性"条款 —— **吃子强制**与**最大吃子**，
// 还有王的飞吃、连吃途中不升变。它们错了不会让某一步"看起来不对"，而是让整棵
// 走法树的形状变样。下面几组国际通行值对不上就是规则错了，**不要去改期望值**。
//
// 本次就靠它抓到一个真错误：深色格的列号逐行交替（偶数行 1,3,5,7,9、奇数行
// 0,2,4,6,8），开局摆子时把每一行都写成同一种图案，等于把奇数行的子摆到了浅色格上
// —— 棋盘看上去仍然"四行摆满"，但开局着法数从 9 变成 18。
//
// 【数字来源】国际跳棋（10×10）开局的 perft 通行值：
// 9 / 81 / 658 / 4265 / 27117 / 167140。
// 第 6 层 0.5 秒，进 CI 无压力。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  DraughtsBoard,
  EMPTY,
  KING,
  MAN,
  SIZE,
  WHITE,
  colorOf,
  glyphOf,
  isDark,
  piece,
  typeOf,
} from '@/lib/draughts-rules';
import type { MoveInput, Square } from '@/lib/board-shared';

function board(fen?: string): DraughtsBoard {
  const b = new DraughtsBoard();
  if (fen) b.loadFen(fen);
  return b;
}

function play(b: DraughtsBoard, path: Square[]) {
  const outcome = b.submit(b.turn, { path });
  if (!outcome) throw new Error(`预期合法却被拒：${JSON.stringify(path)}`);
  return outcome;
}

/** 当前所有合法着法，渲染成 "r,c>r,c>r,c" 便于断言。 */
function legal(b: DraughtsBoard): string[] {
  return b
    .generateLegal(b.turn)
    .map((m) => m.path.map(([r, c]) => `${r},${c}`).join('>'))
    .sort();
}

function snapshot(b: DraughtsBoard): string {
  return JSON.stringify({
    grid: b.grid,
    turn: b.turn,
    kingOnly: b.kingOnlyHalfMoves,
    last: b.getLastMove(),
  });
}

describe('国际跳棋：棋盘与开局', () => {
  it('深色格是 (row+col)%2===1，全盘 50 格，左下角是深色', () => {
    let dark = 0;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (isDark(r, c)) dark++;
    expect(dark).toBe(50);
    expect(isDark(9, 0)).toBe(true); // 左下
    expect(isDark(6, 1)).toBe(true); // 偶数行：1,3,5,7,9
    expect(isDark(6, 0)).toBe(false);
    expect(isDark(7, 0)).toBe(true); // 奇数行：0,2,4,6,8
    expect(isDark(7, 1)).toBe(false);
  });

  it('棋子编码白兵 1 / 白王 2 / 黑兵 9 / 黑王 10', () => {
    expect(piece(WHITE, MAN)).toBe(1);
    expect(piece(WHITE, KING)).toBe(2);
    expect(piece(BLACK, MAN)).toBe(9);
    expect(piece(BLACK, KING)).toBe(10);
    expect(colorOf(1)).toBe(WHITE);
    expect(typeOf(10)).toBe(KING);
    expect(colorOf(EMPTY)).toBe(0);
    expect(glyphOf(piece(WHITE, MAN))).toBe('M');
    expect(glyphOf(piece(BLACK, KING))).toBe('k');
  });

  it('标准开局：每方 20 子、白先、子全在深色格上', () => {
    const b = board();
    expect(b.rows).toBe(10);
    expect(b.cols).toBe(10);
    expect(b.turn).toBe(WHITE);
    expect(WHITE).toBe(1); // 房间层先手席
    expect(b.countPieces(WHITE)).toBe(20);
    expect(b.countPieces(BLACK)).toBe(20);

    // **每一颗子都必须在深色格上**（本轮踩过的坑：奇数行图案写错就全跑到浅色格）
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (b.at(r, c) !== EMPTY) expect(isDark(r, c), `(${r},${c}) 应落在深色格`).toBe(true);
      }
    }
    // 中间两行空
    for (let c = 0; c < SIZE; c++) {
      expect(b.at(4, c)).toBe(EMPTY);
      expect(b.at(5, c)).toBe(EMPTY);
    }
  });
});

describe('国际跳棋：perft —— 走法生成的正确性硬锚', () => {
  it('开局 9 / 81 / 658 / 4265', () => {
    const b = board();
    expect(b.perft(1)).toBe(9);
    expect(b.perft(2)).toBe(81);
    expect(b.perft(3)).toBe(658);
    expect(b.perft(4)).toBe(4265);
  });

  it('开局第 5、6 层（吃子与最大吃子在这个深度才充分展开）', () => {
    expect(board().perft(5)).toBe(27117);
    expect(board().perft(6)).toBe(167140);
  });
});

describe('国际跳棋：兵的走与吃', () => {
  it('不吃时只能向前斜走一格', () => {
    const b = board('10/10/10/10/10/2M7/10/10/10/10');
    // 白兵 (5,2) → 只能到 (4,1) 与 (4,3)
    expect(legal(b)).toEqual(['5,2>4,1', '5,2>4,3']);
  });

  it('吃子可以**向后**（国际跳棋的兵四个斜向都能吃）', () => {
    // 白兵 (5,4)，黑兵 (6,5) 在它**后方**
    const b = board('10/10/10/10/10/4M5/5m4/10/10/10');
    expect(legal(b)).toEqual(['5,4>7,6']); // 向后跳过 (6,5) 落在 (7,6)
  });

  it('吃子强制：有吃子时，不吃子的走法一律不合法', () => {
    // 白兵 (5,2) 可以吃 (4,3)；另有白兵 (7,0) 可以安静地走 (6,1)
    const b = board('10/10/10/10/3m6/2M7/10/M9/10/10');
    expect(legal(b)).toEqual(['5,2>3,4']); // 只剩吃子，安静走法被强制规则挤掉
  });

  it('连吃：一条路径连跳两个子', () => {
    const b = board('10/10/5m4/10/3m6/2M7/10/10/10/10');
    // (5,2) 吃 (4,3) 落 (3,4)，再吃 (2,5) 落 (1,6)
    expect(legal(b)).toEqual(['5,2>3,4>1,6']);
  });
});

describe('国际跳棋：最大吃子规则', () => {
  it('必须选吃子最多的那条路径，吃 1 个的走法不合法', () => {
    // 白兵 (5,2) 有两条路：向左吃 (4,1) 只吃 1 个；向右吃 (4,3) 后还能再吃 (2,5) 共 2 个
    const b = board('10/10/5m4/10/1m1m6/2M7/10/10/10/10');
    const all = legal(b);
    expect(all).toEqual(['5,2>3,4>1,6']); // 只留下吃 2 个的那条
    expect(all).not.toContain('5,2>3,0'); // 吃 1 个的被排除
  });

  it('吃子数相同时两条路都合法（并列不受影响）', () => {
    const b = board('10/10/10/10/1m1m6/2M7/10/10/10/10');
    expect(legal(b)).toEqual(['5,2>3,0', '5,2>3,4']);
  });
});

describe('国际跳棋：王', () => {
  it('王的飞吃：越过一个敌子后，**每一个**空格都能落', () => {
    // 白王 (9,0)，黑兵 (5,4)：沿这条对角线越过后是 (4,5)…(0,9)，共 5 个落点
    const b = board('10/10/10/10/10/4m5/10/10/10/K9');
    expect(legal(b)).toEqual([
      '9,0>0,9',
      '9,0>1,8',
      '9,0>2,7',
      '9,0>3,6',
      '9,0>4,5',
    ]);
  });

  it('王不吃子时沿对角线走任意格', () => {
    const b = board('10/10/10/10/10/10/10/10/10/K9');
    const all = legal(b);
    expect(all).toContain('9,0>5,4'); // 直接飞到中间
    expect(all).toContain('9,0>0,9'); // 飞到另一头
    expect(all).toHaveLength(9); // 9,0 出发的两条对角线上的空格数
  });

  it('王飞吃之后可以继续连吃（落在 (4,5) 时还能拐去再吃 (6,7)）', () => {
    // 白王 (9,0)；黑兵 (5,4) 在去路上，黑兵 (6,7) 在 (4,5) 的另一条对角线上
    const b = board('10/10/10/10/10/4m5/7m2/10/10/K9');
    // 最大吃子是 2，所以只剩这两条链
    expect(legal(b)).toEqual(['9,0>4,5>7,8', '9,0>4,5>8,9']);
  });

  it('同一条连吃里，同一个子不会被跳两次', () => {
    // 白王 (9,0) 吃 (5,4)。若被吃的子当场从盘上消失，王就能折返再从同一格"吃"一次。
    const b = board('10/10/10/10/10/4m5/10/10/10/K9');
    const caps = b.generateLegal(WHITE);
    expect(caps).toHaveLength(5); // 落点 (4,5)…(0,9)
    for (const m of caps) {
      expect(m.captured).toEqual([[5, 4]]); // 只吃得到那一个，且只吃一次
      expect(m.path).toHaveLength(m.captured.length + 1); // 每吃一子只落一次
      const keys = m.captured.map(([r, c]) => r * 10 + c);
      expect(new Set(keys).size).toBe(keys.length); // 无重复
    }
  });
});

describe('国际跳棋：升变', () => {
  it('兵走到最后一排升王', () => {
    const b = board('10/2M7/10/10/10/10/10/10/10/10');
    play(b, [
      [1, 2],
      [0, 1],
    ]);
    expect(b.at(0, 1)).toBe(piece(WHITE, KING));
  });

  it('**连吃途中经过底线不升变**，只有连吃在底线结束才升王', () => {
    // 白兵 (2,3) 吃 (1,4) 落 (0,5)【底线】，再吃 (1,6) 落 (2,7) 结束在 (2,7)
    const through = board('10/4m1m3/3M6/10/10/10/10/10/10/10');
    play(through, [
      [2, 3],
      [0, 5],
      [2, 7],
    ]);
    expect(through.at(2, 7)).toBe(piece(WHITE, MAN)); // 途中路过底线，仍是兵

    // 去掉第二个黑子，连吃就在底线上结束 → 升王
    const ends = board('10/4m5/3M6/10/10/10/10/10/10/10');
    play(ends, [
      [2, 3],
      [0, 5],
    ]);
    expect(ends.at(0, 5)).toBe(piece(WHITE, KING));
  });

  it('黑兵方向相反：走到第 9 行升王', () => {
    // 黑兵在 (8,1)（深色格），向下走到 (9,0) 升王。**该黑走**，要显式给 turn
    const b = new DraughtsBoard();
    b.loadFen('10/10/10/10/10/10/10/10/1m8/10', BLACK);
    play(b, [
      [8, 1],
      [9, 0],
    ]);
    expect(b.at(9, 0)).toBe(piece(BLACK, KING));
  });
});

describe('国际跳棋：终局', () => {
  it('**无棋可走判负**（不是和棋）', () => {
    // 白只剩 (9,0) 一个兵，被彻底封死：向前的 (8,1) 被占，想吃它落点 (7,2) 也被占。
    // 黑方另有一个王在 (0,1) 可以随便踱一步 —— 走完那一手就轮到白方，而白方走不动。
    const b = new DraughtsBoard();
    b.loadFen('1k8/10/10/10/10/10/10/2m7/1m8/M9', BLACK);

    // 白方确实一步都走不了
    expect(b.generateLegal(WHITE)).toHaveLength(0);
    expect(b.submit(WHITE, { path: [[9, 0], [8, 1]] })).toBeNull();

    // 黑王踱一步（它没有可吃的子，所以这手是合法的安静着法）
    const outcome = play(b, [
      [0, 1],
      [1, 0],
    ]);
    expect(outcome.status).toBe('won');
    expect(outcome.status === 'won' && outcome.reason).toBe('no-moves');
    expect(outcome.status === 'won' && outcome.winner).toBe(BLACK); // 走不动的是白方 → 黑胜
  });

  it('把对方吃光即获胜', () => {
    // 白兵 (5,2) 吃掉黑方最后一子
    const b = board('10/10/10/10/3m6/2M7/10/10/10/10');
    const outcome = play(b, [
      [5, 2],
      [3, 4],
    ]);
    expect(outcome.status).toBe('won');
    expect(outcome.status === 'won' && outcome.winner).toBe(WHITE);
  });

  it('25 回合只有王在动且无吃子 → 判和', () => {
    const b = board('1k8/10/10/10/10/10/10/10/10/K9');
    b.kingOnlyHalfMoves = 49; // 只差一个半回合
    const outcome = play(b, [
      [9, 0],
      [8, 1],
    ]);
    expect(b.kingOnlyHalfMoves).toBe(50);
    expect(outcome.status).toBe('draw');
    expect(outcome.status === 'draw' && outcome.reason).toBe('fifty-move');
  });

  it('兵一动或一吃子，计数就归零', () => {
    const byMan = board('10/10/10/10/10/2M7/10/10/10/10');
    byMan.kingOnlyHalfMoves = 30;
    play(byMan, [
      [5, 2],
      [4, 3],
    ]);
    expect(byMan.kingOnlyHalfMoves).toBe(0);

    const byCapture = board('10/10/10/10/3m6/2M7/10/10/10/10');
    byCapture.kingOnlyHalfMoves = 30;
    play(byCapture, [
      [5, 2],
      [3, 4],
    ]);
    expect(byCapture.kingOnlyHalfMoves).toBe(0);
  });

  it('三次重复局面判和', () => {
    // 两个王来回踱步，四手回到同一局面
    const b = board('1k8/10/10/10/10/10/10/10/10/K9');
    let last;
    for (let round = 0; round < 2; round++) {
      play(b, [[9, 0], [8, 1]]); // 白王
      play(b, [[0, 1], [1, 0]]); // 黑王
      play(b, [[8, 1], [9, 0]]);
      last = play(b, [[1, 0], [0, 1]]);
      if (round === 0) expect(last.status).toBe('playing');
    }
    expect(last!.status).toBe('draw');
    expect(last!.status === 'draw' && last!.reason).toBe('repetition');
  });
});

describe('国际跳棋：submit 的契约', () => {
  it('非法着法返回 null，**棋盘一点没动**', () => {
    const b = board();
    const before = snapshot(b);
    expect(b.submit(WHITE, { path: [[6, 1], [4, 3]] })).toBeNull(); // 兵不能一次走两格
    expect(b.submit(WHITE, { path: [[9, 0], [8, 1]] })).toBeNull(); // 这个子前面被挡
    expect(b.submit(WHITE, { path: [[6, 1]] })).toBeNull(); // 路径太短
    expect(b.submit(WHITE, { path: [] })).toBeNull();
    expect(snapshot(b)).toBe(before);
  });

  it('**不是吃子最多的那条路径会被拒**（服务端不让客户端挑便宜）', () => {
    const b = board('10/10/5m4/10/1m1m6/2M7/10/10/10/10');
    const before = snapshot(b);
    // 吃 1 个的那条虽然"看起来合法"，但不是最大吃子
    expect(b.submit(WHITE, { path: [[5, 2], [3, 0]] })).toBeNull();
    expect(snapshot(b)).toBe(before);
  });

  it('轮次不对的一手被拒', () => {
    const b = board();
    expect(b.submit(BLACK, { path: [[3, 0], [4, 1]] })).toBeNull();
  });

  it('对任何垃圾输入都不抛异常', () => {
    const b = board();
    const junk: unknown[] = [
      { path: [[NaN, 0], [0, 0]] },
      { path: [[6, 1], [5.5, 2]] },
      { path: [[6, 1], [null, 2]] },
      { path: 'nope' },
      {},
    ];
    for (const j of junk) {
      expect(() => b.submit(WHITE, j as MoveInput), JSON.stringify(j)).not.toThrow();
      expect(b.submit(WHITE, j as MoveInput), JSON.stringify(j)).toBeNull();
    }
  });

  it('走法生成不会污染 lastMove', () => {
    const b = board();
    play(b, [
      [6, 1],
      [5, 0],
    ]);
    const before = b.getLastMove();
    b.generateLegal(WHITE);
    b.generateLegal(BLACK);
    expect(b.getLastMove()).toEqual(before);
  });
});

describe('国际跳棋：reset 与全新棋盘等价', () => {
  it('走过棋之后 reset，与刚 new 出来的一模一样', () => {
    const b = board();
    play(b, [
      [6, 1],
      [5, 0],
    ]);
    play(b, [
      [3, 0],
      [4, 1],
    ]);

    b.reset();
    const fresh = new DraughtsBoard();
    expect(snapshot(b)).toBe(snapshot(fresh));
    expect(b.repetitionCount()).toBe(1);
    expect(b.countPieces(WHITE)).toBe(20);
  });
});
