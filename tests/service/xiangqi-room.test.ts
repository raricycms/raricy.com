// xiangqi-room.ts —— 中国象棋联机的房间层
//
// 【为什么还要测一遍房间层】房间逻辑与另外四款棋共用 board-room.ts，那一份已经由
// tests/service/gomoku-room.test.ts 覆盖了。这里只测**绑定的正确性**：
//   • 席位与先手的映射（1 = 黑席 = **红棋** = 建房者）—— 象棋是红先，
//     与另外四款棋里"先手 = 白"的两款正好相反，是最容易接反的一处
//   • 走子类棋的整手 path 提交链路
//   • 五种棋共用一张房号表之后的隔离
//
// 将死 / 困毙 / 长将的**归属**（谁赢）由 tests/unit/xiangqi-rules.test.ts 逐条钉住，
// 那边能直接摆出想要的局面；这里用认输走终局路径，验的是房间层把 endReason 与
// winner 正确写进了快照。

import { describe, it, expect, beforeEach } from 'vitest';
import { BLACK, CANNON, KING, PAWN, RED, XiangqiBoard, glyphOf, piece } from '@/lib/xiangqi-rules';
import { __resetGameBus } from '@/lib/game-bus';
import {
  __resetXiangqiRooms,
  __roomCount,
  createRoom,
  getSnapshot,
  joinRoom,
  playMove,
  requestRematch,
  resign,
  type RoomResult,
} from '@/lib/xiangqi-room';
import { createRoom as createGomoku, __resetGomokuRooms } from '@/lib/gomoku-room';
import { createRoom as createTicTacToe, __resetTicTacToeRooms } from '@/lib/tictactoe-room';
import { createRoom as createChess, __resetChessRooms } from '@/lib/chess-room';
import { createRoom as createDraughts, __resetDraughtsRooms } from '@/lib/draughts-room';

const ALICE = { id: 'u-alice', name: '爱丽丝' };
const BOB = { id: 'u-bob', name: '鲍勃' };
const CAROL = { id: 'u-carol', name: '卡罗尔' };

beforeEach(() => {
  __resetXiangqiRooms();
  __resetGomokuRooms();
  __resetTicTacToeRooms();
  __resetChessRooms();
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

function move(code: string, userId: string, path: Array<[number, number]>) {
  return playMove(code, userId, { path });
}

function playingRoom(): string {
  const created = unwrap(createRoom(ALICE));
  unwrap(joinRoom(created.view.code, BOB));
  return created.view.code;
}

function viewOf(code: string, userId = ALICE.id) {
  return unwrap(getSnapshot(code, userId)).view;
}

describe('中国象棋房间：建房与入座', () => {
  it('9 列 × 10 行、建房者执先手席、状态 waiting', () => {
    const snap = unwrap(createRoom(ALICE));

    expect(snap.you).toEqual({ role: 'player', seat: 'black' });
    expect(snap.view.kind).toBe('xiangqi');
    // 棋盘**不是方的** —— 这正是协议里用 rows/cols 而不是单个 size 的原因
    expect(snap.view.rows).toBe(10);
    expect(snap.view.cols).toBe(9);
    expect(snap.view.grid).toHaveLength(10);
    expect(snap.view.grid[0]).toHaveLength(9);
    expect(snap.view.status).toBe('waiting');
    // 先手席 = 1 = **红**（象棋红先 —— 与另外两款走子类棋"白先"相反）
    expect(snap.view.turn).toBe(RED);
    expect(RED).toBe(1);
    expect(BLACK).toBe(2);
  });

  it('开局摆子通过房间层下发时也正确，红黑用不同的字', () => {
    const snap = unwrap(createRoom(ALICE));
    expect(snap.view.grid[0][4]).toBe(piece(BLACK, KING)); // 黑將 (0,4)
    expect(snap.view.grid[9][4]).toBe(piece(RED, KING)); // 红帥 (9,4)
    expect(snap.view.grid[6][0]).toBe(piece(RED, PAWN)); // 红兵 (6,0)
    expect(glyphOf(snap.view.grid[9][4])).toBe('帥');
    expect(glyphOf(snap.view.grid[0][4])).toBe('將');
    expect(snap.view.lastMove).toBeNull();
  });

  it('第二人入后手席，状态转 playing，仍由红方先走', () => {
    const created = unwrap(createRoom(ALICE));
    const joined = unwrap(joinRoom(created.view.code, BOB));

    expect(joined.you).toEqual({ role: 'player', seat: 'white' });
    expect(joined.view.status).toBe('playing');
    expect(joined.view.turn).toBe(RED);
  });

  it('两席坐满后第三人成为观众，走不了子', () => {
    const code = playingRoom();
    const spec = unwrap(joinRoom(code, CAROL));

    expect(spec.you).toEqual({ role: 'spectator', seat: null });
    expect(failWith(move(code, CAROL.id, [[6, 0], [5, 0]]))).toBe('notASeat');
  });
});

describe('中国象棋房间：走子', () => {
  it('炮二平五：走子后轮次交替、lastMove 带整条路径', () => {
    const code = playingRoom();
    const after = unwrap(move(code, ALICE.id, [[7, 7], [7, 4]])).view;

    expect(after.grid[7][4]).toBe(piece(RED, CANNON)); // 红炮
    expect(after.grid[7][7]).toBe(0); // 起点空了
    expect(after.turn).toBe(BLACK);
    expect(after.lastMove).toEqual({ path: [[7, 7], [7, 4]], player: RED });
  });

  it('抢别人的回合 → notYourTurn；非法着法 → illegalMove 且棋盘没动', () => {
    const code = playingRoom();
    expect(failWith(move(code, BOB.id, [[3, 0], [4, 0]]))).toBe('notYourTurn');

    const before = viewOf(code);
    expect(failWith(move(code, ALICE.id, [[9, 0], [8, 0], [7, 0]]))).toBe('illegalMove'); // 车不能连走
    expect(failWith(move(code, ALICE.id, [[9, 2], [5, 2]]))).toBe('illegalMove'); // 象不能过河
    expect(failWith(move(code, ALICE.id, [[6, 0], [5, 1]]))).toBe('illegalMove'); // 兵不能斜走
    const after = viewOf(code);
    expect(after.grid).toEqual(before.grid);
    expect(after.revision).toBe(before.revision);
  });

  it('路径长度不对（落子类棋的形状）被拒', () => {
    const code = playingRoom();
    expect(failWith(move(code, ALICE.id, [[6, 0]]))).toBe('illegalMove');
    expect(failWith(move(code, ALICE.id, [[6, 0], [5, 0], [4, 0]]))).toBe('illegalMove');
  });

  it('终局后不能再走 → notPlaying', () => {
    const code = playingRoom();
    unwrap(resign(code, BOB.id));
    expect(failWith(move(code, ALICE.id, [[6, 0], [5, 0]]))).toBe('notPlaying');
  });
});

describe('中国象棋房间：终局与赢家归属', () => {
  it('认输：赢家是对手（黑席 = 红棋），endReason 是 resign', () => {
    const code = playingRoom();
    const view = unwrap(resign(code, BOB.id)).view;
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black'); // 黑席 = 先手席 = 执红
    expect(view.endReason).toBe('resign');
  });

  it('双方各点一次才重开；重开换的是一张全新棋盘', () => {
    const code = playingRoom();
    unwrap(move(code, ALICE.id, [[7, 7], [7, 4]])); // 炮二平五
    unwrap(move(code, BOB.id, [[2, 7], [2, 4]])); // 炮8平5
    unwrap(move(code, ALICE.id, [[9, 1], [7, 2]])); // 马二进三

    unwrap(resign(code, BOB.id));
    expect(unwrap(requestRematch(code, ALICE.id)).view.rematchVotes).toBe(1);
    const two = unwrap(requestRematch(code, BOB.id)).view;

    expect(two.status).toBe('playing');
    expect(two.rematchVotes).toBe(0);
    expect(two.turn).toBe(RED);
    expect(two.winner).toBeNull();
    expect(two.endReason).toBeNull();
    expect(two.lastMove).toBeNull();
    // 换的是全新棋盘（createBoard），重复局面历史也在其中
    expect(two.grid).toEqual(new XiangqiBoard().grid);
  });
});

describe('五种棋共用一张房号表：必须互不可见', () => {
  const others = [
    ['五子棋', () => unwrap(createGomoku(ALICE)).view.code],
    ['井字棋', () => unwrap(createTicTacToe(ALICE)).view.code],
    ['国际象棋', () => unwrap(createChess(ALICE)).view.code],
    ['国际跳棋', () => unwrap(createDraughts(ALICE)).view.code],
  ] as const;

  it('中国象棋的接口看不到其它四种棋的房间', () => {
    for (const [name, make] of others) {
      const code = make();
      expect(failWith(getSnapshot(code, ALICE.id)), `${name}的房号`).toBe('notFound');
      expect(failWith(joinRoom(code, BOB)), `${name}的房号`).toBe('notFound');
      expect(failWith(move(code, ALICE.id, [[6, 0], [5, 0]])), `${name}的房号`).toBe('notFound');
      expect(failWith(resign(code, ALICE.id)), `${name}的房号`).toBe('notFound');
    }
  });

  it('房间数与重置按游戏分开', () => {
    unwrap(createRoom(ALICE));
    unwrap(createGomoku(BOB));
    expect(__roomCount()).toBe(1);
    __resetXiangqiRooms();
    expect(__roomCount()).toBe(0);
  });
});
