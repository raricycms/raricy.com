// ─────────────────────────────────────────────────────────────────────────────
// chess-rules.test.ts —— 国际象棋规则的**正确性钉子**
//
// 【为什么 perft 是主角】单条用例只能验证"你想得到的情形"。规则写错的典型形态是
// 某条规则**整体**写反或漏掉（象能穿子、易位不判穿将、兵能倒退），而这类错误几乎
// 必然让整棵走法树的节点数偏离国际通行值。所以下面几组 perft 数字是本次改动最硬的
// 证据 —— 它们对不上就是规则错了，**不要去改期望值**。
//
// 【数字来源】国际象棋编程 wiki（CPW）的 perft 标准局面，各引擎与在线校验器一致。
// Kiwipete 与 pos4/pos5 是专门为易位、吃过路兵、升变的边角设计的。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BLACK,
  BISHOP,
  ChessBoard,
  EMPTY,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  colorOf,
  glyphOf,
  isPromotionMove,
  piece,
  typeOf,
} from '@/lib/chess-rules';

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

function board(fen?: string): ChessBoard {
  const b = new ChessBoard();
  if (fen) b.loadFen(fen);
  return b;
}

/** 走一手；不合法就抛（测试里出现即说明用例本身写错了）。 */
function play(b: ChessBoard, ...path: Array<[number, number]>) {
  const outcome = b.submit(b.turn, { path });
  if (!outcome) throw new Error(`预期合法却被拒：${JSON.stringify(path)}`);
  return outcome;
}

/** 棋盘的可比较快照 —— 用来断言"被拒的一手没有动过棋盘"。 */
function snapshot(b: ChessBoard): string {
  return JSON.stringify({
    grid: b.grid,
    turn: b.turn,
    castling: b.castling,
    ep: b.ep,
    halfmove: b.halfmove,
    last: b.getLastMove(),
  });
}

describe('国际象棋：编码与开局', () => {
  it('棋子编码白 1..6 / 黑 9..14，字形大写为白', () => {
    expect(piece(WHITE, QUEEN)).toBe(5);
    expect(piece(BLACK, QUEEN)).toBe(13);
    expect(colorOf(5)).toBe(WHITE);
    expect(colorOf(13)).toBe(BLACK);
    expect(typeOf(13)).toBe(QUEEN);
    expect(colorOf(EMPTY)).toBe(0);
    expect(glyphOf(piece(WHITE, KNIGHT))).toBe('N');
    expect(glyphOf(piece(BLACK, KNIGHT))).toBe('n');
  });

  it('标准开局摆子正确、白先', () => {
    const b = board();
    expect(b.rows).toBe(8);
    expect(b.cols).toBe(8);
    expect(b.turn).toBe(WHITE);
    // row 0 是第 8 横排（黑方底线）
    expect(b.at(0, 4)).toBe(piece(BLACK, KING));
    expect(b.at(7, 4)).toBe(piece(WHITE, KING));
    expect(b.at(1, 0)).toBe(piece(BLACK, PAWN));
    expect(b.at(6, 7)).toBe(piece(WHITE, PAWN));
    expect(b.at(4, 4)).toBe(EMPTY);
    // 开局无子可吃、无过路兵
    expect(b.getLastMove()).toBeNull();
    expect(b.ep).toBeNull();
  });

  it('房间层口径：rows/cols 都是 8，先手席 1 = 白', () => {
    const b = board();
    expect(b.rows).toBe(b.cols);
    expect(WHITE).toBe(1);
  });
});

describe('国际象棋：perft —— 走法生成的正确性硬锚', () => {
  it('标准开局：20 / 400 / 8902', () => {
    const b = board();
    expect(b.perft(1)).toBe(20);
    expect(b.perft(2)).toBe(400);
    expect(b.perft(3)).toBe(8902);
  });

  it('标准开局第 4 层 197281（19 万节点，确认没有深层才暴露的漏判）', () => {
    expect(board().perft(4)).toBe(197281);
  });

  it('Kiwipete（易位 / 吃过路兵 / 升变的边角）：48 / 2039 / 97862', () => {
    const b = board(KIWIPETE);
    expect(b.perft(1)).toBe(48);
    expect(b.perft(2)).toBe(2039);
    expect(b.perft(3)).toBe(97862);
  });

  it('pos3 残局（牵制与吃过路兵）：14 / 191 / 2812 / 43238', () => {
    const b = board('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
    expect(b.perft(1)).toBe(14);
    expect(b.perft(2)).toBe(191);
    expect(b.perft(3)).toBe(2812);
    expect(b.perft(4)).toBe(43238);
  });

  it('pos4（四路升变 + 双侧易位）：6 / 264 / 9467', () => {
    const b = board('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
    expect(b.perft(1)).toBe(6);
    expect(b.perft(2)).toBe(264);
    expect(b.perft(3)).toBe(9467);
  });

  it('pos5（升变与易位互相干扰）：44 / 1486 / 62379', () => {
    const b = board('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
    expect(b.perft(1)).toBe(44);
    expect(b.perft(2)).toBe(1486);
    expect(b.perft(3)).toBe(62379);
  });
});

describe('国际象棋：王车易位', () => {
  const OPEN = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

  it('两侧都能易，王落 g1 / c1，车跟着挪', () => {
    const b = board(OPEN);
    play(b, [7, 4], [7, 6]); // O-O
    expect(b.at(7, 6)).toBe(piece(WHITE, KING));
    expect(b.at(7, 5)).toBe(piece(WHITE, ROOK)); // 车 h1 → f1
    expect(b.at(7, 7)).toBe(EMPTY);

    const c = board(OPEN);
    play(c, [7, 4], [7, 2]); // O-O-O
    expect(c.at(7, 2)).toBe(piece(WHITE, KING));
    expect(c.at(7, 3)).toBe(piece(WHITE, ROOK)); // 车 a1 → d1
    expect(c.at(7, 0)).toBe(EMPTY);
  });

  it('三个禁区：王正被将不能易、穿过被攻击格不能易、落点被攻击不能易', () => {
    // 王被将（黑车在 e 线上）
    const inCheck = board('4r3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(inCheck.submit(WHITE, { path: [[7, 4], [7, 6]] })).toBeNull();

    // f1 被黑车攻击 → 短易位不许，长易位仍然可以（d1 没被攻击）
    const throughCheck = board('5r2/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(throughCheck.submit(WHITE, { path: [[7, 4], [7, 6]] })).toBeNull();
    expect(throughCheck.submit(WHITE, { path: [[7, 4], [7, 2]] })).not.toBeNull();

    // d1 被攻击 → 长易位不许（王要经过 d1）
    const queenSide = board('3r4/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(queenSide.submit(WHITE, { path: [[7, 4], [7, 2]] })).toBeNull();
  });

  it('b1 被攻击**不影响**长易位（王不经过 b1，只有车经过）', () => {
    const b = board('1r6/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(b.submit(WHITE, { path: [[7, 4], [7, 2]] })).not.toBeNull();
  });

  it('中间有子不能易', () => {
    const b = board('r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 0 1'); // d1 有后，挡长易位
    expect(b.submit(WHITE, { path: [[7, 4], [7, 2]] })).toBeNull();
    expect(b.submit(WHITE, { path: [[7, 4], [7, 6]] })).not.toBeNull(); // 短易位不受影响
  });

  it('王一动就两边权利全失；车一动只失那一边', () => {
    const b = board(OPEN);
    play(b, [7, 4], [7, 5]); // 王 e1→f1
    expect(b.castling.wk).toBe(false);
    expect(b.castling.wq).toBe(false);
    expect(b.castling.bk).toBe(true); // 黑方的没动

    const c = board(OPEN);
    play(c, [7, 7], [7, 6]); // 车 h1→g1
    expect(c.castling.wk).toBe(false);
    expect(c.castling.wq).toBe(true);
  });

  it('车在原位被吃 → 对方那一边的权利也作废（否则会拿别人的权利易位）', () => {
    const b = board(OPEN);
    play(b, [7, 0], [0, 0]); // 白车 a1 吃黑车 a8
    expect(b.castling.bq).toBe(false); // 黑的长易位权利没了
    expect(b.castling.wq).toBe(false); // 白车自己离开了原位
    expect(b.castling.bk).toBe(true);
  });
});

describe('国际象棋：吃过路兵', () => {
  // 黑兵 d7 直进两格到 d5（跳过 d6），白兵 e5 可以斜吃 d6 把它拿掉。
  const EP_FEN = '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1';

  it('兵直进两格才立起目标格，只走一格不立', () => {
    const single = board('4k3/3p4/8/8/8/8/8/4K3 b - - 0 1');
    play(single, [1, 3], [2, 3]); // d7 → d6（只走一格）
    expect(single.ep).toBeNull();

    const double = board(EP_FEN);
    play(double, [1, 3], [3, 3]); // d7 → d5（直进两格）
    expect(double.ep).toEqual([2, 3]); // 目标格 = 被跳过的那一格 d6
  });

  it('白兵斜吃 d6，被吃的黑兵在 d5 上被拿掉', () => {
    const b = board(EP_FEN);
    play(b, [1, 3], [3, 3]); // 黑兵 d7→d5
    play(b, [3, 4], [2, 3]); // 白兵 e5 吃过路兵到 d6
    expect(b.at(3, 3)).toBe(EMPTY); // d5 上的黑兵没了
    expect(b.at(2, 3)).toBe(piece(WHITE, PAWN)); // 白兵落在 d6
  });

  it('过了这一步还没吃，目标格自动失效（不能隔一手再吃）', () => {
    const b = board(EP_FEN);
    play(b, [1, 3], [3, 3]); // 黑兵 d7→d5，ep 立起来
    play(b, [7, 4], [7, 5]); // 白方随便走王，不吃过路兵
    expect(b.ep).toBeNull();
    const before = snapshot(b);
    expect(b.submit(WHITE, { path: [[3, 4], [2, 3]] })).toBeNull();
    expect(snapshot(b)).toBe(before);
  });
});

describe('国际象棋：升变', () => {
  it('走到底线必须报兵种，四种都合法', () => {
    for (const [letter, type] of [
      ['q', QUEEN],
      ['r', ROOK],
      ['b', BISHOP],
      ['n', KNIGHT],
    ] as const) {
      const b = board('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
      const outcome = b.submit(WHITE, { path: [[1, 1], [0, 1]], promotion: letter });
      expect(outcome, `升变 ${letter} 应当合法`).not.toBeNull();
      expect(b.at(0, 1)).toBe(piece(WHITE, type));
    }
  });

  it('**不报兵种一律拒绝**，服务端不替玩家选后（升马有时是唯一的赢法）', () => {
    const b = board('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    const before = snapshot(b);
    expect(b.submit(WHITE, { path: [[1, 1], [0, 1]] })).toBeNull();
    expect(b.submit(WHITE, { path: [[1, 1], [0, 1]], promotion: 'k' })).toBeNull(); // 不能升王
    expect(b.submit(WHITE, { path: [[1, 1], [0, 1]], promotion: 'x' })).toBeNull();
    expect(snapshot(b), '被拒的升变不能动过棋盘').toBe(before);
  });

  it('吃子升变也算，且被吃的子确实拿掉了', () => {
    // 黑车在 c8，白兵 b7 斜吃升变成马（顺带将 e8 的黑王）
    const b = board('2r1k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    const outcome = b.submit(WHITE, { path: [[1, 1], [0, 2]], promotion: 'n' });
    expect(outcome).not.toBeNull();
    expect(b.at(0, 2)).toBe(piece(WHITE, KNIGHT)); // c8 上现在是白马
    expect(b.at(0, 4)).toBe(piece(BLACK, KING));
    expect(colorOf(b.at(0, 2))).toBe(WHITE);
  });

  it('兵不能斜走到空格（斜走只能吃子）', () => {
    const b = board('3rk3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    // c8 是空的，b7 斜过去不合法
    expect(b.submit(WHITE, { path: [[1, 1], [0, 2]], promotion: 'n' })).toBeNull();
  });

  it('isPromotionMove 认得出来（客户端据此在提交前弹选择）', () => {
    const b = board('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    // 起点上是兵、终点在最后一排 → 是升变
    expect(isPromotionMove(b.at(1, 1), [0, 1])).toBe(true);
    expect(isPromotionMove(b.at(1, 1), [1, 0])).toBe(false);
    expect(isPromotionMove(b.at(7, 4), [0, 4])).toBe(false); // 王走到头也不是升变
  });
});

describe('国际象棋：走后不能自将', () => {
  it('被牵制的子不能离开那条线', () => {
    // 白王 e1、白车 e2、黑车 e8：车一走就是送将
    const b = board('4r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
    const before = snapshot(b);
    expect(b.submit(WHITE, { path: [[6, 4], [6, 0]] })).toBeNull();
    expect(snapshot(b)).toBe(before);
    // 沿着那条线走是允许的
    expect(b.submit(WHITE, { path: [[6, 4], [5, 4]] })).not.toBeNull();
  });

  it('王不能走进被攻击的格', () => {
    const b = board('4k3/8/8/8/8/5r2/8/4K3 w - - 0 1');
    // f1 被黑车攻击，王 e1→f1 非法
    expect(b.submit(WHITE, { path: [[7, 4], [7, 5]] })).toBeNull();
  });

  it('王不能贴着对方的王走（两个王不能相邻）', () => {
    // 黑王 e3、白王 e1：白王 e1→e2 就贴上了，非法
    const b = board('8/8/8/8/8/4k3/8/4K3 w - - 0 1');
    expect(b.submit(WHITE, { path: [[7, 4], [6, 4]] })).toBeNull();
    // 往旁边走（不相邻）是允许的
    expect(b.submit(WHITE, { path: [[7, 4], [7, 3]] })).not.toBeNull();
  });
});

describe('国际象棋：终局', () => {
  it('将死判负，highlight 是被将死的王', () => {
    // 白车 a1 走到 a8 完成底线杀
    const b = board('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    const outcome = play(b, [7, 0], [0, 0]);
    expect(outcome.status).toBe('won');
    expect(outcome.status === 'won' && outcome.reason).toBe('checkmate');
    expect(outcome.status === 'won' && outcome.highlight).toEqual([[0, 6]]); // 黑王 g8
  });

  it('**逼和判和**（无棋可走但未被将军）—— 与中国象棋的困毙判负相反', () => {
    const b = board('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    // 黑方无着可走且未被将：白后 f7 控制 g8/h7，白王 g6 控制 h7/g7
    expect(b.inCheck(BLACK)).toBe(false);
    const outcome = b.submit(BLACK, { path: [[0, 7], [0, 6]] });
    expect(outcome).toBeNull(); // 本来就走不了
    // 直接验证判定：摆一个黑方走完就是逼和的局面
    const c = board('7k/5Q2/6K1/8/8/8/8/6R1 w - - 0 1');
    const o = play(c, [7, 6], [7, 5]); // 白车 g1→f1，仍不将，黑方无着
    expect(o.status).toBe('draw');
    expect(o.status === 'draw' && o.reason).toBe('stalemate');
  });

  it('五十回合无吃子无兵动判和', () => {
    const b = board('8/8/4k3/8/8/4K3/8/7R w - - 99 1');
    const outcome = play(b, [7, 7], [6, 7]); // 车 h1→h2
    expect(outcome.status).toBe('draw');
    expect(outcome.status === 'draw' && outcome.reason).toBe('fifty-move');
  });

  it('子力不足判和（K vs K）', () => {
    // 黑王 e6、白王 e2
    const b = board('8/8/4k3/8/8/8/4K3/8 w - - 0 1');
    const outcome = play(b, [6, 4], [5, 4]);
    expect(outcome.status).toBe('draw');
    expect(outcome.status === 'draw' && outcome.reason).toBe('insufficient-material');
  });

  it('象同色格的 K+B vs K+B 判和；不同色格不判（仍可能杀）', () => {
    // 格色按 (row+col)%2 算：a1=(7,0) 是 (7+0)%2=1 → **1 是暗格**。
    // 白象 c1=(7,2)→1、黑象 f8=(0,5)→1：同暗格 → 死局
    expect(board('5b2/8/4k3/8/8/8/8/2B1K3 w - - 0 1').insufficientMaterial()).toBe(true);
    // 白象 c1=(7,2)→1（暗）、黑象 c8=(0,2)→0（亮）：不同色 → 不判死局
    expect(board('2b5/8/4k3/8/8/8/8/2B1K3 w - - 0 1').insufficientMaterial()).toBe(false);
  });

  it('有兵就不算子力不足', () => {
    const b = board('8/8/4k3/8/4P3/4K3/8/8 w - - 0 1');
    expect(b.insufficientMaterial()).toBe(false);
  });

  it('三次重复局面判和', () => {
    const b = board();
    // 双方马来来回回：4 手回到开局局面（第 2 次），再来 4 手就是第 3 次
    for (let round = 0; round < 2; round++) {
      play(b, [7, 1], [5, 2]); // Nb1-c3
      play(b, [0, 1], [2, 2]); // Nb8-c6
      play(b, [5, 2], [7, 1]); // Nc3-b1
      const last = play(b, [2, 2], [0, 1]); // Nc6-b8
      if (round === 0) expect(last.status).toBe('playing');
      else {
        expect(last.status).toBe('draw');
        expect(last.status === 'draw' && last.reason).toBe('repetition');
      }
    }
  });

  it('将死优先于五十回合：最后一手既将死又凑满 50 回合时算赢', () => {
    // halfmove = 99，白车走到 a8 既是第 100 个半回合也是杀 → 判胜不判和
    const b = board('6k1/5ppp/8/8/8/8/8/R5K1 w - - 99 1');
    const outcome = play(b, [7, 0], [0, 0]);
    expect(outcome.status).toBe('won');
  });
});

describe('国际象棋：submit 的契约', () => {
  it('非法着法返回 null，**棋盘一点没动**', () => {
    const b = board();
    const before = snapshot(b);
    // 马走成直线、兵倒退、车穿子、走出棋盘、路径长度不对
    expect(b.submit(WHITE, { path: [[7, 1], [5, 1]] })).toBeNull();
    expect(b.submit(WHITE, { path: [[6, 0], [7, 0]] })).toBeNull();
    expect(b.submit(WHITE, { path: [[7, 0], [3, 0]] })).toBeNull();
    expect(b.submit(WHITE, { path: [[7, 0], [99, 99]] })).toBeNull();
    expect(b.submit(WHITE, { path: [[7, 0]] })).toBeNull();
    expect(b.submit(WHITE, { path: [] })).toBeNull();
    expect(snapshot(b)).toBe(before);
  });

  it('轮次不对的一手被拒', () => {
    const b = board();
    expect(b.submit(BLACK, { path: [[1, 4], [2, 4]] })).toBeNull();
  });

  it('对任何垃圾输入都不抛异常（抛了会让房间停在错位状态）', () => {
    const b = board();
    const junk: unknown[] = [
      { path: [[NaN, 0], [0, 0]] },
      { path: [[1.5, 1], [0, 0]] },
      { path: [[0, 0], [null, 0]] },
      { path: 'nope' },
      { path: [[0, 0], [0, 0], [0, 0]] },
      {},
      { path: [[0, 0], [0, 0]], promotion: 42 },
    ];
    for (const j of junk) {
      expect(() => b.submit(WHITE, j as never), JSON.stringify(j)).not.toThrow();
      expect(b.submit(WHITE, j as never), JSON.stringify(j)).toBeNull();
    }
  });

  it('走法生成不会污染 lastMove（内部试走必须完整回退）', () => {
    const b = board();
    play(b, [6, 4], [4, 4]); // e2-e4
    const before = b.getLastMove();
    b.generateMoves(WHITE); // 大量内部试走 + 回退
    b.generateMoves(BLACK);
    expect(b.getLastMove()).toEqual(before);
  });
});

describe('国际象棋：reset 与全新棋盘等价', () => {
  it('走过一堆棋之后 reset，与刚 new 出来的一模一样', () => {
    const b = board();
    play(b, [6, 4], [4, 4]); // e2-e4
    play(b, [1, 4], [3, 4]); // e7-e5
    play(b, [7, 6], [5, 5]); // Ng1-f3
    play(b, [0, 1], [2, 2]); // Nb8-c6

    b.reset();
    const fresh = new ChessBoard();
    expect(snapshot(b)).toBe(snapshot(fresh));
    // 易位权利与过路兵也要一起回到开局 —— 漏掉的表现是「新对局还能易位」
    expect(b.castling).toEqual({ wk: true, wq: true, bk: true, bq: true });
    expect(b.ep).toBeNull();
    expect(b.halfmove).toBe(0);
    expect(b.repetitionCount()).toBe(1);
  });
});
