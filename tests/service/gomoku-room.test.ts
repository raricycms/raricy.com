// gomoku-room.ts —— 五子棋联机的房间注册表与服务端权威判定
//
// 【为什么测这些】联机之后客户端不可信，这个模块是唯一的裁判。写错的后果
// 全是对玩家可见而服务端不报错的：
//   • 走子校验漏一条 = 能抢走对手的回合 / 观众能落子 / 终局后还能走
//   • 幂等性破掉 = 刷新页面丢座（玩家以为自己在白席，其实成了观众）
//   • revision 语义错 = 客户端把过期棋盘当成最新的
//   • presence 判错 = 对手明明还在，却显示「已掉线」并可被判胜
//   • 回收漏掉 = 内存无界增长（房间是进程内的，没有别的兜底）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetGomokuRooms,
  __roomCount,
  __constants,
  claimAbandoned,
  createRoom,
  getSnapshot,
  joinRoom,
  leaveSeat,
  playMove,
  refreshPresence,
  requestRematch,
  requestUndo,
  resign,
  respondUndo,
  sweepRooms,
  takeSeat,
  type RoomError,
  type RoomResult,
  type RoomUser,
} from '@/lib/gomoku-room';
import type { Seat } from '@/lib/board-shared';
import { __resetGameBus, subscribe } from '@/lib/game-bus';
import { BLACK, BOARD_SIZE, WHITE } from '@/lib/gomoku-rules';

const ALICE = { id: 'u-alice', name: '爱丽丝' };
const BOB = { id: 'u-bob', name: '鲍勃' };
const CAROL = { id: 'u-carol', name: '卡罗尔' };

beforeEach(() => {
  __resetGomokuRooms();
  __resetGameBus();
});

function unwrap<T>(r: RoomResult<T>): T {
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.error}`);
  return r.value;
}

function failWith<T>(r: RoomResult<T>): RoomError {
  if (r.ok) throw new Error('期望失败，实际成功了');
  return r.error;
}

/** 坐到指定席位。大厅语义下进房只落观战台，坐哪儿要**显式点名**。 */
function seatIn(code: string, user: RoomUser, seat: Seat, now?: number) {
  return unwrap(takeSeat(code, user, seat, now));
}

/**
 * 建一局已就位的对局：Alice 执黑、Bob 执白。返回房号。
 *
 * 【顺带把双方连上】真实对局里两个人就是连着 SSE 的，而房间层的规则是
 * 「**没在对局中**时掉线即释放席位」—— 一局下完（won/draw）后再没人连着，
 * 两个席位就都被放回观战台了，那些"终局之后还要操作座位"的用例会全部撞上 notASeat。
 * 想构造掉线的对局请自己 `connect()` / 断开，别用这个helper。
 */
function playingRoom(): string {
  const created = unwrap(createRoom(ALICE));
  const code = created.view.code;
  seatIn(code, BOB, 'white');
  connect(code, ALICE.id);
  connect(code, BOB.id);
  return code;
}

/**
 * 模拟一条 SSE 连接（真订阅 bus），并在连接/断开后刷新 presence。
 *
 * 返回**断开函数**，它接受一个可选的断开时刻 —— 掉线判胜的用例要把服务端时间
 * 捏在手里，否则掉线时刻会等于连接时刻，60 秒窗口的边界根本测不到。
 */
function connect(
  code: string,
  userId: string,
  connectedAt = Date.now()
): (disconnectedAt?: number) => void {
  const off = subscribe({
    roomCode: code,
    viewerId: userId,
    write: () => true,
    close: () => {},
  });
  if (!off) throw new Error('订阅被 game-bus 拒绝（超过并发上限）');
  refreshPresence(code, userId, connectedAt);
  return (disconnectedAt = connectedAt) => {
    off();
    refreshPresence(code, userId, disconnectedAt);
  };
}

// ── 建房与加入 ──────────────────────────────────────────────────────────────

describe('建房', () => {
  it('建房者执黑，白席为空，状态 waiting，revision 从 1 起', () => {
    const snap = unwrap(createRoom(ALICE));

    // you 里除了角色与席位还带自己的 id —— 大厅名单里标「· 你」靠它（席位与观战台都可能是你）
    expect(snap.you).toEqual({ id: ALICE.id, role: 'player', seat: 'black' });
    expect(snap.view.status).toBe('waiting');
    expect(snap.view.seats.black).toEqual({
      id: ALICE.id,
      name: '爱丽丝',
      connected: false,
      disconnectedForMs: 0,
    });
    expect(snap.view.seats.white).toBeNull();
    expect(snap.view.revision).toBe(1);
    expect(snap.view.grid).toHaveLength(BOARD_SIZE);
    expect(snap.view.grid[0]).toHaveLength(BOARD_SIZE);
  });

  it('建房者初始算掉线（还没连 SSE），连上后转在线', () => {
    const snap = unwrap(createRoom(ALICE));
    const code = snap.view.code;
    expect(getSnapshotView(code).seats.black?.connected).toBe(false);

    const disconnect = connect(code, ALICE.id);
    expect(getSnapshotView(code).seats.black?.connected).toBe(true);

    disconnect();
    // 没在对局中 → 席位直接空出（人回到观战台）。**这是刻意的**：waiting 房间里的席位
    // 挡着下一个想坐的人，而掉线的人回来时会自动坐回原位（客户端侧，见 useOnlineRoom）。
    const after = getSnapshotView(code);
    expect(after.seats.black).toBeNull();
    expect(after.spectators.map((s) => s.name)).toEqual(['爱丽丝']);
  });

  it('房号是 6 位、全在字母表内、不含易混字符', () => {
    for (let i = 0; i < 20; i++) {
      const code = unwrap(createRoom(ALICE)).view.code;
      expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
    }
  });

  it(`房间数达到 ${__constants.MAX_ROOMS} 后拒绝建房`, () => {
    for (let i = 0; i < __constants.MAX_ROOMS; i++) {
      unwrap(createRoom({ id: `u-${i}`, name: `玩家${i}` }));
    }
    expect(failWith(createRoom({ id: 'u-extra', name: '多余' }))).toBe('tooManyRooms');
  });
});

/** 便捷读取当前公开状态。 */
function getSnapshotView(code: string, userId = ALICE.id) {
  return unwrap(getSnapshot(code, userId)).view;
}

describe('加入房间 / 大厅', () => {
  it('进房只落观战台，**点席位才入座**：两席满才开场，黑先', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;

    // 进房 ≠ 入座：先手/后手是本人点出来的，不该由"谁先点开链接"决定
    const joined = unwrap(joinRoom(code, BOB));
    expect(joined.you).toMatchObject({ role: 'spectator', seat: null });
    expect(joined.view.spectators.map((s) => `${s.name}:${s.id}`)).toEqual([`鲍勃:${BOB.id}`]);
    expect(joined.view.status).toBe('waiting'); // 还没开赛

    const seated = seatIn(code, BOB, 'white');
    expect(seated.you).toMatchObject({ role: 'player', seat: 'white' });
    expect(seated.view.status).toBe('playing');
    expect(seated.view.turn).toBe(BLACK);
    expect(seated.view.seats.white?.name).toBe('鲍勃');
    expect(seated.view.spectators).toHaveLength(0); // 入座即从观战台起身
  });

  it('坐已有人的席位 → seatTaken（不换人、也不顶掉别人）', () => {
    // waiting 房间：建房者占着黑席，白席空着
    const code = unwrap(createRoom(ALICE)).view.code;

    expect(failWith(takeSeat(code, BOB, 'black'))).toBe('seatTaken');
    expect(getSnapshotView(code).seats.black?.name).toBe('爱丽丝');
    seatIn(code, BOB, 'white'); // 空着的那一席随时可以坐
  });

  it('对局进行中换座 → inGame（席位在这时只可能坐满）', () => {
    const code = playingRoom();
    expect(failWith(takeSeat(code, CAROL, 'black'))).toBe('inGame');
    expect(failWith(leaveSeat(code, ALICE))).toBe('inGame'); // 席上的人也不许退
    expect(failWith(leaveSeat(code, CAROL))).toBe('inGame'); // 不在座上的更轮不到
  });

  it('**换先**：坐在一席上的人点另一席，原席位空出来', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;

    const moved = seatIn(code, ALICE, 'white'); // 建房者换到后手席
    expect(moved.you).toMatchObject({ role: 'player', seat: 'white' });
    expect(moved.view.seats.black).toBeNull();
    expect(moved.view.seats.white?.name).toBe('爱丽丝');
    expect(moved.view.status).toBe('waiting'); // 一席空着就还不是对局

    // 坐回自己已经在的那一席是幂等的（客户端重连自动回座会撞上这条）
    const again = seatIn(code, ALICE, 'white');
    expect(again.view.revision).toBe(moved.view.revision);
  });

  it('退到观战台：席位空出、人落到名单里；不在座上退 → notASeat', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;

    expect(failWith(leaveSeat(code, BOB))).toBe('notASeat');

    const left = unwrap(leaveSeat(code, ALICE));
    expect(left.you).toMatchObject({ role: 'spectator', seat: null });
    expect(left.view.seats.black).toBeNull();
    expect(left.view.spectators.map((s) => s.name)).toEqual(['爱丽丝']);
  });

  it('**幂等**：同一人重复加入拿回原席位，棋盘与 revision 都不动', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));

    const before = getSnapshotView(code);
    const again = unwrap(joinRoom(code, ALICE));

    expect(again.you).toMatchObject({ role: 'player', seat: 'black' }); // 没被挤成观众
    expect(again.view.revision).toBe(before.revision); // 没推流
    expect(again.view.grid[7][7]).toBe(BLACK); // 棋盘没被重置
    expect(again.view.status).toBe('playing');
  });

  it('加入不存在的房号 → notFound', () => {
    expect(failWith(joinRoom('zzzzzz', ALICE))).toBe('notFound');
  });

  it('两席坐满后第三人成为观众', () => {
    const code = playingRoom();
    const spec = unwrap(joinRoom(code, CAROL));

    expect(spec.you).toMatchObject({ role: 'spectator', seat: null });
    expect(spec.view.spectatorCount).toBe(1);
    expect(spec.view.seats.white?.name).toBe('鲍勃'); // 没被顶掉
  });

  it(`观众超过 ${__constants.MAX_SPECTATORS} 人时拒绝`, () => {
    const code = playingRoom();
    for (let i = 0; i < __constants.MAX_SPECTATORS; i++) {
      unwrap(joinRoom(code, { id: `spec-${i}`, name: `观众${i}` }));
    }
    expect(failWith(joinRoom(code, CAROL))).toBe('tooManySpectators');
  });

  it('观众重复加入是幂等的，不会把自己算成两个观众', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));
    const again = unwrap(joinRoom(code, CAROL));
    expect(again.you.role).toBe('spectator');
    expect(again.view.spectatorCount).toBe(1);
  });
});

// ── 走子校验矩阵 ────────────────────────────────────────────────────────────

describe('走子校验矩阵', () => {
  it('房间不存在 → notFound', () => {
    expect(failWith(playMove('zzzzzz', ALICE.id, { path: [[7, 7]] }))).toBe('notFound');
  });

  it('观众走子 → notASeat（观众只能看）', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));
    expect(failWith(playMove(code, CAROL.id, { path: [[7, 7]] }))).toBe('notASeat');
  });

  it('非本房成员走子 → notASeat', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, 'u-stranger', { path: [[7, 7]] }))).toBe('notASeat');
  });

  it('还没开赛（等对手）→ notPlaying', () => {
    const created = unwrap(createRoom(ALICE));
    expect(failWith(playMove(created.view.code, ALICE.id, { path: [[7, 7]] }))).toBe('notPlaying');
  });

  it('不是自己的回合 → notYourTurn', () => {
    const code = playingRoom();
    // 黑先，白方抢先走
    expect(failWith(playMove(code, BOB.id, { path: [[7, 7]] }))).toBe('notYourTurn');
  });

  it('越界 → illegalMove', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, ALICE.id, { path: [[-1, 0]] }))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, { path: [[0, -1]] }))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, { path: [[BOARD_SIZE, 0]] }))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, { path: [[0, BOARD_SIZE]] }))).toBe('illegalMove');
  });

  it('非整数坐标 → illegalMove（JSON 里塞字符串/小数/NaN）', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, ALICE.id, { path: [[1.5, 0]] }))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, { path: [[0, NaN]] }))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, { path: [['7' as never, 7]] }))).toBe('illegalMove');
  });

  it('已占位 → illegalMove', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    expect(failWith(playMove(code, BOB.id, { path: [[7, 7]] }))).toBe('illegalMove');
  });

  it('失败的一手不改变任何状态（轮次、revision、棋盘）', () => {
    const code = playingRoom();
    const before = getSnapshotView(code);

    failWith(playMove(code, BOB.id, { path: [[7, 7]] })); // 不是他的回合
    failWith(playMove(code, ALICE.id, { path: [[99, 99]] })); // 越界

    const after = getSnapshotView(code);
    expect(after.turn).toBe(before.turn);
    expect(after.revision).toBe(before.revision);
    expect(after.lastMove).toBeNull();
  });
});

describe('走子成功', () => {
  it('落子后轮次切换、revision 递增、lastMove 更新', () => {
    const code = playingRoom();
    const before = getSnapshotView(code);

    const after = unwrap(playMove(code, ALICE.id, { path: [[7, 7]] })).view;

    expect(after.grid[7][7]).toBe(BLACK);
    expect(after.turn).toBe(WHITE);
    expect(after.lastMove).toEqual({ path: [[7, 7]], player: BLACK });
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('网格是副本：客户端拿到的那份改不动服务端棋盘', () => {
    const code = playingRoom();
    const view = unwrap(playMove(code, ALICE.id, { path: [[7, 7]] })).view;

    view.grid[7][7] = 0;

    expect(getSnapshotView(code).grid[7][7]).toBe(BLACK);
  });
});

// ── 胜负 ────────────────────────────────────────────────────────────────────

describe('胜负判定', () => {
  /** 黑走 (7,4..8) 五连，白在别处应着。 */
  function blackWinsFive(code: string) {
    for (let i = 0; i < 5; i++) {
      unwrap(playMove(code, ALICE.id, { path: [[7, 4 + i]] }));
      if (i < 4) unwrap(playMove(code, BOB.id, { path: [[9, 4 + i]] }));
    }
  }

  it('五连即判胜，winner 与 winningLine 正确落位', () => {
    const code = playingRoom();
    blackWinsFive(code);

    const view = getSnapshotView(code);
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');
    expect(view.highlight).toEqual([
      [7, 4],
      [7, 5],
      [7, 6],
      [7, 7],
      [7, 8],
    ]);
  });

  it('终局后不能再走子 → notPlaying', () => {
    const code = playingRoom();
    blackWinsFive(code);

    expect(failWith(playMove(code, BOB.id, { path: [[0, 0]] }))).toBe('notPlaying');
  });

  /**
   * 造一条 7 连。**必须把中间那格留到最后**：从左往右顺序填时第 5 子就判胜、
   * 对局结束，第 6 子根本没机会落。所以先在 3/4/5/6 与 8/9 各落，最后补 7 把
   * 两段接成一条。
   *
   * 【注意手数】黑棋先手，所以造连的那一方必须正好拿到最后一手：黑棋造 7 连走
   * 第 13 手（黑 7 子、白 6 子），白棋造 7 连走第 14 手（黑 7 子、白 7 子）。
   * 直接让白棋先走会撞 `notYourTurn`。
   */
  function buildSeven(code: string, builder: 'black' | 'white'): void {
    const far = [0, 2, 4, 6, 8, 10, 12]; // 陪走的那方在 0 行散着走，绝不凑成连
    const gap = [3, 4, 5, 6, 8, 9];
    if (builder === 'black') {
      for (const c of gap) {
        unwrap(playMove(code, ALICE.id, { path: [[7, c]] }));
        unwrap(playMove(code, BOB.id, { path: [[0, far.shift()!]] }));
      }
    } else {
      for (const c of gap) {
        unwrap(playMove(code, ALICE.id, { path: [[0, far.shift()!]] }));
        unwrap(playMove(code, BOB.id, { path: [[7, c]] }));
      }
      unwrap(playMove(code, ALICE.id, { path: [[0, far.shift()!]] }));
    }
    // 最后一手「补中间那格」留给调用方 —— 那正是要断言的那一手
  }

  it('白棋长连（7 子）判胜 —— 白棋没有禁手', () => {
    const code = playingRoom();
    buildSeven(code, 'white');
    expect(getSnapshotView(code).status).toBe('playing'); // 还没连上

    const view = unwrap(playMove(code, BOB.id, { path: [[7, 7]] })).view;

    expect(view.status).toBe('won');
    expect(view.winner).toBe('white');
    expect(view.endReason).toBe('line');
    expect(view.highlight).toEqual([
      [7, 3],
      [7, 4],
      [7, 5],
      [7, 6],
      [7, 7],
      [7, 8],
      [7, 9],
    ]);
  });

  // 【这条是 2026-09 改口径的直接产物】在此之前长连也算胜，黑棋同样走得出来 ——
  // 同一份构造在那个口径下是"黑棋长连判胜"的用例。现在黑棋的长连是禁手点，
  // 走不上去，而且**棋盘一格不能动**（一次落子被拒不该留下痕迹）。
  it('黑棋的长连点是禁手，落子被拒且棋盘不动', () => {
    const code = playingRoom();
    buildSeven(code, 'black');
    const before = getSnapshotView(code);

    expect(failWith(playMove(code, ALICE.id, { path: [[7, 7]] }))).toBe('illegalMove');

    const after = getSnapshotView(code);
    expect(after.status).toBe('playing');
    expect(after.turn).toBe(before.turn); // 被拒的一手不换手
    expect(after.grid).toEqual(before.grid);
    expect(after.lastMove).toEqual(before.lastMove);
  });

  it('黑棋的三三禁手同样被拒（不是只有长连）', () => {
    // 十字：黑在中心补一手，横竖各成一个活三 —— Renju 里这是黑棋的禁手点
    const code = playingRoom();
    const whiteFar = [0, 2, 4, 6];
    for (const [r, c] of [
      [6, 7],
      [8, 7],
      [7, 6],
      [7, 8],
    ] as Array<[number, number]>) {
      unwrap(playMove(code, ALICE.id, { path: [[r, c]] }));
      unwrap(playMove(code, BOB.id, { path: [[0, whiteFar.shift()!]] }));
    }

    expect(failWith(playMove(code, ALICE.id, { path: [[7, 7]] }))).toBe('illegalMove');
  });

  it('满盘无五连 → 判和（draw，无 winner）', () => {
    const code = playingRoom();

    // 45° 斜条纹图案：(2r+c) % 4 < 2 —— 四方向最长同色连只有 2，
    // 且黑格 113 / 白格 112，正好能按「黑先、交替」落满。
    const blacks: Array<[number, number]> = [];
    const whites: Array<[number, number]> = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        ((2 * r + c) % 4 < 2 ? blacks : whites).push([r, c]);
      }
    }
    expect(blacks).toHaveLength(whites.length + 1); // 交替换手的前提

    for (let i = 0; i < blacks.length; i++) {
      const blackMove = unwrap(playMove(code, ALICE.id, { path: [[blacks[i][0], blacks[i][1]]] }));
      expect(blackMove.view.status).toBe(i === blacks.length - 1 ? 'draw' : 'playing');
      if (i < whites.length) {
        unwrap(playMove(code, BOB.id, { path: [[whites[i][0], whites[i][1]]] }));
      }
    }

    const view = getSnapshotView(code);
    expect(view.status).toBe('draw');
    expect(view.winner).toBeNull();
  });
});

// ── 认输 / 判胜 / 再来一局 ──────────────────────────────────────────────────

describe('认输', () => {
  it('认输方判负，对手获胜；未走子也能认输', () => {
    const code = playingRoom();
    const view = unwrap(resign(code, BOB.id)).view;

    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');
  });

  it('观众认输 → notASeat；等对手时认输 → notPlaying', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));
    expect(failWith(resign(code, CAROL.id))).toBe('notASeat');

    const waiting = unwrap(createRoom(ALICE)).view.code;
    expect(failWith(resign(waiting, ALICE.id))).toBe('notPlaying');
  });

  it('终局后再次认输 → notPlaying', () => {
    const code = playingRoom();
    unwrap(resign(code, BOB.id));
    expect(failWith(resign(code, ALICE.id))).toBe('notPlaying');
  });
});

describe('对手掉线判胜', () => {
  const T0 = 1_700_000_000_000;

  it('对手还在线 → opponentPresent', () => {
    const created = unwrap(createRoom(ALICE, T0));
    const code = created.view.code;
    seatIn(code, BOB, 'white', T0);
    const offA = connect(code, ALICE.id, T0);
    connect(code, BOB.id, T0);

    expect(failWith(claimAbandoned(code, ALICE.id, T0))).toBe('opponentPresent');
    offA();
  });

  it('对手掉线但不满 60 秒 → notDisconnectedLongEnough；满 60 秒即可判胜', () => {
    const created = unwrap(createRoom(ALICE, T0));
    const code = created.view.code;
    seatIn(code, BOB, 'white', T0);
    const offA = connect(code, ALICE.id, T0);
    const offB = connect(code, BOB.id, T0);

    const droppedAt = T0 + 5_000;
    offB(droppedAt); // 白方掉线
    expect(getSnapshotView(code).seats.white?.connected).toBe(false);

    // 59.999 秒：差 1ms 也不行
    expect(
      failWith(claimAbandoned(code, ALICE.id, droppedAt + __constants.DISCONNECT_CLAIM_MS - 1))
    ).toBe('notDisconnectedLongEnough');

    const view = unwrap(
      claimAbandoned(code, ALICE.id, droppedAt + __constants.DISCONNECT_CLAIM_MS)
    ).view;
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');

    offA();
  });

  it('掉线者重新连上后不能再被判胜（重连即撤销，避免误判掉线吃亏）', () => {
    const created = unwrap(createRoom(ALICE, T0));
    const code = created.view.code;
    seatIn(code, BOB, 'white', T0);
    const offA = connect(code, ALICE.id, T0);
    const offB = connect(code, BOB.id, T0);

    offB(T0 + 5_000); // 白方掉线
    const backB = connect(code, BOB.id, T0 + 10_000); // 又连上了

    expect(getSnapshotView(code).seats.white?.connected).toBe(true);
    // 哪怕过了很久，只要人还在就不能判胜
    expect(failWith(claimAbandoned(code, ALICE.id, T0 + 600_000))).toBe('opponentPresent');

    backB();
    offA();
  });

  it('快照给出「已掉线多久」，客户端据此决定何时显示判胜按钮', () => {
    const created = unwrap(createRoom(ALICE, T0));
    const code = created.view.code;
    seatIn(code, BOB, 'white', T0);
    const offA = connect(code, ALICE.id, T0);
    const offB = connect(code, BOB.id, T0);

    offB(T0 + 5_000); // 白方在 T0+5000 掉线

    expect(
      unwrap(getSnapshot(code, ALICE.id, T0 + 5_000)).view.seats.white
    ).toMatchObject({ connected: false, disconnectedForMs: 0 });

    // 时间由服务端算 —— 客户端刷新页面后也能知道已经等了多久
    expect(
      unwrap(getSnapshot(code, ALICE.id, T0 + 25_000)).view.seats.white?.disconnectedForMs
    ).toBe(20_000);

    // 重新连上后回到 null
    const backB = connect(code, BOB.id, T0 + 30_000);
    expect(
      unwrap(getSnapshot(code, ALICE.id, T0 + 30_000)).view.seats.white
    ).toMatchObject({ connected: true, disconnectedForMs: null });

    backB();
    offA();
  });

  it('观众不能判胜（notASeat）', () => {
    const created = unwrap(createRoom(ALICE, T0));
    const code = created.view.code;
    seatIn(code, BOB, 'white', T0);
    unwrap(joinRoom(code, CAROL, T0));

    expect(failWith(claimAbandoned(code, CAROL.id, T0 + 600_000))).toBe('notASeat');
  });
});

describe('再来一局', () => {
  it('双方各点一次才重开；重开后棋盘清空、黑先，但**席位与 revision 不重置**', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(resign(code, BOB.id));
    const beforeRematch = getSnapshotView(code);

    const one = unwrap(requestRematch(code, ALICE.id)).view;
    expect(one.rematchVotes).toBe(1);
    expect(one.status).toBe('won'); // 一票还不够

    const two = unwrap(requestRematch(code, BOB.id)).view;
    expect(two.status).toBe('playing');
    expect(two.rematchVotes).toBe(0);
    expect(two.winner).toBeNull();
    expect(two.turn).toBe(BLACK);
    expect(two.grid[7][7]).toBe(0); // 棋盘已清空
    expect(two.lastMove).toBeNull();

    // 席位保持原样（同色不换先）
    expect(two.seats.black?.name).toBe('爱丽丝');
    expect(two.seats.white?.name).toBe('鲍勃');
    // revision 继续递增，绝不回退
    expect(two.revision).toBeGreaterThan(beforeRematch.revision);
  });

  it('同一人重复点只算一票', () => {
    const code = playingRoom();
    unwrap(resign(code, BOB.id));

    unwrap(requestRematch(code, ALICE.id));
    const again = unwrap(requestRematch(code, ALICE.id)).view;

    expect(again.rematchVotes).toBe(1);
    expect(again.status).toBe('won');
  });

  it('对局进行中投票 → nothingToRematch；观众投票 → notASeat', () => {
    const code = playingRoom();
    expect(failWith(requestRematch(code, ALICE.id))).toBe('nothingToRematch');

    unwrap(joinRoom(code, CAROL));
    unwrap(resign(code, BOB.id));
    expect(failWith(requestRematch(code, CAROL.id))).toBe('notASeat');
  });
});

// ── 回收 ────────────────────────────────────────────────────────────────────

describe('房间回收', () => {
  const T0 = 1_700_000_000_000;

  it('空房（无人连接）超过 EMPTY_TTL 即回收', () => {
    const code = unwrap(createRoom(ALICE, T0)).view.code;

    sweepRooms(T0 + __constants.EMPTY_TTL_MS - 1);
    expect(__roomCount()).toBe(1);

    sweepRooms(T0 + __constants.EMPTY_TTL_MS);
    expect(__roomCount()).toBe(0);
    expect(failWith(getSnapshot(code, ALICE.id))).toBe('notFound');
  });

  it('有人连着就不按空房回收（等对手的房间不会被扫掉）', () => {
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    const off = connect(code, ALICE.id, T0);

    sweepRooms(T0 + __constants.EMPTY_TTL_MS * 3);
    expect(__roomCount()).toBe(1);

    off();
  });

  it('有连接但长时间无活动 → 按空闲 TTL 回收', () => {
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    const off = connect(code, ALICE.id, T0);

    sweepRooms(T0 + __constants.IDLE_TTL_MS - 1);
    expect(__roomCount()).toBe(1);

    sweepRooms(T0 + __constants.IDLE_TTL_MS);
    expect(__roomCount()).toBe(0);

    off();
  });

  it('走子会刷新活动时间，房间不会被误回收', () => {
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    seatIn(code, BOB, 'white', T0);
    const off = connect(code, ALICE.id, T0);

    const mid = T0 + __constants.IDLE_TTL_MS - 1;
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }, mid));

    sweepRooms(mid + 1000); // 距上次活动才 1 秒
    expect(__roomCount()).toBe(1);

    off();
  });

  it('回收时房间对所有人消失（快照与加入都 notFound）', () => {
    const code = unwrap(createRoom(ALICE, T0)).view.code;
    sweepRooms(T0 + __constants.IDLE_TTL_MS);

    expect(failWith(getSnapshot(code, ALICE.id))).toBe('notFound');
    expect(failWith(joinRoom(code, BOB))).toBe('notFound');
  });
});

// ── 席位与观战台的名单 ──────────────────────────────────────────────────────

describe('席位 / 观战台名单', () => {
  it('名单带 id（头像要用），但不带 email 这类身份信息', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;
    unwrap(joinRoom(code, BOB));
    const view = getSnapshotView(code);

    expect(view.seats.black).toMatchObject({ id: ALICE.id, name: '爱丽丝' });
    expect(view.spectators[0]).toMatchObject({ id: BOB.id, name: '鲍勃' });
    // id 是刻意给出去的（`/api/avatar/<id>` 与「· 你」都要它），但**只能有它**：
    // 这个结构会广播给全房，多一个字段就是多泄露一样东西。
    expect(Object.keys(view.seats.black!).sort()).toEqual([
      'connected',
      'disconnectedForMs',
      'id',
      'name',
    ]);
    expect(Object.keys(view.spectators[0]).sort()).toEqual([
      'connected',
      'disconnectedForMs',
      'id',
      'name',
    ]);
  });

  it('对局中不下发观战台名单（大厅的规矩是开局后隐藏观战台）', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));

    const view = getSnapshotView(code);
    expect(view.status).toBe('playing');
    expect(view.spectators).toEqual([]); // 名单是空的
    expect(view.spectatorCount).toBe(1); // 人数照旧给（席位栏显示「围观 N」）
  });

  it('观战台上的人掉线只标（掉线），不移出名单', () => {
    // 用没在对局中的房间：对局中名单根本不下发（见下一条）
    const code = unwrap(createRoom(ALICE)).view.code;
    unwrap(joinRoom(code, CAROL));
    const offC = connect(code, CAROL.id);
    expect(getSnapshotView(code).spectators[0].connected).toBe(true);

    offC();
    const view = getSnapshotView(code);
    expect(view.spectators).toHaveLength(1);
    expect(view.spectators[0]).toMatchObject({ name: '卡罗尔', connected: false });
  });

  it('**playing ⇒ 两席都有人**：对局中掉线不释放席位（由判胜兜底）', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;
    seatIn(code, BOB, 'white');
    const offA = connect(code, ALICE.id);
    connect(code, BOB.id);

    offA();
    const view = getSnapshotView(code);
    expect(view.status).toBe('playing');
    expect(view.seats.black).not.toBeNull(); // 还在座上，只是标了掉线
    expect(view.seats.black?.connected).toBe(false);
    expect(view.spectatorCount).toBe(0); // 没被放到观战台
  });

  it('对局结束（won）后掉线即释放席位，票也一并作废', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;
    seatIn(code, BOB, 'white');
    const offA = connect(code, ALICE.id);
    const offB = connect(code, BOB.id);

    unwrap(resign(code, BOB.id)); // 黑胜
    unwrap(requestRematch(code, ALICE.id)); // 黑方投了一票
    expect(getSnapshotView(code).rematchVotes).toBe(1);

    offA(); // 黑方走人
    const view = getSnapshotView(code);
    expect(view.status).toBe('won'); // 终局状态不因为空出席位而改变
    expect(view.seats.black).toBeNull();
    expect(view.spectators.map((s) => s.name)).toEqual(['爱丽丝']);
    expect(view.rematchVotes).toBe(0); // 不在座上的票不算数
    offB();
  });

  it('结束后补位**不会**把对局拉回 playing（要重开得双方各点一次）', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;
    seatIn(code, BOB, 'white');
    const offA = connect(code, ALICE.id);
    const offB = connect(code, BOB.id);
    unwrap(resign(code, BOB.id));
    offB(); // 白方离开，席位空出

    const filled = seatIn(code, CAROL, 'white'); // 观战台的人补位
    expect(filled.view.status).toBe('won'); // 仍然是上一局的终局
    expect(filled.view.winner).toBe('black');
    expect(filled.view.turn).toBe(BLACK);
    expect(filled.view.seats.white?.name).toBe('卡罗尔');
    offA();
  });

  it('终局时已经掉线的一方会被补一次释放（掉线是边沿触发的，不补就漏）', () => {
    const created = unwrap(createRoom(ALICE));
    const code = created.view.code;
    seatIn(code, BOB, 'white');
    const offA = connect(code, ALICE.id);
    const offB = connect(code, BOB.id);

    offB(); // 白方中途掉线（对局中：只标记，不释放）
    expect(getSnapshotView(code).seats.white).not.toBeNull();

    unwrap(resign(code, ALICE.id)); // 黑方认输收场 —— 白方此时已经不在线了
    const view = getSnapshotView(code);
    expect(view.status).toBe('won');
    expect(view.seats.white).toBeNull(); // 收场时补上释放
    expect(view.spectators.map((s) => s.name)).toEqual(['鲍勃']);
    offA();
  });
});

// ── 悔棋 ────────────────────────────────────────────────────────────────────

describe('悔棋', () => {
  /** 一连走 n 手（黑先交替），返回房号。 */
  function playSome(code: string, n: number) {
    const cols = [4, 5, 6, 7, 8, 9];
    for (let i = 0; i < n; i++) {
      unwrap(playMove(code, i % 2 === 0 ? ALICE.id : BOB.id, { path: [[7, cols[i]]] }));
    }
  }

  it('撤 1 步：轮对手走时点悔棋（对手还没应招），撤回自己刚走的那一步', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));

    const req = unwrap(requestUndo(code, ALICE.id)).view;
    expect(req.undoRequest).toEqual({ by: 'black', plies: 1 });
    expect(req.plyCount).toBe(1);

    const back = unwrap(respondUndo(code, BOB.id, true)).view;
    expect(back.undoRequest).toBeNull();
    expect(back.grid[7][7]).toBe(0); // 棋子收回
    expect(back.lastMove).toBeNull();
    expect(back.turn).toBe(BLACK); // 回到请求方走
    expect(back.plyCount).toBe(0);
  });

  it('撤 2 步：轮自己走时（对手已应招）连对手那一步一起撤掉', () => {
    const code = playingRoom();
    playSome(code, 2); // 黑 (7,4)、白 (7,5)

    const req = unwrap(requestUndo(code, ALICE.id)).view;
    expect(req.undoRequest).toEqual({ by: 'black', plies: 2 });

    const back = unwrap(respondUndo(code, BOB.id, true)).view;
    expect(back.grid[7][4]).toBe(0);
    expect(back.grid[7][5]).toBe(0);
    expect(back.turn).toBe(BLACK);
    expect(back.plyCount).toBe(0);
  });

  it('plyCount 与棋盘同生同灭（它就是悔棋那份栈的长度）', () => {
    const code = playingRoom();
    playSome(code, 3);
    expect(getSnapshotView(code).plyCount).toBe(3);

    // 轮黑走 → 白方要撤 2 步（自己那步 + 黑方那步）
    unwrap(requestUndo(code, BOB.id));
    expect(getSnapshotView(code).undoRequest).toEqual({ by: 'white', plies: 2 });

    const back = unwrap(respondUndo(code, ALICE.id, true)).view;
    expect(back.plyCount).toBe(1);
    expect(back.grid[7][4]).toBe(BLACK); // 只剩黑方第一步
    expect(back.turn).toBe(WHITE);
    // 走子类的「被将军」高亮复原在 tests/service/chess-room.test.ts 里钉（五子棋没有将军）
  });

  it('拒绝：棋盘一动不动，轮次照旧', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(requestUndo(code, ALICE.id));

    const before = getSnapshotView(code);
    const after = unwrap(respondUndo(code, BOB.id, false)).view;

    expect(after.undoRequest).toBeNull();
    expect(after.turn).toBe(before.turn);
    expect(after.grid[7][7]).toBe(BLACK);
    expect(after.plyCount).toBe(before.plyCount);
  });

  it('自己再点一次 = 撤回请求（同一个接口的 toggle）', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(requestUndo(code, ALICE.id));

    const cancelled = unwrap(requestUndo(code, ALICE.id)).view;
    expect(cancelled.undoRequest).toBeNull();
    expect(cancelled.grid[7][7]).toBe(BLACK); // 只是撤回了请求，棋子还在
  });

  it('对手已经发过请求 → undoPending（先回应那一条）', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(requestUndo(code, ALICE.id));

    expect(failWith(requestUndo(code, BOB.id))).toBe('undoPending');
  });

  it('没有可撤的棋 → nothingToUndo（开局第一手之前）', () => {
    const code = playingRoom();
    expect(failWith(requestUndo(code, ALICE.id))).toBe('nothingToUndo');
    expect(failWith(requestUndo(code, BOB.id))).toBe('nothingToUndo');
  });

  it('回应自己的请求 → noUndoRequest；没有请求时回应也一样', () => {
    const code = playingRoom();
    expect(failWith(respondUndo(code, ALICE.id, true))).toBe('noUndoRequest');

    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(requestUndo(code, ALICE.id));
    expect(failWith(respondUndo(code, ALICE.id, true))).toBe('noUndoRequest');
  });

  it('走一手就把待回应的请求作废（局面变了，悔的就不是那个局面）', () => {
    const code = playingRoom();
    playSome(code, 2);
    unwrap(requestUndo(code, ALICE.id)); // 黑方请求撤 2 步
    expect(getSnapshotView(code).undoRequest).not.toBeNull();

    unwrap(playMove(code, ALICE.id, { path: [[7, 9]] })); // 黑方改主意，直接走
    expect(getSnapshotView(code).undoRequest).toBeNull();
  });

  it('认输 / 判胜收场也作废待回应的请求', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(requestUndo(code, ALICE.id));

    const view = unwrap(resign(code, BOB.id)).view;
    expect(view.status).toBe('won');
    expect(view.undoRequest).toBeNull();
  });

  it('终局后不能悔棋 → notPlaying；观众悔棋 → notASeat', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));

    expect(failWith(requestUndo(code, CAROL.id))).toBe('notASeat');
    expect(failWith(respondUndo(code, CAROL.id, true))).toBe('notASeat');

    unwrap(resign(code, BOB.id));
    expect(failWith(requestUndo(code, ALICE.id))).toBe('notPlaying');
  });

  it('再来一局必须把悔棋的账一起清掉（否则第二局第一手会撤到上一局）', () => {
    const code = playingRoom();
    playSome(code, 5);
    unwrap(resign(code, BOB.id)); // 黑胜，checkStack 里还留着 5 步
    unwrap(requestRematch(code, ALICE.id));
    unwrap(requestRematch(code, BOB.id)); // 重开，换新棋盘

    const fresh = getSnapshotView(code);
    expect(fresh.status).toBe('playing');
    expect(fresh.plyCount).toBe(0); // ← 不变量：新棋盘的栈必须是空的

    // 第一手之后再悔棋，撤的是**这一手**，不是上一局的残留
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    unwrap(requestUndo(code, ALICE.id));
    const back = unwrap(respondUndo(code, BOB.id, true)).view;
    expect(back.plyCount).toBe(0);
    expect(back.grid[7][7]).toBe(0);
    expect(back.turn).toBe(BLACK); // 撤完仍轮黑走 —— 与棋盘内部的 turn 一致
  });

  it('悔棋也会推流（revision 单调递增）', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, { path: [[7, 7]] }));
    const r1 = getSnapshotView(code).revision;

    const r2 = unwrap(requestUndo(code, ALICE.id)).view.revision;
    const r3 = unwrap(respondUndo(code, BOB.id, true)).view.revision;

    expect(r2).toBeGreaterThan(r1);
    expect(r3).toBeGreaterThan(r2);
  });
});

// ── 快照不泄露身份 ──────────────────────────────────────────────────────────

describe('快照的隐私边界', () => {
  it('you 只对自己生效：同一房号不同人取快照，you 各不同', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));

    expect(unwrap(getSnapshot(code, ALICE.id)).you).toEqual({
      id: ALICE.id,
      role: 'player',
      seat: 'black',
    });
    expect(unwrap(getSnapshot(code, CAROL.id)).you).toEqual({
      id: CAROL.id,
      role: 'spectator',
      seat: null,
    });
    // 陌生人也能看到公开状态（观战），但不是成员
    expect(unwrap(getSnapshot(code, 'u-stranger')).you).toEqual({
      id: 'u-stranger',
      role: 'spectator',
      seat: null,
    });
  });
});
