// /api/fish/market/rent —— 用鱼干租头像框（route handler 层）
//
// 【为什么单独一个文件】服务层（tests/service/frame-shop-service.test.ts）已经把
// 记账、到期口径、各种拒卖都测透了，这一层只管三件只有它才管的事：
//   · **档位**：401（没登录）/ 403（被禁言）
//   · **它只认会话** —— 这是 /api/fish/market/* 里唯一一条不走 requireMarketActor
//     的路由（理由见 route.ts 文件头）。**这一条要被钉住**：带着 username+password
//     来会被当成「没登录」，而不是悄悄放行 —— 那扇门一旦被谁顺手打开，
//     租金就成了对外契约。
//   · **下发的形状**：到期时刻给两种形状（机器读 ISO、人读展示串），
//     展示串由服务端算好，客户端不做时间比较。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。磁盘隔离见下方的 TEST_FRAMES_DIR。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

const TEST_FRAMES_DIR = path.resolve(import.meta.dirname, '../.tmp/frames-rent-test');
process.env.FRAMES_DIR = TEST_FRAMES_DIR;

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { POST } from '@/app/api/fish/market/rent/route';
import { resetDb } from '../helpers/db';
import { expectLedgerConsistent, makeFishUser } from '../helpers/fish-ledger';
import { createSessionToken } from '@/lib/session';
import { hashPassword } from '@/lib/password';
import { prisma } from '@/lib/db';
import { FRAME_KEYS, FRAMES } from '@/lib/frame-refs';
import { __resetFrameAssetCacheForTests } from '@/lib/frame-service';

/** 唯一在售的框（价格与在架清单都从源码取）。 */
const KEY = 'fishblue';
/** 一款不零售的框 —— 站长发放的那种。 */
const NOT_FOR_SALE = FRAME_KEYS.find((k) => FRAMES[k].rentPerDay === undefined)!;
/** 无状态凭据那条路要用的真密码（见「拿正确的凭据来也不行」那条用例）。 */
const PASSWORD = 'correct-horse-battery';

const PNG_HEAD = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);

function assertTempDir() {
  if (!TEST_FRAMES_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑商城用例：${TEST_FRAMES_DIR}`);
  }
}

function writeAsset(key: string) {
  fs.mkdirSync(TEST_FRAMES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_FRAMES_DIR, `${key}.png`), PNG_HEAD);
  __resetFrameAssetCacheForTests();
}

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

const rent = (body: unknown) =>
  POST(
    new Request('http://localhost/api/fish/market/rent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeAll(() => {
  assertTempDir();
});

afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
  __resetFrameAssetCacheForTests();
  session.token = undefined;
  await resetDb();
});

describe('鉴权：只认会话', () => {
  it('没登录 → 401', async () => {
    const res = await rent({ frame_key: KEY, days: 1 });
    expect(res.status).toBe(401);
  });

  it('★ 拿**正确**的 username + password 来也不行 —— 这道门刻意没开', async () => {
    // 服务层那条「无状态凭据」的路（requireMarketActor 的第三道门）**不能**
    // 在租框上生效：一旦生效，租金就从内部实现变成对外契约（改价 = 破坏兼容）。
    // 凭据必须是真的 —— 拿假密码去测，401 可能只是密码错，证明不了门没开。
    const user = await makeFishUser(10, {
      username: 'rich',
      passwordHash: await hashPassword(PASSWORD),
    });
    const res = await rent({ username: 'rich', password: PASSWORD, frame_key: KEY, days: 1 });
    expect(res.status).toBe(401);
    // 顺带确认它真的什么都没干（余额没动、框没建）
    expect(await balanceOf(user.id)).toBeCloseTo(10, 4);
    expect(
      await prisma.userFrame.findUnique({
        where: { uq_user_frame: { userId: user.id, frameKey: KEY } },
        select: { id: true },
      })
    ).toBeNull();
  });

  it('被禁言 → 403，且不扣钱', async () => {
    const user = await makeFishUser(10);
    await prisma.user.update({ where: { id: user.id }, data: { isBanned: true, banUntil: null } });
    await login(user.id);

    const res = await rent({ frame_key: KEY, days: 1 });
    expect(res.status).toBe(403);
    await expectLedgerConsistent('禁言用户下单被拒');
  });
});

describe('入参校验', () => {
  it('天数非法 → 400', async () => {
    writeAsset(KEY);
    const user = await makeFishUser(10);
    await login(user.id);

    for (const days of [0, 31, 1.5, 'abc', null]) {
      const res = await rent({ frame_key: KEY, days });
      expect(res.status, `days=${JSON.stringify(days)}`).toBe(400);
    }
  });

  it('未登记的 key / 不零售的框 → 400', async () => {
    writeAsset(KEY);
    writeAsset(NOT_FOR_SALE);
    const user = await makeFishUser(10);
    await login(user.id);

    expect((await rent({ frame_key: 'nope', days: 1 })).status).toBe(400);
    expect((await rent({ frame_key: NOT_FOR_SALE, days: 1 })).status).toBe(400);
  });

  it('请求体不是对象 → 400', async () => {
    // 先登录 —— 鉴权在解析请求体**之前**，没登录时这一条只会拿到 401
    const user = await makeFishUser(10);
    await login(user.id);

    const res = await POST(
      new Request('http://localhost/api/fish/market/rent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[]',
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('成功与业务失败', () => {
  it('租成功 → 200，余额与到期都下来了（到期给两种形状）', async () => {
    writeAsset(KEY);
    const user = await makeFishUser(10);
    await login(user.id);

    const res = await rent({ frame_key: KEY, days: 2 });
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.code).toBe(200);
    expect(body.frame_key).toBe(KEY);
    expect(body.days).toBe(2);
    expect(body.cost).toBe(2 * FRAMES[KEY].rentPerDay!);
    expect(body.balance).toBeCloseTo(8, 4);
    // 机器读 ISO、人读展示串 —— 两者都指向同一刻
    expect(String(body.expires_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(body.expires_at_text)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 这条路由是**真动钱**的（扣鱼干 + 建持有行同一事务）——
    // 「余额 == 他所有流水之和」这条不变式在本层也要核一遍
    await expectLedgerConsistent('租框成功');
  });

  it('小鱼干不足 → 400，且**没有留下半张框**', async () => {
    writeAsset(KEY);
    const user = await makeFishUser(1);
    await login(user.id);

    const res = await rent({ frame_key: KEY, days: 5 });
    expect(res.status).toBe(400);
    expect(String((await json(res)).message)).toContain('小鱼干不足');

    expect(
      await prisma.userFrame.findUnique({
        where: { uq_user_frame: { userId: user.id, frameKey: KEY } },
        select: { id: true },
      })
    ).toBeNull();
    // 事务回滚之后账目也得是自洽的（余额、流水、持有行三样一起没写入）
    await expectLedgerConsistent('余额不足被拒');
  });

  it('素材缺失 → 409', async () => {
    // 故意不铺素材
    const user = await makeFishUser(10);
    await login(user.id);

    const res = await rent({ frame_key: KEY, days: 1 });
    expect(res.status).toBe(409);
    await expectLedgerConsistent('素材缺失被拒');
  });
});

/** 某个用户当前的余额（鱼干）。 */
async function balanceOf(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return (u?.driedFish ?? 0) / 10000;
}
