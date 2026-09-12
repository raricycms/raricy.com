// tictactoe-room.ts —— 井字棋联机的房间层
//
// 【为什么还要测一遍房间层】房间逻辑与五子棋共用 board-room.ts，那一份已经由
// tests/service/gomoku-room.test.ts 覆盖了。这里只测**绑定的正确性**，即
// 「把井字棋的棋盘挂上去之后，行为仍然成立」：
//   • 席位与先手的映射（1 = 黑席 = X = 建房者）
//   • 胜负线真的接上了（换成 3×3 之后 room 还能判出胜负与和棋）
//   • 两个游戏共用一张房号表之后的**隔离**：井字棋的接口看不到五子棋的房间
// 第三条是这次改动新引入的风险 —— 共用注册表才可能串号，必须钉住。

import { describe, it, expect, beforeEach } from 'vitest';
import { BLACK, BOARD_SIZE } from '@/lib/gomoku-rules';
import { O, X } from '@/lib/tictactoe-rules';
import { __resetGameBus } from '@/lib/game-bus';
import {
  __resetTicTacToeRooms,
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
} from '@/lib/tictactoe-room';
import {
  createRoom as createGomokuRoom,
  getSnapshot as gomokuSnapshot,
  joinRoom as joinGomokuRoom,
  __resetGomokuRooms,
  __roomCount as gomokuRoomCount,
} from '@/lib/gomoku-room';

const ALICE = { id: 'u-alice', name: '爱丽丝' };
const BOB = { id: 'u-bob', name: '鲍勃' };
const CAROL = { id: 'u-carol', name: '卡罗尔' };

beforeEach(() => {
  __resetTicTacToeRooms();
  __resetGomokuRooms();
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

/** 建一局已就位的对局：Alice 执 X、Bob 执 O。返回房号。 */
function playingRoom(): string {
  const created = unwrap(createRoom(ALICE));
  unwrap(joinRoom(created.view.code, BOB));
  return created.view.code;
}

function viewOf(code: string, userId = ALICE.id) {
  return unwrap(getSnapshot(code, userId)).view;
}

describe('井字棋房间：建房与入座', () => {
  it('3×3 棋盘、建房者执先手席、状态 waiting', () => {
    const snap = unwrap(createRoom(ALICE));

    expect(snap.you).toEqual({ role: 'player', seat: 'black' });
    expect(snap.view.kind).toBe('tictactoe');
    // 尺寸是 rows/cols 而不是单个 size —— 中国象棋是 9×10，方形假设表达不了
    expect(snap.view.rows).toBe(3);
    expect(snap.view.cols).toBe(3);
    expect(snap.view.grid).toHaveLength(3);
    expect(snap.view.grid[0]).toHaveLength(3);
    expect(snap.view.status).toBe('waiting');
    // 先手席 = 1 = X（井字棋的 X 与五子棋的黑共用同一个 1）
    expect(snap.view.turn).toBe(X);
    expect(X).toBe(BLACK); // 口径一致性的第二道钉子（第一道在 tictactoe-rules 的用例里）
  });

  it('第二人入后手席，状态转 playing，仍由先手落子', () => {
    const created = unwrap(createRoom(ALICE));
    const joined = unwrap(joinRoom(created.view.code, BOB));

    expect(joined.you).toEqual({ role: 'player', seat: 'white' });
    expect(joined.view.status).toBe('playing');
    expect(joined.view.turn).toBe(X);
  });

  it('两席坐满后第三人成为观众，走不了子', () => {
    const code = playingRoom();
    const spec = unwrap(joinRoom(code, CAROL));

    expect(spec.you).toEqual({ role: 'spectator', seat: null });
    expect(failWith(playMove(code, CAROL.id, { path: [[0, 0]] }))).toBe('notASeat');
  });

  it('刷新页面回到原座（join 幂等，棋盘与 revision 都不动）', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[1, 1]] }));
    const before = viewOf(code);

    const again = unwrap(joinRoom(code, ALICE));

    expect(again.you).toEqual({ role: 'player', seat: 'black' });
    expect(again.view.revision).toBe(before.revision);
    expect(again.view.grid[1][1]).toBe(X);
  });
});

describe('井字棋房间：走子与胜负', () => {
  it('落子后轮次交替、lastMove 更新', () => {
    const code = playingRoom();
    const after = unwrap(playMove(code, ALICE.id, { path: [[0, 0]] })).view;

    expect(after.grid[0][0]).toBe(X);
    expect(after.turn).toBe(O);
    expect(after.lastMove).toEqual({ path: [[0, 0]], player: X });
  });

  it('抢别人的回合 → notYourTurn；已占位 → illegalMove', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, BOB.id, { path: [[0, 0]] }))).toBe('notYourTurn');

    unwrap(playMove(code, ALICE.id, { path: [[0, 0]] }));
    expect(failWith(playMove(code, BOB.id, { path: [[0, 0]] }))).toBe('illegalMove');
  });

  it('越界坐标 → illegalMove（3×3 的边界比五子棋紧得多）', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, ALICE.id, { path: [[0, BOARD_SIZE]] }))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, { path: [[-1, 0]] }))).toBe('illegalMove');
  });

  it('三连即判胜：winner 落位、winningLine 是那三格', () => {
    const code = playingRoom();
    // X 走第一行，O 在第二行应着（两格不构成三连）
    unwrap(playMove(code, ALICE.id, { path: [[0, 0]] }));
    unwrap(playMove(code, BOB.id, { path: [[1, 0]] }));
    unwrap(playMove(code, ALICE.id, { path: [[0, 1]] }));
    unwrap(playMove(code, BOB.id, { path: [[1, 1]] }));
    const view = unwrap(playMove(code, ALICE.id, { path: [[0, 2]] })).view;

    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');
    expect(view.highlight).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
  });

  it('终局后不能再落子 → notPlaying', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[0, 0]] }));
    unwrap(playMove(code, BOB.id, { path: [[1, 0]] }));
    unwrap(playMove(code, ALICE.id, { path: [[0, 1]] }));
    unwrap(playMove(code, BOB.id, { path: [[1, 1]] }));
    unwrap(playMove(code, ALICE.id, { path: [[0, 2]] }));

    expect(failWith(playMove(code, BOB.id, { path: [[2, 2]] }))).toBe('notPlaying');
  });

  it('满盘无三连 → 判和（9 手就走完一局，是井字棋最常见的结局）', () => {
    const code = playingRoom();
    const seq: Array<[typeof ALICE.id, number, number]> = [
      [ALICE.id, 0, 0],
      [BOB.id, 0, 1],
      [ALICE.id, 0, 2],
      [BOB.id, 1, 1],
      [ALICE.id, 1, 0],
      [BOB.id, 1, 2],
      [ALICE.id, 2, 1],
      [BOB.id, 2, 0],
    ];
    for (const [who, r, c] of seq) expect(unwrap(playMove(code, who, { path: [[r, c]] })).view.status).toBe('playing');

    const last = unwrap(playMove(code, ALICE.id, { path: [[2, 2]] })).view;
    expect(last.status).toBe('draw');
    expect(last.winner).toBeNull();
    expect(last.highlight).toEqual([]);
  });
});

describe('井字棋房间：认输 / 判胜 / 再来一局', () => {
  it('认输方判负', () => {
    const code = playingRoom();
    const view = unwrap(resign(code, BOB.id)).view;
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');
  });

  it('对手掉线满 60 秒可判胜（时间由服务端复核）', () => {
    const T0 = 1_700_000_000_000;
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    unwrap(joinRoom(code, BOB, T0));

    // 没有 SSE 连接 → 两席都算掉线；Alice 判胜的对象是 Bob
    expect(failWith(claimAbandoned(code, ALICE.id, T0 + 1000))).toBe('notDisconnectedLongEnough');
  });

  it('双方各点一次才重开，重开后棋盘清空、同席不换先', () => {
    const code = playingRoom();
    unwrap(resign(code, BOB.id));

    expect(unwrap(requestRematch(code, ALICE.id)).view.rematchVotes).toBe(1);
    const two = unwrap(requestRematch(code, BOB.id)).view;

    expect(two.status).toBe('playing');
    expect(two.rematchVotes).toBe(0);
    expect(two.turn).toBe(X);
    expect(two.grid.flat().every((c) => c === 0)).toBe(true);
    expect(two.seats.black?.name).toBe('爱丽丝');
  });

  it('走子会刷新活动时间，房间不会被误回收', () => {
    const T0 = 1_700_000_000_000;
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    unwrap(joinRoom(code, BOB, T0));

    unwrap(playMove(code, ALICE.id, { path: [[0, 0]] }, T0 + 60_000));
    sweepRooms(T0 + 60_001);
    expect(__roomCount()).toBe(1);
  });
});

describe('两种棋共用一张房号表：必须互不可见', () => {
  it('井字棋的接口看不到五子棋的房间（按 notFound 处理，不泄露房号是否存在）', () => {
    const gomoku = unwrap(createGomokuRoom(ALICE)).view.code;

    expect(failWith(getSnapshot(gomoku, ALICE.id))).toBe('notFound');
    expect(failWith(joinRoom(gomoku, BOB))).toBe('notFound');
    expect(failWith(playMove(gomoku, ALICE.id, { path: [[0, 0]] }))).toBe('notFound');
    expect(failWith(resign(gomoku, ALICE.id))).toBe('notFound');
  });

  it('反之亦然：五子棋的接口看不到井字棋的房间', () => {
    const tic = unwrap(createRoom(ALICE)).view.code;
    // 必须走**五子棋自己的门面**（同一个注册表，但 kind 对不上）
    expect(failWith(gomokuSnapshot(tic, ALICE.id))).toBe('notFound');
    expect(failWith(joinGomokuRoom(tic, BOB))).toBe('notFound');
  });

  it('房间数与重置按游戏分开，两边互不干扰', () => {
    unwrap(createRoom(ALICE));
    unwrap(createGomokuRoom(BOB));

    expect(__roomCount()).toBe(1);
    expect(gomokuRoomCount()).toBe(1);

    __resetTicTacToeRooms();
    expect(__roomCount()).toBe(0);
    expect(gomokuRoomCount()).toBe(1); // 清井字棋不该动五子棋
  });
});
