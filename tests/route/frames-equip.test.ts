// /api/users/me/frame —— 装备 / 换框 / 卸下（route handler 层）
//
// 【为什么单独一个文件】服务层的写路径在 tests/service/frame-service.test.ts 里已经
// 测透了，但这一层还有三件只有它才管的事：
//   · **档位与归属**：401（没登录）/ 403（登录了但没持有）
//   · **`{}` 与 `{ frame_key: null }` 是两件事** —— 用 `body.frame_key ?? null`
//     会把「忘了传」静默当成「卸下」，那是一个**丢失用户状态**的默认值
//   · **下发的形状**是判定后的结果（url / expired / active），客户端不该自己算时间
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。磁盘隔离见下方的 TEST_FRAMES_DIR。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

const TEST_FRAMES_DIR = path.resolve(import.meta.dirname, '../.tmp/frames-equip-test');
process.env.FRAMES_DIR = TEST_FRAMES_DIR;

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { GET, PUT } from '@/app/api/users/me/frame/route';
import { resetDb, makeUser } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { FRAME_KEYS } from '@/lib/frame-refs';
import { __resetFrameAssetCacheForTests } from '@/lib/frame-service';

const KEY = FRAME_KEYS[0];
const DAY = 24 * 60 * 60 * 1000;

const PNG_HEAD = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);

function assertTempDir() {
  if (!TEST_FRAMES_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑头像框用例：${TEST_FRAMES_DIR}`);
  }
}

const login = async (userId: string) => {
  session.token = await createSessionToken({ uid: userId, sv: 0 });
};

const getFrame = () => GET();
const putFrame = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/users/me/frame', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** 读回某个用户的装备两列 —— 「有没有被写」一律看库，不看返回值。 */
const equipCols = (id: string) =>
  prisma.user.findUnique({
    where: { id },
    select: { equippedFrameKey: true, equippedFrameExpiresAt: true },
  });

/** 直接种一条持有行（绕过写路径，用来构造「已过期」这类只有时间能产生的状态）。 */
const seedHolding = (userId: string, expiresAt: Date | null) =>
  prisma.userFrame.create({
    data: { userId, frameKey: KEY, expiresAt, source: 'system', createdAt: nowForDb() },
  });

beforeAll(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_FRAMES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_FRAMES_DIR, `${KEY}.png`), PNG_HEAD);
});

afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
  __resetFrameAssetCacheForTests();
});

describe('档位：未登录一律 401', () => {
  it('GET 匿名 → 401', async () => {
    expect((await getFrame()).status).toBe(401);
  });

  it('PUT 匿名 → 401，且不写库', async () => {
    const u = await makeUser();
    await seedHolding(u.id, null);
    expect((await putFrame({ frame_key: KEY })).status).toBe(401);
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });
});

describe('PUT —— 归属与到期', () => {
  it('★ 没持有过 → 403，且库里一点没写', async () => {
    const u = await makeUser();
    await login(u.id);

    const res = await putFrame({ frame_key: KEY });
    expect(res.status).toBe(403);
    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBeNull();
    expect(cols?.equippedFrameExpiresAt).toBeNull();
  });

  it('★ 持有但已过期 → 403，且库里一点没写', async () => {
    const u = await makeUser();
    await login(u.id);
    await seedHolding(u.id, new Date(nowForDb().getTime() - 1000));

    expect((await putFrame({ frame_key: KEY })).status).toBe(403);
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });

  it('持有且未过期 → 200，两列被写，到期时刻 = 持有行的', async () => {
    const u = await makeUser();
    await login(u.id);
    const exp = new Date(nowForDb().getTime() + 30 * DAY);
    await seedHolding(u.id, exp);

    const res = await putFrame({ frame_key: KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frame_key: string };
    expect(body.frame_key).toBe(KEY);

    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBe(KEY);
    expect(cols?.equippedFrameExpiresAt?.getTime()).toBe(exp.getTime());
  });

  it('未登记的 key → 400', async () => {
    const u = await makeUser();
    await login(u.id);
    expect((await putFrame({ frame_key: 'no-such-frame' })).status).toBe(400);
  });

  it('frame_key 不是字符串 / null → 400（不静默当成卸下）', async () => {
    const u = await makeUser();
    await login(u.id);
    await seedHolding(u.id, null);

    expect((await putFrame({ frame_key: 42 })).status).toBe(400);
    expect((await putFrame({ frame_key: {} })).status).toBe(400);
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });

  it('★ 请求体里没有 frame_key 字段 → 400（`{}` 与 `{ frame_key: null }` 是两件事）', async () => {
    const u = await makeUser();
    await login(u.id);
    await seedHolding(u.id, null);
    // 先正常戴上
    expect((await putFrame({ frame_key: KEY })).status).toBe(200);

    // 空对象：若实现写成 `body.frame_key ?? null`，这会**静默地把框摘掉** ——
    // 一个「忘了传字段」的客户端调用会丢掉用户的状态，而响应还是 200
    expect((await putFrame({})).status).toBe(400);
    expect((await equipCols(u.id))?.equippedFrameKey, '框不该被摘掉').toBe(KEY);
  });

  it('请求体不是 JSON → 400', async () => {
    const u = await makeUser();
    await login(u.id);
    const res = await PUT(
      new Request('http://localhost/api/users/me/frame', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{ 这不是 JSON',
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('PUT { frame_key: null } —— 卸下', () => {
  it('戴着的时候卸下 → 两列清空', async () => {
    const u = await makeUser();
    await login(u.id);
    await seedHolding(u.id, null);
    await putFrame({ frame_key: KEY });

    const res = await putFrame({ frame_key: null });
    expect(res.status).toBe(200);
    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBeNull();
    expect(cols?.equippedFrameExpiresAt).toBeNull();
  });

  it('★ 没戴着也成功（幂等）', async () => {
    const u = await makeUser();
    await login(u.id);
    expect((await putFrame({ frame_key: null })).status).toBe(200);
  });

  it('★ 当前装备的是一个**白名单外的** key（已退役 / 已删）时，仍然卸得掉', async () => {
    // 这是「退役 key 变成摘不掉的僵尸装备」那条风险的唯一出路。
    // 直接写库构造这个状态（写路径本身不允许它出现）。
    const u = await makeUser();
    await login(u.id);
    await prisma.user.update({
      where: { id: u.id },
      data: { equippedFrameKey: 'a-key-that-no-longer-exists', equippedFrameExpiresAt: null },
    });

    expect((await putFrame({ frame_key: null })).status).toBe(200);
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });
});

describe('GET —— 下发的是判定后的结果', () => {
  it('没持有 → 空列表、equipped null', async () => {
    const u = await makeUser();
    await login(u.id);
    const body = (await (await getFrame()).json()) as { frames: unknown[]; equipped: unknown };
    expect(body.frames).toEqual([]);
    expect(body.equipped).toBeNull();
  });

  it('★ 服务端算好 url / expired / active —— 客户端一次都不判时间', async () => {
    const u = await makeUser();
    await login(u.id);
    await seedHolding(u.id, null);
    await putFrame({ frame_key: KEY });

    const body = (await (await getFrame()).json()) as {
      frames: { key: string; url: string | null; expired: boolean; available: boolean }[];
      equipped: { key: string; active: boolean; expiresAt: string | null } | null;
    };

    expect(body.frames).toHaveLength(1);
    expect(body.frames[0]).toMatchObject({
      key: KEY,
      url: `/api/frames/${KEY}`,
      expired: false,
      available: true,
    });
    expect(body.equipped).toMatchObject({ key: KEY, active: true, expiresAt: null });
    // 响应里**没有**任何需要客户端做时间比较的原始值（只有格式化好的展示串）
    expect(JSON.stringify(body)).not.toContain('equippedFrame');
  });
});
