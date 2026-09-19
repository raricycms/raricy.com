// 鱼干只读凭据的自助接口（/api/fish/tokens）。
//
// 关注点全在**边界**上：只能动自己的、签发要 step-up、明文只回一次、
// 吊销立即生效。鉴权门本身（Bearer 能读不能写）在 fish-market-bot.test.ts 里测。
//
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 会话由 cookie 决定：单测里没有请求上下文，用可变 holder 模拟「有 / 没有会话」。
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { resetDb, makeUser, prisma } from '../helpers/db';
import { hashPassword } from '@/lib/password';
import { createSessionToken } from '@/lib/session';
import { __resetRateLimitStore, RULES, recordRateLimitHit } from '@/lib/rate-limit';
import { validateFishToken } from '@/lib/fish-token-service';
import { GET, POST } from '@/app/api/fish/tokens/route';
import { DELETE as revokeById } from '@/app/api/fish/tokens/[id]/route';

const PASSWORD = 'token-Password-123';

function makeReq(body?: unknown) {
  return new Request('http://localhost/api/fish/tokens', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeSessionUser(opts: { isBanned?: boolean } = {}) {
  const user = await makeUser({
    passwordHash: await hashPassword(PASSWORD),
    isBanned: opts.isBanned ?? false,
  } as Parameters<typeof makeUser>[0]);
  session.token = await createSessionToken({ uid: user.id, sv: 0 });
  return user;
}

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  session.token = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/fish/tokens', () => {
  it('未登录 → 401', async () => {
    expect((await GET()).status).toBe(401);
  });

  it('登录 → 列出自己的凭据，且**不返回明文也不返回哈希**', async () => {
    await makeSessionUser();
    const minted = await (await POST(makeReq({ password: PASSWORD }))).json();

    const res = await GET();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain(minted.secret);
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('token_hash');
  });

  it('空列表是 200 + 空数组，不是 404', async () => {
    await makeSessionUser();
    const json = await (await GET()).json();
    expect(json.tokens).toEqual([]);
  });
});

describe('POST /api/fish/tokens —— 签发', () => {
  it('★ 缺密码 → 400（step-up 不可跳过）', async () => {
    await makeSessionUser();
    const res = await POST(makeReq({ label: '机器人' }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('密码');
    expect(await prisma.fishApiToken.count()).toBe(0);
  });

  it('★ 密码错误 → 401，且零写入', async () => {
    await makeSessionUser();
    const res = await POST(makeReq({ password: 'definitely-wrong' }));
    expect(res.status).toBe(401);
    expect(await prisma.fishApiToken.count()).toBe(0);
  });

  it('密码错误消耗的是**登录失败预算**（不是第四条撞库通道）', async () => {
    const user = await makeSessionUser();
    const key = `login:user:${user.username.toLowerCase()}`;
    for (let i = 0; i < RULES.loginPerUser.limit; i++) recordRateLimitHit(key);

    const res = await POST(makeReq({ password: PASSWORD })); // 密码是对的，也必须被挡住
    expect(res.status).toBe(429);
    expect(await prisma.fishApiToken.count()).toBe(0);
  });

  it('正确密码 → 200，明文只在这一次响应里，且**当场可用**', async () => {
    await makeSessionUser();
    const res = await POST(makeReq({ password: PASSWORD, label: '对账机器人' }));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(json.token).toMatchObject({ label: '对账机器人', scopes: 'read' });
    expect(json.token.ttl_days).toBe(365);
    expect(json.message).toContain('只显示这一次');

    // 签发出来的串立刻能通过校验
    expect(await validateFishToken(json.secret)).not.toBeNull();
  });

  it('未登录 → 401（不受理无会话的签发）', async () => {
    const res = await POST(makeReq({ password: PASSWORD }));
    expect(res.status).toBe(401);
  });

  it('被禁言 → 403', async () => {
    await makeSessionUser({ isBanned: true });
    const res = await POST(makeReq({ password: PASSWORD }));
    expect(res.status).toBe(403);
  });

  it('超长 label → 400（不静默截断）', async () => {
    await makeSessionUser();
    const res = await POST(makeReq({ password: PASSWORD, label: 'x'.repeat(31) }));
    expect(res.status).toBe(400);
  });

  it('请求体不是对象 → 400', async () => {
    await makeSessionUser();
    const res = await POST(
      new Request('http://localhost/api/fish/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[1,2,3]',
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/fish/tokens/[id] —— 吊销', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('★ 吊销自己的 → 200，且令牌**立即**失效（不需要重新登录）', async () => {
    await makeSessionUser();
    const minted = await (await POST(makeReq({ password: PASSWORD }))).json();
    expect(await validateFishToken(minted.secret)).not.toBeNull();

    const res = await revokeById(makeReq(), ctx(String(minted.token.id)));
    expect(res.status).toBe(200);
    expect(await validateFishToken(minted.secret)).toBeNull();
  });

  it('★ 吊销别人的 → 403，且对方那张**仍然有效**', async () => {
    const other = await makeSessionUser();
    const theirs = await (await POST(makeReq({ password: PASSWORD }))).json();

    // 换成另一个用户
    const me = await makeUser({ passwordHash: await hashPassword(PASSWORD) });
    session.token = await createSessionToken({ uid: me.id, sv: 0 });

    const res = await revokeById(makeReq(), ctx(String(theirs.token.id)));
    expect(res.status).toBe(403);
    expect(await validateFishToken(theirs.secret), '不能隔空吊销别人的').not.toBeNull();
    expect(other.id).toBeTruthy();
  });

  it('不存在的 id → 404', async () => {
    await makeSessionUser();
    expect((await revokeById(makeReq(), ctx('999999'))).status).toBe(404);
  });

  it('非整数 id → 404（不落到 Prisma 上变成 500）', async () => {
    await makeSessionUser();
    for (const bad of ['abc', '1.5', '-1', '0']) {
      expect((await revokeById(makeReq(), ctx(bad))).status, `不该放行: ${bad}`).toBe(404);
    }
  });

  it('未登录 → 401', async () => {
    expect((await revokeById(makeReq(), ctx('1'))).status).toBe(401);
  });

  it('重复吊销是幂等的 → 仍然 200', async () => {
    await makeSessionUser();
    const minted = await (await POST(makeReq({ password: PASSWORD }))).json();
    const id = String(minted.token.id);
    expect((await revokeById(makeReq(), ctx(id))).status).toBe(200);
    expect((await revokeById(makeReq(), ctx(id))).status).toBe(200);
  });
});
