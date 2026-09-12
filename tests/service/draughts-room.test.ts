// draughts-room.ts —— 国际跳棋联机的房间层
//
// 【为什么还要测一遍房间层】房间逻辑与另外四款棋共用 board-room.ts，那一份已经由
// tests/service/gomoku-room.test.ts 覆盖了。这里只测**绑定的正确性**：
//   • 席位与先手的映射（1 = 黑席 = 白棋 = 建房者）
//   • 走子类棋的整手 path 提交链路 —— 跳棋这边尤其重要：**连吃是一条 path**
//   • 五种棋共用一张房号表之后的隔离
//
// 吃子强制 / 最大吃子 / 王的飞吃 / 升变时机 / 无棋可走判负由
// tests/unit/draughts-rules.test.ts 逐条钉住；这里验的是房间层原样把 path 交给
// 棋盘、并把 endReason 与 winner 正确写进快照。

import { describe, it, expect, beforeEach } from 'vitest';
import { BLACK, DraughtsBoard, KING, MAN, WHITE, glyphOf, isDark, piece } from '@/lib/draughts-rules';
import { __resetGameBus } from '@/lib/game-bus';
import {
  __resetDraughtsRooms,
  __roomCount,
  createRoom,
  getSnapshot,
  joinRoom,
  playMove,
  requestRematch,
  resign,
  type RoomResult,
} from '@/lib/draughts-room';
import { createRoom as createGomoku, __resetGomokuRooms } from '@/lib/gomoku-room';
import { createRoom as createTicTacToe, __resetTicTacToeRooms } from '@/lib/tictactoe-room';
import { createRoom as createChess, __resetChessRooms } from '@/lib/chess-room';
import { createRoom as createXiangqi, __resetXiangqiRooms } from '@/lib/xiangqi-room';

const ALICE = { id: 'u-alice', name: '爱丽丝' };
const BOB = { id: 'u-bob', name: '鲍勃' };
const CAROL = { id: 'u-carol', name: '卡罗尔' };

beforeEach(() => {
  __resetDraughtsRooms();
  __resetGomokuRooms();
  __resetTicTacToeRooms();
  __resetChessRooms();
  __resetXiangqiRooms();
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

describe('国际跳棋房间：建房与入座', () => {
  it('10×10 棋盘、建房者执先手席、状态 waiting', () => {
    const snap = unwrap(createRoom(ALICE));

    expect(snap.you).toEqual({ role: 'player', seat: 'black' });
    expect(snap.view.kind).toBe('draughts');
    expect(snap.view.rows).toBe(10);
    expect(snap.view.cols).toBe(10);
    expect(snap.view.status).toBe('waiting');
    // 先手席 = 1 = 白（国际跳棋白先）
    expect(snap.view.turn).toBe(WHITE);
    expect(WHITE).toBe(1);
  });

  it('开局 20 子对 20 子，全部落在深色格上', () => {
    const snap = unwrap(createRoom(ALICE));
    let white = 0;
    let black = 0;
    for (let r = 0; r < snap.view.rows; r++) {
      for (let c = 0; c < snap.view.cols; c++) {
        const cell = snap.view.grid[r][c];
        if (cell === 0) continue;
        expect(isDark(r, c), `(${r},${c}) 应落在深色格`).toBe(true);
        if (cell === piece(WHITE, MAN)) white++;
        if (cell === piece(BLACK, MAN)) black++;
      }
    }
    expect(white).toBe(20);
    expect(black).toBe(20);
    expect(glyphOf(snap.view.grid[6][1])).toBe('M');
    expect(glyphOf(snap.view.grid[3][0])).toBe('m');
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
    expect(failWith(move(code, CAROL.id, [[6, 1], [5, 0]]))).toBe('notASeat');
  });
});

describe('国际跳棋房间：走子', () => {
  it('兵斜进一步：轮次交替、lastMove 带整条路径', () => {
    const code = playingRoom();
    const after = unwrap(move(code, ALICE.id, [[6, 1], [5, 0]])).view;

    expect(after.grid[5][0]).toBe(piece(WHITE, MAN));
    expect(after.grid[6][1]).toBe(0);
    expect(after.turn).toBe(BLACK);
    expect(after.lastMove).toEqual({ path: [[6, 1], [5, 0]], player: WHITE });
  });

  it('客户端谎报一条吃子路径会被拒（服务端不认"我吃了"）', () => {
    // 跳棋开局前几手是"安静"的：双方还没接触，没有合法吃子 —— 这正是规则的样子。
    // 所以这里验的是另一面：**客户端自称走了条吃子路径，服务端凭什么信**。
    // (6,1)→(4,3) 的形状像"跳过 (5,2) 的吃子"，可 (5,2) 上根本没有子。
    // 真正的吃子（强制 / 最大吃子 / 连吃 / 飞吃）由 tests/unit/draughts-rules.test.ts 覆盖。
    const code = playingRoom();
    const before = viewOf(code);

    expect(failWith(move(code, ALICE.id, [[6, 1], [4, 3]]))).toBe('illegalMove');
    expect(failWith(move(code, ALICE.id, [[6, 1], [4, 3], [2, 5]]))).toBe('illegalMove');

    const after = viewOf(code);
    expect(after.grid).toEqual(before.grid);
    expect(after.revision).toBe(before.revision);
  });

  it('抢别人的回合 → notYourTurn；非法着法 → illegalMove 且棋盘没动', () => {
    const code = playingRoom();
    expect(failWith(move(code, BOB.id, [[3, 0], [4, 1]]))).toBe('notYourTurn');

    const before = viewOf(code);
    expect(failWith(move(code, ALICE.id, [[6, 1], [4, 3]]))).toBe('illegalMove'); // 兵不能一次走两格
    expect(failWith(move(code, ALICE.id, [[6, 0], [5, 1]]))).toBe('illegalMove'); // 浅色格上的空格
    expect(failWith(move(code, ALICE.id, [[9, 1], [8, 0]]))).toBe('illegalMove'); // 前面被自己人挡着
    const after = viewOf(code);
    expect(after.grid).toEqual(before.grid);
    expect(after.revision).toBe(before.revision);
  });

  it('路径长度不对（落子类棋的形状）被拒', () => {
    const code = playingRoom();
    expect(failWith(move(code, ALICE.id, [[6, 1]]))).toBe('illegalMove');
    expect(failWith(move(code, ALICE.id, [[6, 1], [5, 0], [4, 1]]))).toBe('illegalMove');
  });

  it('终局后不能再走 → notPlaying', () => {
    const code = playingRoom();
    unwrap(resign(code, BOB.id));
    expect(failWith(move(code, ALICE.id, [[6, 1], [5, 0]]))).toBe('notPlaying');
  });
});

describe('国际跳棋房间：终局与赢家归属', () => {
  it('认输：赢家是对手（黑席 = 白棋），endReason 是 resign', () => {
    const code = playingRoom();
    const view = unwrap(resign(code, BOB.id)).view;
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black'); // 黑席 = 先手席 = 执白
    expect(view.endReason).toBe('resign');
  });

  it('双方各点一次才重开；重开换的是一张全新棋盘', () => {
    const code = playingRoom();
    unwrap(move(code, ALICE.id, [[6, 1], [5, 0]]));
    unwrap(move(code, BOB.id, [[3, 0], [4, 1]]));

    unwrap(resign(code, BOB.id));
    expect(unwrap(requestRematch(code, ALICE.id)).view.rematchVotes).toBe(1);
    const two = unwrap(requestRematch(code, BOB.id)).view;

    expect(two.status).toBe('playing');
    expect(two.rematchVotes).toBe(0);
    expect(two.turn).toBe(WHITE);
    expect(two.winner).toBeNull();
    expect(two.endReason).toBeNull();
    expect(two.lastMove).toBeNull();
    expect(two.grid).toEqual(new DraughtsBoard().grid);
  });
});

describe('五种棋共用一张房号表：必须互不可见', () => {
  const others = [
    ['五子棋', () => unwrap(createGomoku(ALICE)).view.code],
    ['井字棋', () => unwrap(createTicTacToe(ALICE)).view.code],
    ['国际象棋', () => unwrap(createChess(ALICE)).view.code],
    ['中国象棋', () => unwrap(createXiangqi(ALICE)).view.code],
  ] as const;

  it('国际跳棋的接口看不到其它四种棋的房间', () => {
    for (const [name, make] of others) {
      const code = make();
      expect(failWith(getSnapshot(code, ALICE.id)), `${name}的房号`).toBe('notFound');
      expect(failWith(joinRoom(code, BOB)), `${name}的房号`).toBe('notFound');
      expect(failWith(move(code, ALICE.id, [[6, 1], [5, 0]])), `${name}的房号`).toBe('notFound');
      expect(failWith(resign(code, ALICE.id)), `${name}的房号`).toBe('notFound');
    }
  });

  it('房间数与重置按游戏分开', () => {
    unwrap(createRoom(ALICE));
    unwrap(createGomoku(BOB));
    expect(__roomCount()).toBe(1);
    __resetDraughtsRooms();
    expect(__roomCount()).toBe(0);
  });
});
