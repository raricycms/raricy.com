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
  playMove,
  refreshPresence,
  requestRematch,
  resign,
  sweepRooms,
  type RoomError,
  type RoomResult,
} from '@/lib/gomoku-room';
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

/** 建一局已就位的对局：Alice 执黑、Bob 执白。返回房号。 */
function playingRoom(): string {
  const created = unwrap(createRoom(ALICE));
  unwrap(joinRoom(created.view.code, BOB));
  return created.view.code;
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

    expect(snap.you).toEqual({ role: 'player', seat: 'black' });
    expect(snap.view.status).toBe('waiting');
    expect(snap.view.seats.black).toEqual({
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
    expect(getSnapshotView(code).seats.black?.connected).toBe(false);
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

describe('加入房间', () => {
  it('第二人入白席，状态转 playing，黑先', () => {
    const created = unwrap(createRoom(ALICE));
    const joined = unwrap(joinRoom(created.view.code, BOB));

    expect(joined.you).toEqual({ role: 'player', seat: 'white' });
    expect(joined.view.status).toBe('playing');
    expect(joined.view.turn).toBe(BLACK);
    expect(joined.view.seats.white?.name).toBe('鲍勃');
  });

  it('**幂等**：同一人重复加入拿回原席位，棋盘与 revision 都不动', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, 7, 7));

    const before = getSnapshotView(code);
    const again = unwrap(joinRoom(code, ALICE));

    expect(again.you).toEqual({ role: 'player', seat: 'black' }); // 没被挤成观众
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

    expect(spec.you).toEqual({ role: 'spectator', seat: null });
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
    expect(failWith(playMove('zzzzzz', ALICE.id, 7, 7))).toBe('notFound');
  });

  it('观众走子 → notASeat（观众只能看）', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));
    expect(failWith(playMove(code, CAROL.id, 7, 7))).toBe('notASeat');
  });

  it('非本房成员走子 → notASeat', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, 'u-stranger', 7, 7))).toBe('notASeat');
  });

  it('还没开赛（等对手）→ notPlaying', () => {
    const created = unwrap(createRoom(ALICE));
    expect(failWith(playMove(created.view.code, ALICE.id, 7, 7))).toBe('notPlaying');
  });

  it('不是自己的回合 → notYourTurn', () => {
    const code = playingRoom();
    // 黑先，白方抢先走
    expect(failWith(playMove(code, BOB.id, 7, 7))).toBe('notYourTurn');
  });

  it('越界 → illegalMove', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, ALICE.id, -1, 0))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, 0, -1))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, BOARD_SIZE, 0))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, 0, BOARD_SIZE))).toBe('illegalMove');
  });

  it('非整数坐标 → illegalMove（JSON 里塞字符串/小数/NaN）', () => {
    const code = playingRoom();
    expect(failWith(playMove(code, ALICE.id, 1.5, 0))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, 0, NaN))).toBe('illegalMove');
    expect(failWith(playMove(code, ALICE.id, '7' as never, 7))).toBe('illegalMove');
  });

  it('已占位 → illegalMove', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, 7, 7));
    expect(failWith(playMove(code, BOB.id, 7, 7))).toBe('illegalMove');
  });

  it('失败的一手不改变任何状态（轮次、revision、棋盘）', () => {
    const code = playingRoom();
    const before = getSnapshotView(code);

    failWith(playMove(code, BOB.id, 7, 7)); // 不是他的回合
    failWith(playMove(code, ALICE.id, 99, 99)); // 越界

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

    const after = unwrap(playMove(code, ALICE.id, 7, 7)).view;

    expect(after.grid[7][7]).toBe(BLACK);
    expect(after.turn).toBe(WHITE);
    expect(after.lastMove).toEqual({ row: 7, col: 7, player: BLACK });
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('网格是副本：客户端拿到的那份改不动服务端棋盘', () => {
    const code = playingRoom();
    const view = unwrap(playMove(code, ALICE.id, 7, 7)).view;

    view.grid[7][7] = 0 as never;

    expect(getSnapshotView(code).grid[7][7]).toBe(BLACK);
  });
});

// ── 胜负 ────────────────────────────────────────────────────────────────────

describe('胜负判定', () => {
  /** 黑走 (7,4..8) 五连，白在别处应着。 */
  function blackWinsFive(code: string) {
    for (let i = 0; i < 5; i++) {
      unwrap(playMove(code, ALICE.id, 7, 4 + i));
      if (i < 4) unwrap(playMove(code, BOB.id, 9, 4 + i));
    }
  }

  it('五连即判胜，winner 与 winningLine 正确落位', () => {
    const code = playingRoom();
    blackWinsFive(code);

    const view = getSnapshotView(code);
    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');
    expect(view.winningLine).toEqual([
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

    expect(failWith(playMove(code, BOB.id, 0, 0))).toBe('notPlaying');
  });

  it('长连（7 子）同样判胜 —— 靠最后补中间的空才走得出来', () => {
    // 【为什么不能顺序填】从左往右连填 5 子时，第 5 子就已经判胜、对局结束，
    // 第 6 子根本没机会落。要造出长连，必须把**中间那格留到最后**：
    // 黑先在 3/4/5/6 与 8/9 各落，最后补 7 把两段接成一条 7 连。
    const code = playingRoom();
    const whiteFar = [0, 2, 4, 6, 8, 10]; // 白方在 0 列散着走，绝不凑成连
    for (const c of [3, 4, 5, 6, 8, 9]) {
      unwrap(playMove(code, ALICE.id, 7, c));
      unwrap(playMove(code, BOB.id, whiteFar.shift()!, 0));
    }
    expect(getSnapshotView(code).status).toBe('playing'); // 还没连上

    const view = unwrap(playMove(code, ALICE.id, 7, 7)).view;

    expect(view.status).toBe('won');
    expect(view.winner).toBe('black');
    expect(view.winningLine).toEqual([
      [7, 3],
      [7, 4],
      [7, 5],
      [7, 6],
      [7, 7],
      [7, 8],
      [7, 9],
    ]);
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
      const blackMove = unwrap(playMove(code, ALICE.id, blacks[i][0], blacks[i][1]));
      expect(blackMove.view.status).toBe(i === blacks.length - 1 ? 'draw' : 'playing');
      if (i < whites.length) {
        unwrap(playMove(code, BOB.id, whites[i][0], whites[i][1]));
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
    unwrap(joinRoom(code, BOB, T0));
    const offA = connect(code, ALICE.id, T0);
    connect(code, BOB.id, T0);

    expect(failWith(claimAbandoned(code, ALICE.id, T0))).toBe('opponentPresent');
    offA();
  });

  it('对手掉线但不满 60 秒 → notDisconnectedLongEnough；满 60 秒即可判胜', () => {
    const created = unwrap(createRoom(ALICE, T0));
    const code = created.view.code;
    unwrap(joinRoom(code, BOB, T0));
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
    unwrap(joinRoom(code, BOB, T0));
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
    unwrap(joinRoom(code, BOB, T0));
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
    unwrap(joinRoom(code, BOB, T0));
    unwrap(joinRoom(code, CAROL, T0));

    expect(failWith(claimAbandoned(code, CAROL.id, T0 + 600_000))).toBe('notASeat');
  });
});

describe('再来一局', () => {
  it('双方各点一次才重开；重开后棋盘清空、黑先，但**席位与 revision 不重置**', () => {
    const code = playingRoom();
    unwrap(playMove(code, ALICE.id, 7, 7));
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
    unwrap(joinRoom(code, BOB, T0));
    const off = connect(code, ALICE.id, T0);

    const mid = T0 + __constants.IDLE_TTL_MS - 1;
    unwrap(playMove(code, ALICE.id, 7, 7, mid));

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

// ── 快照不泄露身份 ──────────────────────────────────────────────────────────

describe('快照的隐私边界', () => {
  it('公开状态只出显示名，绝不出 userId', () => {
    const code = playingRoom();
    const serialized = JSON.stringify(getSnapshotView(code));

    expect(serialized).toContain('爱丽丝');
    expect(serialized).toContain('鲍勃');
    expect(serialized).not.toContain(ALICE.id);
    expect(serialized).not.toContain(BOB.id);
  });

  it('you 只对自己生效：同一房号不同人取快照，you 各不同', () => {
    const code = playingRoom();
    unwrap(joinRoom(code, CAROL));

    expect(unwrap(getSnapshot(code, ALICE.id)).you).toEqual({ role: 'player', seat: 'black' });
    expect(unwrap(getSnapshot(code, CAROL.id)).you).toEqual({ role: 'spectator', seat: null });
    // 陌生人也能看到公开状态（观战），但不是成员
    expect(unwrap(getSnapshot(code, 'u-stranger')).you).toEqual({
      role: 'spectator',
      seat: null,
    });
  });
});
