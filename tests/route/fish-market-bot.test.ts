// 鱼干市场 · 无状态单次发包（凭据随请求走，不签发会话）
//
// 【这是站外机器人的**对外契约**】鉴权分叉（会话 / 只读凭据 / body 凭据）、限频、
// 错误码、以及**幂等键的语义**（同键重放 / 同键换参数 / 无键即新交易）都在这里钉着。
// 站外脚本遇到超时之后唯一的自救手段就是「用同一个键重发」，所以那几条断言是契约
// 本身、不是实现细节 —— 改它们等于改对外行为。
//
// 【为什么必须钉住「两处共用同一份校验」】/api/auth/login 与这里的市场接口都是
// 「未认证即可让服务端跑一次 scrypt」的入口。若哪天有人把限频各抄一份、只收紧一边，
// 撞库就改走松的那扇门 —— 而且一切看起来都正常。故有两条用例专测「同一份预算」。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。账目就在本站（users.driedFish 与
// fish_transactions 同一个事务），所以跑过钱路径的用例末尾都用
// expectLedgerConsistent() 收口 —— 账户搬进站内后没有第二份账目可核对了，
// 内部一致性就是唯一的证明（见 tests/helpers/fish-ledger.ts）。

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
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import { hashPassword } from '@/lib/password';
import { createSessionToken } from '@/lib/session';
import { __resetRateLimitStore, RULES, isRateLimited, recordRateLimitHit } from '@/lib/rate-limit';
import { TRANSFER_OUT_TYPE, TRANSFER_IN_TYPE } from '@/lib/fish-market-service';
import { unitsToFish } from '@/lib/fish-units';
import { POST as transfer } from '@/app/api/fish/market/transfer/route';
import { POST as balanceApi } from '@/app/api/fish/market/balance/route';
import { POST as transactionsApi } from '@/app/api/fish/market/transactions/route';
import { POST as pay } from '@/app/api/fish/market/pay/route';
import { GET as usersApi } from '@/app/api/fish/market/users/route';
import {
  mintFishToken,
  revokeFishToken,
} from '@/lib/fish-token-service';
import { nowForDb } from '@/lib/db-time';

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

/**
 * 造一个能登录的用户（真密码哈希，走 verifyPassword）。
 *
 * 初始鱼干用 makeFishUser 造：它让余额**经由记账内核**进入（一条 admin_grant 流水），
 * 与线上同构 —— 而 expectLedgerConsistent 断的是「余额 == 该用户所有流水之和」，
 * 直接 `makeUser({ driedFish: N })` 塞出来的无来源余额在它眼里就是一条撕裂的账。
 */
async function makeLoginableUser(opts: { driedFish?: number; isBanned?: boolean } = {}) {
  return makeFishUser(opts.driedFish ?? 100, {
    passwordHash: await hashPassword(PASSWORD),
    isBanned: opts.isBanned ?? false,
    banUntil: null,
  });
}

/**
 * **转账**流水的条数（一出一进算两条）—— 断言「这笔请求到底写没写钱」时用它。
 *
 * 按 type 过滤而不是数全表：夹具给用户的初始余额也是一条流水（makeFishUser 的
 * admin_grant），它不属于任何一次转账动作。
 */
function txCount() {
  return prisma.fishTransaction.count({
    where: { type: { in: [TRANSFER_OUT_TYPE, TRANSFER_IN_TYPE] } },
  });
}

/** 转账的两条腿（一出一进），按写入顺序。 */
function transferRows() {
  return prisma.fishTransaction.findMany({
    where: { type: { in: [TRANSFER_OUT_TYPE, TRANSFER_IN_TYPE] } },
    orderBy: { id: 'asc' },
  });
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
    expect(await txCount()).toBe(2);

    await expectLedgerConsistent('无状态转账（一次发包）后');
  });

  it('★ 响应带 transfer_id，且与**两条**流水的单号一致（付款方与收款方对的是同一笔）', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq({
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 5,
    });
    const json = await res.json();

    expect(json.transfer_id).toMatch(/^[0-9a-f]{16}$/);
    const rows = await transferRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].transferId).toBe(json.transfer_id);
    expect(rows[1].transferId).toBe(json.transfer_id);
    // 一出一进，且落库的金额是存储单位（0.0001 鱼干）—— 站外对账方按流水认账，
    // 这两条对不上就等于两边的账对不上。（5 鱼干 = 50000 单位）
    expect(rows[0].type).toBe(TRANSFER_OUT_TYPE);
    expect(rows[0].amount).toBe(-50000);
    expect(rows[1].type).toBe(TRANSFER_IN_TYPE);
    expect(rows[1].amount).toBe(50000);

    await expectLedgerConsistent('转账后（校验共享单号）');
  });

  // ── 幂等键的对外契约（站外脚本超时后**唯一**的自救手段）────────────────────
  //
  // 记录与转账在**同一个事务**里提交，所以「钱动了但键没记」（同键重放会变成
  // 第二笔转账）在结构上不可能。键由调用方给，服务端只认它。

  it('★ 带幂等键重发同一笔 → 原结果 + duplicated，钱只动一次', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });
    const body = {
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 5,
      note: '机器人转账',
      idempotency_key: 'wd-20260920-0001',
    };

    const first = await transferReq(body);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.duplicated).toBe(false);

    const again = await transferReq(body);
    expect(again.status, '超时之后原样重发这一条必须是安全的').toBe(200);
    const againJson = await again.json();
    expect(againJson.duplicated, '必须如实回报「已成交」而不是再转一笔').toBe(true);
    expect(againJson.transfer_id, '重放回报的是**原单**的单号').toBe(firstJson.transfer_id);

    expect(await balanceOf(sender.id)).toBe(95);
    expect(await balanceOf(recipient.id)).toBe(5);
    expect(await txCount(), '只成交一笔 = 两条腿').toBe(2);
    const ledger = await prisma.accountSyncLedger.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].operation).toBe('transfer');
    expect(ledger[0].status, '与业务写入同事务提交 ⇒ 提交成功即已生效').toBe('synced');

    await expectLedgerConsistent('带幂等键重发后（只成交一笔）');
  });

  it('★ 同一把键换成另一个金额 → 409，不静默改单、钱一分不动', async () => {
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });
    const base = {
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      idempotency_key: 'wd-20260920-0002',
    };

    expect((await transferReq({ ...base, amount: 5 })).status).toBe(200);
    const res = await transferReq({ ...base, amount: 6 });

    expect(res.status).toBe(409);
    expect(await balanceOf(sender.id), '只有第一笔成交').toBe(95);
    expect(await balanceOf(recipient.id)).toBe(5);
    expect(await txCount()).toBe(2);
    expect(await prisma.accountSyncLedger.count()).toBe(1);

    await expectLedgerConsistent('同键换金额被 409 拒后');
  });

  it('不带幂等键 → 每次都是一笔新交易（随机键，一行账本都不写）', async () => {
    // 「重试 = 再转一笔」：不给键就没有任何去重，服务端每次生成一个随机键
    //（判据：键是确定的才登记）。做提现/对账的机器人必须自己带上键。
    const sender = await makeLoginableUser({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });
    const body = {
      username: sender.username,
      password: PASSWORD,
      to_username: recipient.username,
      amount: 5,
    };

    expect((await transferReq(body)).status).toBe(200);
    expect((await transferReq(body)).status).toBe(200);

    expect(await balanceOf(sender.id)).toBe(90);
    expect(await balanceOf(recipient.id)).toBe(10);
    expect(await txCount(), '两笔 = 四条腿').toBe(4);
    expect(await prisma.accountSyncLedger.count(), '随机键不登记').toBe(0);

    await expectLedgerConsistent('两笔无键转账后');
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

    await expectLedgerConsistent('转账响应后（校验不回显密码）');
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

    await expectLedgerConsistent('按 to_user_id 转账后');
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
    expect(await txCount()).toBe(0);

    await expectLedgerConsistent('凭据错误被 401 拒后');
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
    expect(await txCount()).toBe(0);
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
    expect(await txCount()).toBe(0);
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

    await expectLedgerConsistent('被禁言账号的转账被 403 拒后');
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

    await expectLedgerConsistent('余额不足被 400 拒后');
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

    await expectLedgerConsistent('会话路径转账后');
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
    expect(await txCount()).toBe(0);

    await expectLedgerConsistent('失效会话被 401 拒后');
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
    expect(await txCount()).toBe(0);
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

describe('只读凭据（Authorization: Bearer）—— 第三道门', () => {
  /** 造一个持有效只读凭据的用户。 */
  async function withToken(opts: { driedFish?: number; isBanned?: boolean } = {}) {
    const user = await makeLoginableUser(opts);
    const minted = await mintFishToken(user.id, '对账机器人');
    return { user, token: minted.token, id: minted.id };
  }
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it('★ 只读凭据能查余额（不跑 scrypt、不要密码）', async () => {
    const { user, token } = await withToken({ driedFish: 12.5 });

    const res = await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user_id: user.id,
      username: user.username,
      balance: 12.5,
    });
  });

  it('只读凭据能查流水', async () => {
    const { token } = await withToken();
    const res = await transactionsApi(makeReq('/api/fish/market/transactions', {}, bearer(token)));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('page');
  });

  it('★ 只读凭据**不能转账** → 403，且零写入', async () => {
    const { user, token } = await withToken({ driedFish: 100 });
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferReq(
      { to_username: recipient.username, amount: 1 },
      bearer(token)
    );

    expect(res.status, '不能含糊地 401，要说清是权限不够').toBe(403);
    expect((await res.json()).message).toContain('只能读取');
    expect(await balanceOf(user.id), '钱一分不动').toBe(100);
    expect(await txCount()).toBe(0);
  });

  it('★ 已吊销的凭据 → 401（吊销必须立即生效）', async () => {
    const { user, token, id } = await withToken();
    await revokeFishToken(user.id, id);

    const res = await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)));
    expect(res.status).toBe(401);
  });

  it('已过期的凭据 → 401', async () => {
    const { user, token } = await withToken();
    await prisma.fishApiToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(nowForDb().getTime() - 1000) },
    });

    const res = await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)));
    expect(res.status).toBe(401);
  });

  it('★ 持有者被禁言 → 403（凭据不是会话，不走 sessionVersion，必须实时拦）', async () => {
    const { user, token } = await withToken();
    // 禁言：这是站长处理失控机器人的唯一手段，凭据路径绝不能绕过它
    await prisma.user.update({
      where: { id: user.id },
      data: { isBanned: true, banUntil: null },
    });

    const res = await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)));
    expect(res.status).toBe(403);
  });

  it('伪造 / 拼错的令牌 → 401', async () => {
    await makeLoginableUser();
    for (const bad of ['garbage', 'Bearer', '']) {
      const res = await balanceApi(
        makeReq('/api/fish/market/balance', {}, { authorization: bad ? `Bearer ${bad}` : '' })
      );
      expect(res.status, `不该放行: ${bad}`).toBe(401);
    }
  });

  it('★ 凭据路径**不占用** fish-api 那条 CPU 配额（它没跑 scrypt）', async () => {
    const { user, token } = await withToken();
    const key = `fish-api:${user.username.toLowerCase()}`;

    // 打满远超 20 次/分（那条是 scrypt 的 CPU 闸门，与凭据无关）
    for (let i = 0; i < RULES.fishApiPerUser.limit + 5; i++) {
      const res = await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)));
      expect(res.status).toBe(200);
    }
    expect(isRateLimited(key, RULES.fishApiPerUser), '凭据不该吃 scrypt 的额度').toBe(false);
  });

  it('凭据自己有配额：超过 fishTokenPerUser → 429', async () => {
    const { user, token } = await withToken();
    for (let i = 0; i < RULES.fishTokenPerUser.limit; i++) {
      expect((await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)))).status).toBe(
        200
      );
    }
    const res = await balanceApi(makeReq('/api/fish/market/balance', {}, bearer(token)));
    expect(res.status).toBe(429);
    expect(user.id).toBeTruthy();
  });

  it('大小写不敏感的 Bearer（RFC 7235：scheme 不敏感）', async () => {
    const { token } = await withToken();
    const res = await balanceApi(
      makeReq('/api/fish/market/balance', {}, { authorization: `bearer ${token}` })
    );
    expect(res.status).toBe(200);
  });

  it('★ 用户搜索名录不认凭据（否则等于给站外机器人开了个用户名枚举口）', async () => {
    const { token } = await withToken();
    const res = await usersApi(
      new Request('http://localhost/api/fish/market/users?q=a', {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(401);
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
        // 只看转账：夹具给的初始余额也是一条流水（makeFishUser 的 admin_grant），
        // 而「第一条是这笔转账」这个断言不该取决于两条行的排序。
        type: 'transfer_all',
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user_id).toBe(sender.id);
    expect(json.total).toBe(1);
    expect(json.transactions).toHaveLength(1);
    expect(json.transactions[0]).toMatchObject({ amount: -2, type: 'transfer' });
    // snake_case：与站内两条读口逐字段同形（那份映射的三个消费方见
    // fish-service.toFishTxJson；本文件只钉这一条读口，三方一致性在
    // tests/route/fish-tx-shape.test.ts）。
    expect(json.transactions[0].related_user_id).toBe(recipient.id);
    expect(json.has_prev).toBe(false);
    expect(json.has_next).toBe(false);

    await expectLedgerConsistent('流水接口读取的这笔转账之后');
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
        // 同样只看转账：初始余额那条会占掉游标的第一格（见上一条用例的说明）
        type: 'transfer_all',
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
        type: 'transfer_all', // 两页同一套筛选：换了筛选口径的游标本来就不该接着用
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
    expect(await txCount()).toBe(0);
  });

  it('★ 已登录但不给密码 → 400（step-up 不可跳过）', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });

    const res = await payReq({ to_user_id: recipient.id, amount: 1 });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('密码');
    expect(await txCount()).toBe(0);
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
    expect(await txCount()).toBe(0);
    expect(await balanceOf(sender.id)).toBe(10);

    await expectLedgerConsistent('step-up 密码错误被 401 拒后');
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
    expect(await txCount()).toBe(2);
    // 收银台的成功面板拿它当回执，商户按同一个值认这一笔
    expect(json.transfer_id).toMatch(/^[0-9a-f]{16}$/);

    await expectLedgerConsistent('收银台付款成功后');
  });

  it('★ 同一笔订单号重新点一次付款 → duplicated，钱不多扣', async () => {
    // 收银台的 `order` 参数（→ idempotency_key）存在的**全部理由**：付款成功之后
    // 用户刷新页面再点一次，服务端必须认得出这是同一笔。
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });
    const body = {
      to_user_id: recipient.id,
      amount: 2.5,
      note: '订单 A-1',
      password: PASSWORD,
      idempotency_key: 'pay-abc123abc123abc1',
    };

    const first = await payReq(body);
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    const again = await payReq(body);
    expect(again.status).toBe(200);
    const againJson = await again.json();
    expect(againJson.duplicated).toBe(true);
    expect(againJson.transfer_id, '重放回报的是原单的单号').toBe(firstJson.transfer_id);

    expect(await balanceOf(sender.id)).toBe(7.5);
    expect(await balanceOf(recipient.id)).toBe(2.5);
    expect(await txCount()).toBe(2);

    await expectLedgerConsistent('收银台同单重付后（只扣一次）');
  });

  it('★ 同一把键换成另一个金额 → 409（同键换参数不静默改单）', async () => {
    const sender = await makeLoginableUser({ driedFish: 10 });
    const recipient = await makeUser({ driedFish: 0 });
    session.token = await createSessionToken({ uid: sender.id, sv: 0 });
    const base = {
      to_user_id: recipient.id,
      password: PASSWORD,
      idempotency_key: 'pay-def456def456def4',
    };

    expect((await payReq({ ...base, amount: 2.5 })).status).toBe(200);
    const res = await payReq({ ...base, amount: 3 });

    expect(res.status).toBe(409);
    expect(await balanceOf(sender.id)).toBe(7.5);

    await expectLedgerConsistent('收银台同键换金额被 409 拒后');
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
    expect(await txCount()).toBe(0);
  });
});
