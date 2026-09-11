// 「已绑定的应用」列表与解绑 —— 聚合口径 + 整应用撤销
//
// 【为什么单独测这个】v1 没有 refresh_token，外部应用每走一遍授权流程就新签一条
// 90 天 token。此前列表是「一 token 一行」，于是重复授权过的应用在设置页出现 N 次；
// 而「解除绑定」只吊销其中一条，用户以为解绑了、应用手里还剩 N-1 条有效凭证。
// 两处口径（列表按应用聚合、解绑按应用整体撤销）都在本文件钉住。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import {
  aggregateConnections,
  createAccessToken,
  createOAuthApplication,
  hashOpaqueToken,
  listUserConnections,
  revokeUserApplicationTokens,
  type ConnectionTokenRow,
} from '@/lib/oauth';
import { nowForDb } from '@/lib/db-time';

const CB = 'https://app.example.com/cb';
// 以**当前的库钟**为基准（nowForDb 是 UTC+8 墙上时间，见 db-time.ts）。
// 不能用写死的日期当基准：listUserConnections 滤的是 expiresAt > now，
// 写死 2026-01-01 建出来的 token 到今天就全是过期的，用例会莫名其妙全空。
const T0 = nowForDb();
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

async function makeApp(name = 'test-app', redirectUris = [CB]) {
  const owner = await makeUser({ role: 'owner' });
  const { application } = await createOAuthApplication({ name, redirectUris }, owner.id);
  return application;
}

/** 直接插一条 token 行，时间可控（走 createAccessToken 拿不到自定义 expiresAt）。 */
async function makeToken(
  applicationId: string,
  userId: string,
  opts: { createdAt?: Date; expiresAt?: Date; lastUsedAt?: Date; scopes?: string; revokedAt?: Date } = {}
) {
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  await prisma.oAuthAccessToken.create({
    data: {
      tokenHash: hashOpaqueToken(token),
      applicationId,
      userId,
      scopes: opts.scopes ?? 'profile',
      createdAt: opts.createdAt ?? days(0),
      expiresAt: opts.expiresAt ?? days(90),
      lastUsedAt: opts.lastUsedAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
  return token;
}

/** 纯函数用的行对象。 */
function row(over: Partial<ConnectionTokenRow> & { appId: string }): ConnectionTokenRow {
  return {
    applicationId: over.appId,
    scopes: over.scopes ?? 'profile',
    // 不能用 ??:显式传 createdAt: null 是「这一行没有 createdAt」的用例，
    // ?? 会把它当成没传而填上 T0，正好把要测的分支抹掉。
    createdAt: 'createdAt' in over ? (over.createdAt as Date | null) : T0,
    expiresAt: over.expiresAt ?? days(90),
    lastUsedAt: over.lastUsedAt ?? null,
    application: over.application ?? {
      id: over.appId,
      name: `app-${over.appId}`,
      homepageUrl: null,
      disabledAt: null,
    },
  };
}

beforeEach(async () => {
  await resetDb();
});

describe('aggregateConnections（纯函数口径）', () => {
  it('★ 同一应用的多条 token 聚合成一行，tokenCount 记条数', () => {
    const out = aggregateConnections(
      [row({ appId: 'a' }), row({ appId: 'a' }), row({ appId: 'a' })],
      T0
    );
    expect(out).toHaveLength(1);
    expect(out[0].tokenCount).toBe(3);
  });

  it('★ 时间取包络：最早授权 / 最近授权 / 最晚到期 / 最近使用', () => {
    const out = aggregateConnections(
      [
        row({ appId: 'a', createdAt: days(5), expiresAt: days(95), lastUsedAt: days(6) }),
        row({ appId: 'a', createdAt: days(1), expiresAt: days(120), lastUsedAt: days(30) }),
        row({ appId: 'a', createdAt: days(9), expiresAt: days(99), lastUsedAt: null }),
      ],
      T0
    );
    expect(out[0].firstAuthorizedAt).toEqual(days(1));
    expect(out[0].lastAuthorizedAt).toEqual(days(9));
    expect(out[0].expiresAt).toEqual(days(120));
    expect(out[0].lastUsedAt).toEqual(days(30));
  });

  it('全部从未被调用过 → lastUsedAt 为 null（不是 now）', () => {
    const out = aggregateConnections([row({ appId: 'a' }), row({ appId: 'a' })], T0);
    expect(out[0].lastUsedAt).toBeNull();
  });

  it('createdAt 缺失时回退到 now', () => {
    const out = aggregateConnections([row({ appId: 'a', createdAt: null })], days(7));
    expect(out[0].firstAuthorizedAt).toEqual(days(7));
    expect(out[0].lastAuthorizedAt).toEqual(days(7));
  });

  it('scopes 取并集且不重复', () => {
    const out = aggregateConnections(
      [row({ appId: 'a', scopes: 'profile' }), row({ appId: 'a', scopes: 'profile' })],
      T0
    );
    expect(out[0].scopes).toEqual(['profile']);
  });

  it('禁用应用的 token 不展示', () => {
    const out = aggregateConnections(
      [
        row({
          appId: 'a',
          application: { id: 'a', name: 'dead', homepageUrl: null, disabledAt: days(1) },
        }),
      ],
      T0
    );
    expect(out).toEqual([]);
  });

  it('不同应用各占一行，最近授权的排前面', () => {
    const out = aggregateConnections(
      [row({ appId: 'old', createdAt: days(1) }), row({ appId: 'new', createdAt: days(8) })],
      T0
    );
    expect(out.map((c) => c.applicationId)).toEqual(['new', 'old']);
  });
});

describe('listUserConnections（DB 口径）', () => {
  it('★ 重复授权同一个应用 → 只返回一行', async () => {
    const app = await makeApp();
    const user = await makeUser();
    await makeToken(app.id, user.id, { createdAt: days(1) });
    await makeToken(app.id, user.id, { createdAt: days(2) });
    await makeToken(app.id, user.id, { createdAt: days(3) });

    const conns = await listUserConnections(user.id);
    expect(conns).toHaveLength(1);
    expect(conns[0].applicationId).toBe(app.id);
    expect(conns[0].tokenCount).toBe(3);
    expect(conns[0].lastAuthorizedAt).toEqual(days(3));
  });

  it('两个应用 → 两行', async () => {
    const [appA, appB] = [await makeApp('app-a'), await makeApp('app-b')];
    const user = await makeUser();
    await makeToken(appA.id, user.id);
    await makeToken(appB.id, user.id);

    const conns = await listUserConnections(user.id);
    expect(conns.map((c) => c.applicationId).sort()).toEqual([appA.id, appB.id].sort());
  });

  it('已撤销 / 已过期的 token 不计入（也不撑起 tokenCount）', async () => {
    const app = await makeApp();
    const user = await makeUser();
    await makeToken(app.id, user.id, { createdAt: days(1) });
    await makeToken(app.id, user.id, { createdAt: days(2), revokedAt: days(3) });
    await makeToken(app.id, user.id, { createdAt: days(0), expiresAt: days(-1) });

    const conns = await listUserConnections(user.id);
    expect(conns).toHaveLength(1);
    expect(conns[0].tokenCount).toBe(1);
  });

  it('别人的 token 不串进来', async () => {
    const app = await makeApp();
    const [me, other] = [await makeUser(), await makeUser()];
    await makeToken(app.id, other.id);

    expect(await listUserConnections(me.id)).toEqual([]);
  });

  it('应用被停用 → 列表里不出现', async () => {
    const app = await makeApp();
    const user = await makeUser();
    await makeToken(app.id, user.id);
    await prisma.oAuthApplication.update({ where: { id: app.id }, data: { disabledAt: days(1) } });

    expect(await listUserConnections(user.id)).toEqual([]);
  });

  it('createAccessToken 签出来的真 token 同样被聚合', async () => {
    const app = await makeApp();
    const user = await makeUser();
    const a = await createAccessToken(app.id, user.id, ['profile']);
    const b = await createAccessToken(app.id, user.id, ['profile']);
    expect(a.token).not.toBe(b.token);

    const conns = await listUserConnections(user.id);
    expect(conns).toHaveLength(1);
    expect(conns[0].tokenCount).toBe(2);
  });
});

describe('revokeUserApplicationTokens（整应用解绑）', () => {
  it('★ 一次撤销该应用名下全部存活 token', async () => {
    const app = await makeApp();
    const user = await makeUser();
    for (let i = 0; i < 3; i++) await makeToken(app.id, user.id);

    const res = await revokeUserApplicationTokens(user.id, app.id);
    expect(res).toEqual({ found: true, revoked: 3 });

    const live = await prisma.oAuthAccessToken.count({
      where: { userId: user.id, applicationId: app.id, revokedAt: null },
    });
    expect(live).toBe(0);
    expect(await listUserConnections(user.id)).toEqual([]);
  });

  it('★ 不波及其他应用', async () => {
    const [appA, appB] = [await makeApp('app-a'), await makeApp('app-b')];
    const user = await makeUser();
    await makeToken(appA.id, user.id);
    await makeToken(appB.id, user.id);

    await revokeUserApplicationTokens(user.id, appA.id);
    const conns = await listUserConnections(user.id);
    expect(conns.map((c) => c.applicationId)).toEqual([appB.id]);
  });

  it('不波及其他用户在同一应用下的 token', async () => {
    const app = await makeApp();
    const [me, other] = [await makeUser(), await makeUser()];
    await makeToken(app.id, me.id);
    await makeToken(app.id, other.id);

    await revokeUserApplicationTokens(me.id, app.id);
    const otherLive = await prisma.oAuthAccessToken.count({
      where: { userId: other.id, applicationId: app.id, revokedAt: null },
    });
    expect(otherLive).toBe(1);
  });

  it('没有任何绑定时 found=false（路由据此回 404）', async () => {
    const app = await makeApp();
    const user = await makeUser();
    expect(await revokeUserApplicationTokens(user.id, app.id)).toEqual({
      found: false,
      revoked: 0,
    });
  });

  it('幂等：重复点「解除绑定」→ found=true 但不再撤销', async () => {
    const app = await makeApp();
    const user = await makeUser();
    await makeToken(app.id, user.id);

    expect(await revokeUserApplicationTokens(user.id, app.id)).toEqual({
      found: true,
      revoked: 1,
    });
    expect(await revokeUserApplicationTokens(user.id, app.id)).toEqual({
      found: true,
      revoked: 0,
    });
  });
});
