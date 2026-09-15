// POST /api/game/gomoku/rooms/:code/{seat, seat/leave, undo, undo/respond} —— 大厅与悔棋的 HTTP 那层
//
// 【为什么单独测路由】这四条的实现都在 api/game/_shared.ts 的工厂里（五款棋共用一份），
// service 层的语义已经由 tests/service/gomoku-room.test.ts 打过。这里打的是**只有
// HTTP 这一层才有的东西**，全是单测看不见、构建也不报错的：
//   1. body 形状。`accept` 只认布尔 —— 一个 'no' 字符串（真值）会被房间层当成"同意"，
//      那种错事后谁也想不通；`seat` 只认 black/white，认不出就 400 而不是含糊的 409。
//   2. 错误码 → HTTP 与文案。尤其是 noUndoRequest：它的真实场景是「你点同意的一瞬间
//      对手走了子」，文案得说人话，否则看着像按钮坏了。
//   3. 限频桶。大厅两条与 join 共用 `gameRoom` 桶 —— 客户端重连后自动回座走的也是它们，
//      各用一个宽桶就等于给"反复重连"开了后门。
//
// 本文件打真实 route handler（不 mock Prisma），只 mock 登录态。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 只替换 getCurrentUser，保留真实的 isCoreUser —— 权限判定本身是被测语义
const mockUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockUser.current };
});

import { makeUser, resetDb } from '../helpers/db';
import { POST as createRoomRoute } from '@/app/api/game/gomoku/rooms/route';
import { POST as joinRoomRoute } from '@/app/api/game/gomoku/rooms/[code]/join/route';
import { POST as moveRoute } from '@/app/api/game/gomoku/rooms/[code]/moves/route';
import { POST as takeSeatRoute } from '@/app/api/game/gomoku/rooms/[code]/seat/route';
import { POST as leaveSeatRoute } from '@/app/api/game/gomoku/rooms/[code]/seat/leave/route';
import { POST as undoRoute } from '@/app/api/game/gomoku/rooms/[code]/undo/route';
import { POST as undoRespondRoute } from '@/app/api/game/gomoku/rooms/[code]/undo/respond/route';
import { __resetGameBus } from '@/lib/game-bus';
import { __resetGomokuRooms } from '@/lib/gomoku-room';
import { __resetRateLimitStore, RULES } from '@/lib/rate-limit';
import type { RoomSnapshot } from '@/lib/board-shared';

beforeEach(async () => {
  await resetDb();
  __resetGomokuRooms();
  __resetGameBus();
  __resetRateLimitStore();
  mockUser.current = null;
});

type Handler = (req: Request, ctx: { params: Promise<{ code: string }> }) => Promise<Response>;

/** 打一条真实路由。房号走 params（与 Next 传的一致），body 是 JSON。 */
function call(
  handler: Handler,
  code: string,
  body?: unknown
): Promise<Response> {
  const req = new Request(`http://localhost/api/game/gomoku/rooms/${code}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return handler(req, { params: Promise.resolve({ code }) });
}

const create = (code = '') => call(createRoomRoute, code);
const join = (code: string) => call(joinRoomRoute, code);
const seat = (code: string, body: unknown) => call(takeSeatRoute, code, body);
const leave = (code: string) => call(leaveSeatRoute, code);
const undo = (code: string) => call(undoRoute, code);
const respond = (code: string, body: unknown) => call(undoRespondRoute, code, body);
const moveAt = (code: string, r: number, c: number) => call(moveRoute, code, { path: [[r, c]] });

async function snapshot(res: Response): Promise<RoomSnapshot> {
  const data = (await res.json()) as { room: RoomSnapshot };
  return data.room;
}

/** 建房（建房者执先手席），返回房号。 */
async function newRoom(): Promise<string> {
  mockUser.current = await makeUser({ role: 'core' });
  const res = await create();
  expect(res.status).toBe(200);
  return (await snapshot(res)).view.code;
}

/** 建一局两人都坐好的对局（顺带把 join → seat 这条链路也走一遍）。 */
async function seatedRoom() {
  const code = await newRoom();
  const alice = mockUser.current as { id: string; username: string };

  const bob = await makeUser({ role: 'core' });
  mockUser.current = bob;
  expect((await join(code)).status).toBe(200);
  expect((await seat(code, { seat: 'white' })).status).toBe(200);

  return { code, alice, bob };
}

describe('POST /rooms/:code/seat —— 坐席位', () => {
  it('席位名字认不出 → 400（不放进房间层，省得回一个含糊的 409）', async () => {
    const code = await newRoom();
    for (const bad of ['red', '', null, 1, undefined]) {
      const res = await seat(code, { seat: bad });
      expect(res.status, `seat=${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).message).toContain('席位');
    }
  });

  it('坐有人那一席 → 409「已经有人了」（waiting 房间：建房者占着黑席）', async () => {
    const code = await newRoom();
    mockUser.current = await makeUser({ role: 'core' });
    await join(code);

    const taken = await seat(code, { seat: 'black' });
    expect(taken.status).toBe(409);
    expect((await taken.json()).message).toContain('已经有人');
  });

  it('对局进行中坐哪儿都不行 → 409「对局进行中」，席上的人也不许退', async () => {
    const { code, bob } = await seatedRoom();

    mockUser.current = await makeUser({ role: 'core' });
    expect((await join(code)).status).toBe(200);
    const inGame = await seat(code, { seat: 'black' });
    expect(inGame.status).toBe(409);
    expect((await inGame.json()).message).toContain('对局进行中');

    mockUser.current = bob;
    const out = await leave(code);
    expect(out.status).toBe(409);
    expect((await out.json()).message).toContain('对局进行中');
  });

  it('未登录 → 401；不在座上退席 → 403', async () => {
    const code = await newRoom();
    const watcher = await makeUser({ role: 'core' });

    mockUser.current = null;
    expect((await seat(code, { seat: 'white' })).status).toBe(401);

    mockUser.current = watcher;
    expect((await leave(code)).status).toBe(403);
  });

  it('进了房就能坐上空席（join 只落观战台，坐哪一席由这里点名）', async () => {
    const code = await newRoom();
    mockUser.current = await makeUser({ role: 'core' });
    expect((await join(code)).status).toBe(200);

    const res = await seat(code, { seat: 'white' });
    expect(res.status).toBe(200);
    const snap = await snapshot(res);
    expect(snap.view.status).toBe('playing');
    expect(snap.you).toMatchObject({ role: 'player', seat: 'white' });
  });
});

describe('POST /rooms/:code/undo(+/respond) —— 悔棋', () => {
  it('没有可撤的棋 → 409；走一手后请求 → 200 且房内看得到那条请求', async () => {
    const { code, alice } = await seatedRoom();

    mockUser.current = alice;
    const empty = await undo(code);
    expect(empty.status).toBe(409);
    expect((await empty.json()).message).toContain('没有可以撤回');

    expect((await moveAt(code, 7, 7)).status).toBe(200); // 先手席落子
    const asked = await undo(code);
    expect(asked.status).toBe(200);
    const snap = await snapshot(asked);
    // 刚走完、轮对手 → 撤 1 步；请求本身**不带 userId**
    expect(snap.view.undoRequest).toEqual({ by: 'black', plies: 1 });
    expect(snap.view.plyCount).toBe(1);
  });

  it('对手同意 → 棋盘退回去；同意后的第二次回应 → 409「局面已变化」', async () => {
    const { code, alice, bob } = await seatedRoom();
    mockUser.current = alice;
    await moveAt(code, 7, 7);
    await undo(code);

    mockUser.current = bob;
    const accepted = await respond(code, { accept: true });
    expect(accepted.status).toBe(200);
    const snap = await snapshot(accepted);
    expect(snap.view.grid[7][7]).toBe(0);
    expect(snap.view.undoRequest).toBeNull();
    expect(snap.view.turn).toBe(1); // 退回到请求方（先手席）走

    const again = await respond(code, { accept: true });
    expect(again.status).toBe(409);
    expect((await again.json()).message).toContain('局面');
  });

  it('同一人再点一次 = 撤回请求（同一个接口的 toggle）', async () => {
    const { code, alice } = await seatedRoom();
    mockUser.current = alice;
    await moveAt(code, 7, 7);
    await undo(code);

    const cancelled = await undo(code);
    expect(cancelled.status).toBe(200);
    const snap = await snapshot(cancelled);
    expect(snap.view.undoRequest).toBeNull();
    expect(snap.view.grid[7][7]).toBe(1); // 只是撤回了请求，棋子还在
  });

  it('body 只认布尔：accept 传字符串 → 400（「no」是真值，会被当成同意）', async () => {
    const { code } = await seatedRoom();
    for (const bad of ['no', 1, '', null, undefined]) {
      const res = await respond(code, { accept: bad });
      expect(res.status, `accept=${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).message).toContain('参数');
    }
  });
});

describe('限频桶：大厅两条与 join 共用 gameRoom', () => {
  it(`建房 + ${RULES.gameRoom.limit - 1} 次 join 之后被挡（重连自动回座绕不开它）`, async () => {
    // 建房也吃同一个桶，所以这里只剩 limit - 1 次可用
    const code = await newRoom();

    for (let i = 0; i < RULES.gameRoom.limit - 1; i++) {
      expect((await join(code)).status, `第 ${i + 1} 次 join`).toBe(200);
    }

    // 同一个桶：换个接口（seat）也一样被挡 —— 限频键是 game:<棋种>:room:<userId>
    const blocked = await seat(code, { seat: 'white' });
    expect(blocked.status).toBe(429);
  });
});
