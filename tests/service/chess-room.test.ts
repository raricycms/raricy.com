// chess-room.ts —— 国际象棋联机的房间层
//
// 【为什么还要测一遍房间层】房间逻辑与另外四款棋共用 board-room.ts，那一份已经由
// tests/service/gomoku-room.test.ts 覆盖了。这里只测**绑定的正确性**，即
// 「把国际象棋的棋盘挂上去之后，行为仍然成立」：
//   • 席位与先手的映射（1 = 黑席 = 白棋 = 建房者）
//   • 走子类棋特有的那条链路：整手 path 提交 → 落子 → 判终局 → winner 归属
//   • 五种棋共用一张房号表之后的**隔离**：别的棋看不到这一局
//
// 【为什么用"傻瓜杀"做终局用例】它只要 4 手（f3 e5 g4 Qh4#），是能在房间层里
// 真正跑出一次**将死**的最短路径 —— 而"将死算谁赢"正是走子类棋接进房间层时
// 最容易接反的一环（Outcome.winner ≠ 总是刚走完的那一方）。

import { describe, it, expect, beforeEach } from 'vitest';
import { BLACK, ChessBoard, KING, PAWN, WHITE, glyphOf, piece } from '@/lib/chess-rules';
import { __resetGameBus } from '@/lib/game-bus';
import {
  __resetChessRooms,
  __roomCount,
  claimAbandoned,
  createRoom,
  getSnapshot,
  joinRoom,
  playMove,
  requestRematch,
  resign,
  sweepRooms,
  type RoomResult,
} from '@/lib/chess-room';
// 另外四款棋，用来验"共用一张房号表但互不可见"
import { createRoom as createGomoku, __resetGomokuRooms } from '@/lib/gomoku-room';
import { createRoom as createTicTacToe, __resetTicTacToeRooms } from '@/lib/tictactoe-room';
import { createRoom as createXiangqi, __resetXiangqiRooms } from '@/lib/xiangqi-room';
import { createRoom as createDraughts, __resetDraughtsRooms } from '@/lib/draughts-room';

const ALICE = { id: 'u-alice', name: '爱丽丝' };
const BOB = { id: 'u-bob', name: '鲍勃' };
const CAROL = { id: 'u-carol', name: '卡罗尔' };

beforeEach(() => {
  __resetChessRooms();
  __resetGomokuRooms();
  __resetTicTacToeRooms();
  __resetXiangqiRooms();
  __resetDraughtsRooms();
  __resetGameBus();
});

function unwrap<T>(r: RoomResult<T>): T {
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.error}`);
  return r.value;
}

function failWith<T>(r: RoomResult<T>): string {
  if (r.ok) throw new Error('期望失败，实际成功了');
  return r.error;
}

/** 走一手（整条路径）。 */
function move(code: string, userId: string, path: Array<[number, number]>, promotion?: string) {
  return playMove(code, userId, { path, ...(promotion ? { promotion } : {}) });
}

/** 建一局已就位的对局：Alice 执白、Bob 执黑。返回房号。 */
function playingRoom(): string {
  const created = unwrap(createRoom(ALICE));
  unwrap(joinRoom(created.view.code, BOB));
  return created.view.code;
}

function viewOf(code: string, userId = ALICE.id) {
  return unwrap(getSnapshot(code, userId)).view;
}

describe('国际象棋房间：建房与入座', () => {
  it('8×8 棋盘、建房者执先手席、状态 waiting', () => {
    const snap = unwrap(createRoom(ALICE));

    expect(snap.you).toEqual({ role: 'player', seat: 'black' });
    expect(snap.view.kind).toBe('chess');
    expect(snap.view.rows).toBe(8);
    expect(snap.view.cols).toBe(8);
    expect(snap.view.grid).toHaveLength(8);
    expect(snap.view.grid[0]).toHaveLength(8);
    expect(snap.view.status).toBe('waiting');
    // 先手席 = 1 = 白（国际象棋白先）
    expect(snap.view.turn).toBe(WHITE);
    expect(WHITE).toBe(1);
  });

  it('开局摆子通过房间层下发时也正确（客户端渲染的就是这一份）', () => {
    const snap = unwrap(createRoom(ALICE));
    expect(snap.view.grid[0][4]).toBe(piece(BLACK, KING));
    expect(snap.view.grid[7][4]).toBe(piece(WHITE, KING));
    expect(glyphOf(snap.view.grid[0][4])).toBe('k');
    expect(glyphOf(snap.view.grid[7][4])).toBe('K');
    expect(snap.view.lastMove).toBeNull();
  });

  it('第二人入后手席，状态转 playing，仍由白方先走', () => {
    const created = unwrap(createRoom(ALICE));
    const joined = unwrap(joinRoom(created.view.code, BOB));

    expect(joined.you).toEqual({ role: 'player', seat: 'white' });
    expect(joined.view.status).toBe('playing');
    expect(joined.view.turn).toBe(WHITE);
  });

  it('两席坐满后第三人成为观众，走不了子', () => {
    const code = playingRoom();
    const spec = unwrap(joinRoom(code, CAROL));

    expect(spec.you).toEqual({ role: 'spectator', seat: null });
    expect(failWith(move(code, CAROL.id, [[6, 4], [4, 4]]))).toBe('notASeat');
  });

  it('刷新页面回到原座（join 幂等，棋盘与 revision 都不动）', () => {
    const code = playingRoom();
    unwrap(move(code, ALICE.id, [[6, 4], [4, 4]]));
    const before = viewOf(code);

    const again = unwrap(joinRoom(code, ALICE));

    expect(again.you).toEqual({ role: 'player', seat: 'black' });
    expect(again.view.revision).toBe(before.revision);
    expect(again.view.grid[4][4]).toBe(piece(WHITE, PAWN));
  });
});

describe('国际象棋房间：走子', () => {
  it('走子后轮次交替、lastMove 带**整条路径**', () => {
    const code = playingRoom();
    const after = unwrap(move(code, ALICE.id, [[6, 4], [4, 4]])).view;

    expect(after.grid[4][4]).toBe(1); // 白兵
    expect(after.grid[6][4]).toBe(0); // 起点空了
    expect(after.turn).toBe(BLACK);
    expect(after.lastMove).toEqual({ path: [[6, 4], [4, 4]], player: WHITE });
  });

  it('抢别人的回合 → notYourTurn；非法着法 → illegalMove 且棋盘没动', () => {
    const code = playingRoom();
    expect(failWith(move(code, BOB.id, [[1, 4], [3, 4]]))).toBe('notYourTurn');

    const before = viewOf(code);
    // 马不能走直线、兵不能倒退、车穿不过自己的兵
    expect(failWith(move(code, ALICE.id, [[7, 1], [5, 1]]))).toBe('illegalMove');
    expect(failWith(move(code, ALICE.id, [[6, 0], [7, 0]]))).toBe('illegalMove');
    expect(failWith(move(code, ALICE.id, [[7, 0], [3, 0]]))).toBe('illegalMove');
    const after = viewOf(code);
    expect(after.grid).toEqual(before.grid);
    expect(after.revision).toBe(before.revision);
  });

  it('路径长度不对（落子类棋的形状）被拒', () => {
    const code = playingRoom();
    expect(failWith(move(code, ALICE.id, [[4, 4]]))).toBe('illegalMove');
    expect(failWith(move(code, ALICE.id, [[6, 4], [5, 4], [4, 4]]))).toBe('illegalMove');
  });

  it('升变字段认不出来就整手拒掉（棋盘匹配不上任何生成的着法）', () => {
    // 走到升变要好几十手，这里只验房间层的形状闸门：报了一个对不上任何合法着法的
    // promotion，`submit` 就找不到匹配项 → illegalMove。真正的升变行为（不报兵种
    // 一律拒、四种兵种都合法）由 tests/unit/chess-rules.test.ts 逐一钉住。
    const code = playingRoom();
    expect(failWith(move(code, ALICE.id, [[6, 1], [5, 1]], 'k'))).toBe('illegalMove'); // 不能升王
    expect(failWith(move(code, ALICE.id, [[6, 1], [5, 1]], 'x'))).toBe('illegalMove');
  });

  it('终局后不能再走 → notPlaying', () => {
    const code = playingRoom();
    unwrap(resign(code, BOB.id));
    expect(failWith(move(code, ALICE.id, [[6, 4], [4, 4]]))).toBe('notPlaying');
  });

  it('走子会刷新活动时间，房间不会被误回收', () => {
    const T0 = 1_700_000_000_000;
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    unwrap(joinRoom(code, BOB, T0));

    unwrap(move(code, ALICE.id, [[6, 4], [4, 4]]));
    sweepRooms(T0 + 60_001 + 60_000);
    expect(__roomCount()).toBe(1);
  });
});

describe('国际象棋房间：终局与赢家归属', () => {
  it('**傻瓜杀**：将死由房间层判出，赢家是走棋的那一方', () => {
    const code = playingRoom();
    // 1. f3 e5 2. g4 Qh4#
    unwrap(move(code, ALICE.id, [[6, 5], [5, 5]])); // f2-f3
    unwrap(move(code, BOB.id, [[1, 4], [3, 4]])); // e7-e5
    unwrap(move(code, ALICE.id, [[6, 6], [4, 6]])); // g2-g4
    const view = unwrap(move(code, BOB.id, [[0, 3], [4, 7]])).view; // Qd8-h4#

    expect(view.status).toBe('won');
    expect(view.winner).toBe('white'); // 黑席 = 后手席 = Bob 执黑 → Bob 赢
    expect(view.endReason).toBe('checkmate');
    expect(view.highlight).toEqual([[7, 4]]); // 被将死的白王 e1
    expect(view.check).toBeNull(); // 终局后不再报"将军"
  });

  it('认输：赢家是对手，endReason 是 resign', () => {
    const code = playingRoom();
    const view = unwrap(resign(code, BOB.id)).view;
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black'); // 黑席（Alice）赢
    expect(view.endReason).toBe('resign');
    expect(view.highlight).toEqual([]);
  });

  it('对手掉线满 60 秒可判胜（时间由服务端复核）', () => {
    const T0 = 1_700_000_000_000;
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    unwrap(joinRoom(code, BOB, T0));

    expect(failWith(claimAbandoned(code, ALICE.id, T0 + 1000))).toBe('notDisconnectedLongEnough');
  });

  it('双方各点一次才重开；重开换的是一张**全新棋盘**', () => {
    const code = playingRoom();
    // 先把王走过去再走回来 —— 局面回到"看起来一样"，但白方的易位权利已经没了。
    // 这正是 board.reset() 与 createBoard() 的区别所在：权利 / 过路兵目标格 /
    // 重复局面历史都不在 grid 里，靠 reset 逐个清迟早漏一个。
    unwrap(move(code, ALICE.id, [[6, 4], [4, 4]])); // e2-e4
    unwrap(move(code, BOB.id, [[1, 4], [3, 4]])); // e7-e5
    unwrap(move(code, ALICE.id, [[7, 4], [6, 4]])); // Ke1-e2
    unwrap(move(code, BOB.id, [[0, 6], [2, 5]])); // Ng8-f6
    unwrap(move(code, ALICE.id, [[6, 4], [7, 4]])); // Ke2-e1（走回来）
    unwrap(move(code, BOB.id, [[2, 5], [0, 6]])); // Nf6-g8（走回来）

    unwrap(resign(code, BOB.id));
    expect(unwrap(requestRematch(code, ALICE.id)).view.rematchVotes).toBe(1);
    const two = unwrap(requestRematch(code, BOB.id)).view;

    expect(two.status).toBe('playing');
    expect(two.rematchVotes).toBe(0);
    expect(two.turn).toBe(WHITE);
    expect(two.winner).toBeNull();
    expect(two.endReason).toBeNull();
    expect(two.lastMove).toBeNull();

    // 【关键】换的是**一张全新棋盘**，不是 board.reset() —— 走子类棋的"开局"
    // 还包括易位权利与过路兵目标格，漏清任何一个都会留下"再来一局还能易位"。
    const fresh = new ChessBoard();
    expect(two.grid).toEqual(fresh.grid);
    expect(two.check).toBeNull();
  });
});

describe('五种棋共用一张房号表：必须互不可见', () => {
  const others = [
    ['五子棋', () => unwrap(createGomoku(ALICE)).view.code],
    ['井字棋', () => unwrap(createTicTacToe(ALICE)).view.code],
    ['中国象棋', () => unwrap(createXiangqi(ALICE)).view.code],
    ['国际跳棋', () => unwrap(createDraughts(ALICE)).view.code],
  ] as const;

  it('国际象棋的接口看不到其它四种棋的房间（按 notFound 处理，不泄露房号是否存在）', () => {
    for (const [name, make] of others) {
      const code = make();
      expect(failWith(getSnapshot(code, ALICE.id)), `${name}的房号`).toBe('notFound');
      expect(failWith(joinRoom(code, BOB)), `${name}的房号`).toBe('notFound');
      expect(failWith(move(code, ALICE.id, [[6, 4], [4, 4]])), `${name}的房号`).toBe('notFound');
      expect(failWith(resign(code, ALICE.id)), `${name}的房号`).toBe('notFound');
    }
  });

  it('房间数与重置按游戏分开，互不干扰', () => {
    unwrap(createRoom(ALICE));
    unwrap(createGomoku(BOB));

    expect(__roomCount()).toBe(1);
    __resetChessRooms();
    expect(__roomCount()).toBe(0);
  });
});
