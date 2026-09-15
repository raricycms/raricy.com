// 鱼干市场 · 无状态单次发包（凭据随请求走，不签发会话）
//
// 【为什么单独一个文件】这里打的是**真实 route handler**，重点在鉴权分叉
// （会话 vs body 凭据）与限频 —— 与 service 层的 fail-closed 用例（把 account-client
// mock 掉）关注点不同，混在一起会互相干扰。
//
// 【为什么必须钉住「两处共用同一份校验」】/api/auth/login 与这里的市场接口都是
// 「未认证即可让服务端跑一次 scrypt」的入口。若哪天有人把限频各抄一份、只收紧一边，
// 撞库就改走松的那扇门 —— 而且一切看起来都正常。故有两条用例专测「同一份预算」。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。远端账户服务未配置 → dev fallback（仅写本地）。

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
import { __resetRateLimitStore, RULES, isRateLimited, recordRateLimitHit } from '@/lib/rate-limit';
import { unitsToFish } from '@/lib/fish-units';
import { POST as transfer } from '@/app/api/fish/market/transfer/route';
import { POST as balanceApi } from '@/app/api/fish/market/balance/route';
import { POST as transactionsApi } from '@/app/api/fish/market/transactions/route';
import { POST as pay } from '@/app/api/fish/market/pay/route';

const PASSWORD = 'bot-Password-123';

function makeReq(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const transferReq = (body: unknown, headers?: Record<string, string>) =>
  transfer(makeReq('/api/fish/market/transfer', body, headers));

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

/** 造一个能登录的用户（真密码哈希，走 verifyPassword）。 */
async function makeLoginableUser(opts: { driedFish?: number; isBanned?: boolean } = {}) {
  return makeUser({
    driedFish: opts.driedFish ?? 100,
    passwordHash: await hashPassword(PASSWORD),
    isBanned: opts.isBanned ?? false,
    ...(opts.isBanned ? { banUntil: null } : {}),
  } as Parameters<typeof makeUser>[0]);
}

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  session.token = undefined; // 默认「没有会话」
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── 无会话：凭据随请求走 ────────────────────────────────────────────────────

describe('无状态转账（无 cookie，body 带 username/password）', () => {
  it('一次发包完成转账：双方余额变化 + 两条流水', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 7.5,
      note: '机器人转账',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(200);
    expect(json.amount).toBe(7.5);
    expect(json.balance).toBe(92.5);
    expect(json.recipient).toEqual({ id: recipient.id, username: recipient.username });

    expect(await balanceOf(sender.id)).toBe(92.5);
    expect(await balanceOf(recipient.id)).toBe(7.5);
    expect(await prisma.fishTransaction.count()).toBe(2);
  });

  it('响应体里绝不回显密码', async () => {
    const sender = await makeLoginableUser();
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 1,
    });

    expect(await res.text()).not.toContain(PASSWORD);
  });

  it('to_user_id 也收（网页那条路原样可用）', async () => {
    const sender = await makeLoginableUser();
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_user_id: recipient.id,
      amount: 1,
    });

    expect(res.status).toBe(200);
    expect(await balanceOf(recipient.id)).toBe(1);
  });

  it('密码错误 → 401，且本地零写入（钱一分不动）', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: 'wrong-password',
      to_username: recipient.username,
      amount: 1,
    });

    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('用户名或密码错误');
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('用户不存在与密码错误返回同一条文案（不给用户名枚举留信道）', async () => {
    const res = await transferReq({
      username: 'no-such-user',
      password: 'whatever',
      to_username: 'also-nobody',
      amount: 1,
    });

    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('用户名或密码错误');
  });

  it('两种凭据都没带 → 401（并提示怎么带）', async () => {
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({ to_username: recipient.username, amount: 1 });

    expect(res.status).toBe(401);
    expect((await res.json()).message).toContain('username');
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('收款人用户名不存在 → 404', async () => {
    const sender = await makeLoginableUser();

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: 'no-such-recipient',
      amount: 1,
    });

    expect(res.status).toBe(404);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('被禁言的账号用凭据也转不了 → 403', async () => {
    const sender = await makeLoginableUser({ driedFish: 100, isBanned: true });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 1,
    });

    expect(res.status).toBe(403);
    expect(await balanceOf(sender.id)).toBe(100);
  });

  it('余额不足 → 400（凭据有效也不能透支）', async () => {
    const sender = await makeLoginableUser({ driedFish: 1 });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 5,
    });

    expect(res.status).toBe(400);
    expect(await balanceOf(sender.id)).toBe(1);
  });
});

// ── 会话仍然可用（回归）────────────────────────────────────────────────────

describe('会话路径不受影响', () => {
  it('带会话 cookie → 以会话用户身份转账，body 里的凭据被忽略', async () => {
    const sender = await makeLoginableUser({ driedFish: 50 });
    const other = await makeLoginableUser({ driedFish: 50 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });

    const res = await transferReq({
      // 故意塞一个「别人的」凭据：会话优先，不能被它带跑偏
      username: other.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 2,
    });

    expect(res.status).toBe(200);
    expect(await balanceOf(sender.id)).toBe(48);
    expect(await balanceOf(other.id), 'body 里的另一个账号分文未动').toBe(50);
  });

  it('会话用户被禁言 → 403', async () => {
    const sender = await makeLoginableUser({ driedFish: 50, isBanned: true });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });

    const res = await transferReq({ to_user_id: recipient.id, amount: 1 });

    expect(res.status).toBe(403);
  });

  it('失效会话（sessionVersion 不匹配）退回凭据路径：没带凭据就 401', async () => {
    const sender = await makeLoginableUser({ driedFish: 50 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 99 }); // 版本对不上

    const res = await transferReq({ to_user_id: recipient.id, amount: 1 });

    expect(res.status).toBe(401);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });
});

// ── 限频：CPU 保护 + 与 /login 共用撞库预算 ────────────────────────────────

describe('无状态路径的限频', () => {
  it(`成功也计数：超过 ${RULES.fishApiPerUser.limit} 次/分 → 429`, async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const limit = RULES.fishApiPerUser.limit;

    for (let i = 0; i < limit; i++) {
      const res = await transferReq({
        username: sender.username,
        password: PASSWORD,
        to_user_id: sender.id, // 自己转自己（400），但**凭据校验已经跑过**、配额要计
        amount: 1,
      });
      expect(res.status, `第 ${i + 1} 次应当过凭据校验`).toBe(400);
    }

    const blocked = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_user_id: sender.id,
      amount: 1,
    });
    expect(blocked.status, '第 limit+1 次：配额已满，连 scrypt 都不该跑').toBe(429);
  });

  it('同一 IP 扫多个账号，达到 IP 上限 → 429', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    const limit = RULES.fishApiPerIp.limit;

    for (let i = 0; i < limit; i++) {
      const res = await transferReq(
        { username: `nobody${i}`, password: 'wrong', to_username: 'nobody', amount: 1 },
        ip
      );
      expect(res.status, `第 ${i + 1} 次应为 401（账号不存在）`).toBe(401);
    }

    const blocked = await transferReq(
      { username: 'fresh-name', password: 'wrong', to_username: 'nobody', amount: 1 },
      ip
    );
    expect(blocked.status).toBe(429);
  });

  it('★ 失败计数落在 /api/auth/login 的同一个桶里（同一份凭据、同一个预算）', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const key = `login:user:${sender.username.toLowerCase()}`;
    const probe = { limit: 3, windowMs: 60_000 };

    expect(isRateLimited(key, probe)).toBe(false);
    for (let i = 0; i < 3; i++) {
      await transferReq({ username: sender.username, password: 'wrong', to_username: 'x', amount: 1 });
    }
    expect(
      isRateLimited(key, probe),
      '3 次错误凭据必须记进 login:user: —— 否则撞库可以改走市场这扇门'
    ).toBe(true);
  });

  it('★ 登录侧打满的预算，市场接口同样认（先查桶再跑 scrypt）', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });
    const key = `login:user:${sender.username.toLowerCase()}`;
    for (let i = 0; i < RULES.loginPerUser.limit; i++) recordRateLimitHit(key);

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD, // 密码是对的，也必须被挡住
      to_username: recipient.username,
      amount: 1,
    });

    expect(res.status).toBe(429);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });
});

// ── 另两个接口：余额 / 流水 ────────────────────────────────────────────────

describe('POST /api/fish/market/balance', () => {
  it('凭据有效 → 返回该账号余额（无会话）', async () => {
    const user = await makeLoginableUser({ driedFish: 12.5 });

    const res = await balanceApi(
      makeReq('/api/fish/market/balance', { username: user.username, password: PASSWORD })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ user_id: user.id, username: user.username, balance: 12.5 });
  });

  it('凭据错误 → 401，不泄露余额', async () => {
    const user = await makeLoginableUser({ driedFish: 12.5 });

    const res = await balanceApi(
      makeReq('/api/fish/market/balance', { username: user.username, password: 'nope' })
    );

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('12.5');
  });

  it('带会话且空 body → 也能用（网页/脚本共用同一形状）', async () => {
    const user = await makeLoginableUser({ driedFish: 3 });
    session.token = await createSessionToken({ uid: user.id, sv: 0 });

    const res = await balanceApi(makeReq('/api/fish/market/balance', {}));

    expect(res.status).toBe(200);
    expect((await res.json()).balance).toBe(3);
  });
});

describe('POST /api/fish/market/transactions', () => {
  it('凭据有效 → 分页流水，形状与 GET /api/fish/balance 的流水部分一致', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 2,
    });

    const res = await transactionsApi(
      makeReq('/api/fish/market/transactions', {
        username: sender.username,
        password: PASSWORD,
        page: 1,
        per_page: 20,
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user_id).toBe(sender.id);
    expect(json.total).toBe(1);
    expect(json.transactions).toHaveLength(1);
    expect(json.transactions[0]).toMatchObject({ amount: -2, type: 'transfer' });
    expect(json.transactions[0].relatedUserId).toBe(recipient.id);
    expect(json.has_prev).toBe(false);
    expect(json.has_next).toBe(false);
  });

  it('type 筛选与网页同口径（transfer_all 覆盖转出与转入）', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeLoginableUser({ driedFish: 0 }); // 收款人也要能凭据登录
    await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 2,
    });

    const res = await transactionsApi(
      makeReq('/api/fish/market/transactions', {
        username: recipient.username,
        password: PASSWORD,
        type: 'transfer_all',
      })
    );

    expect((await res.json()).transactions).toHaveLength(1);
  });

  it('游标模式：since_id → 升序 + next_cursor + has_more', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    for (const amount of [1, 2, 3]) {
      await transferReq({
        username: sender.username,
        password: PASSWORD,
        to_username: recipient.username,
        amount,
      });
    }

    const first = await transactionsApi(
      makeReq('/api/fish/market/transactions', {
        username: sender.username,
        password: PASSWORD,
        since_id: 0,
        limit: 2,
      })
    );
    const page1 = await first.json();
    expect(page1.mode).toBe('cursor');
    expect(page1.transactions).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.transactions[0].id).toBeLessThan(page1.transactions[1].id);

    const second = await transactionsApi(
      makeReq('/api/fish/market/transactions', {
        username: sender.username,
        password: PASSWORD,
        since_id: page1.next_cursor,
      })
    );
    const page2 = await second.json();
    expect(page2.transactions).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    // 两轮之间没有重叠（游标严格大于）
    const ids = [...page1.transactions, ...page2.transactions].map((t: { id: number }) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('非法的 since_id → 400（不静默退回翻页模式：那会让对账方以为在推进游标）', async () => {
    const user = await makeLoginableUser({ driedFish: 1 });

    for (const bad of ['abc', -1, 1.5]) {
      const res = await transactionsApi(
        makeReq('/api/fish/market/transactions', {
          username: user.username,
          password: PASSWORD,
          since_id: bad,
        })
      );
      expect(res.status, `since_id=${bad}`).toBe(400);
    }
  });

  it('非法页码回落默认值而不是 400（分区页的输入不值得报错）', async () => {
    const user = await makeLoginableUser({ driedFish: 1 });

    const res = await transactionsApi(
      makeReq('/api/fish/market/transactions', {
        username: user.username,
        password: PASSWORD,
        page: 'abc',
        per_page: -5,
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).page).toBe(1);
  });
});

// ── 收银台（/fish/pay 的接口）──────────────────────────────────────────────
//
// 与上面那些「无状态」接口的关键区别：付款人**只能是会话用户**，且必须再输一次
// 本人密码（step-up）。这里逐条钉住这两件事 —— 它们正是收银台的全部价值。

describe('POST /api/fish/market/pay（收银台）', () => {
  const payReq = (body: unknown) => pay(makeReq('/api/fish/market/pay', body));

  it('没登录 → 401（body 里塞凭据也不行：这个接口不认无状态鉴权）', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await payReq({
      to_user_id: recipient.id,
      amount: 1,
      password: PASSWORD,
      username: sender.username,
    });

    expect(res.status).toBe(401);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('★ 已登录但不给密码 → 400（step-up 不可跳过）', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });

    const res = await payReq({ to_user_id: recipient.id, amount: 1 });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('密码');
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('★ 密码错误 → 401 且零写入，并且消耗的是登录失败预算（不是第三条撞库通道）', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });
    const key = `login:user:${sender.username.toLowerCase()}`;
    const probe = { limit: 2, windowMs: 60_000 };

    expect(isRateLimited(key, probe)).toBe(false);
    for (let i = 0; i < 2; i++) {
      const res = await payReq({ to_user_id: recipient.id, amount: 1, password: 'wrong' });
      expect(res.status).toBe(401);
    }

    expect(isRateLimited(key, probe), 'step-up 失败必须记进 login:user:').toBe(true);
    expect(await prisma.fishTransaction.count()).toBe(0);
    expect(await balanceOf(sender.id)).toBe(10);
  });

  it('密码正确 → 付款成功，余额与流水都对', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });

    const res = await payReq({
      to_user_id: recipient.id,
      amount: 2.5,
      note: '订单 A-1',
      password: PASSWORD,
      idempotency_key: 'pay-abc123abc123abc1',
    });

    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.amount).toBe(2.5);
    expect(json.balance).toBe(7.5);
    expect(await balanceOf(recipient.id)).toBe(2.5);
    expect(await prisma.fishTransaction.count()).toBe(2);
  });

  it('被禁言 → 403', async () => {
    const sender = await makeLoginableUser({ driedFish: 10, isBanned: true });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });

    const res = await payReq({ to_user_id: recipient.id, amount: 1, password: PASSWORD });

    expect(res.status).toBe(403);
  });

  it('会话失效（sessionVersion 不匹配）→ 401，即使密码是对的', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 99 });

    const res = await payReq({ to_user_id: recipient.id, amount: 1, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });
});
