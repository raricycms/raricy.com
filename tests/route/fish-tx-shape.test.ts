// 鱼干流水的**线上形状**：三条读口必须逐字段同形。
//
// 【这个文件在钉什么】`fish_transactions` 的一行，在本站有三个读口：
//   · GET  /api/fish/transactions        （站内页面 / 会话）
//   · GET  /api/fish/balance             （站内页面，余额 + 流水一起给）
//   · POST /api/fish/market/transactions （站外机器人 / 银行，翻页与游标两种模式）
//
// 它们共用服务层同一个 DTO，而 DTO 按 TS 惯例是 camelCase、对外 JSON 按契约是
// snake_case —— **中间那道映射一旦有人漏写，camelCase 就泄进响应里**。
// 这不是假想的风险：**它真的发生过**，而且是三条路由里一条手写了映射、另两条直接
// 透传，于是同一个字段在三个接口里两种拼法；更糟的是信封本来就是 snake_case，
// 所以某个响应里 `relatedUserId` 和 `next_cursor` 是并排出现的，而对外文档只好
// 照实把这个混合形状抄下去。
//
// 【为什么断言「精确的键集」而不是「有这些键」】只查存在的写法挡不住**多**出来的键 ——
// 而那正是这个 bug 的形态（多了一份 camelCase 副本）。同理，`toEqual` 三条读口两两相比：
// 只要有一条漂了，这里就红，而不用为每条路由各写一份期望值。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 会话由 cookie 决定：单测里没有请求上下文，用可变 holder 模拟「有会话」。
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { resetDb } from '../helpers/db';
import { makeFishUser } from '../helpers/fish-ledger';
import { hashPassword } from '@/lib/password';
import { createSessionToken } from '@/lib/session';
import { transferFish } from '@/lib/fish-market-service';
import { postEntry } from '@/lib/fish-service';
import { prisma } from '../helpers/db';
import { fishToUnits } from '@/lib/fish-units';
import { GET as txList } from '@/app/api/fish/transactions/route';
import { GET as balanceWithTx } from '@/app/api/fish/balance/route';
import { POST as marketTx } from '@/app/api/fish/market/transactions/route';

/** 一行流水在**线上**应有的字段（按对外契约，snake_case）。 */
const EXPECTED_KEYS = [
  'id',
  'amount',
  'type',
  'description',
  'reference_type',
  'reference_id',
  'related_user_id',
  'transfer_id',
  'created_at',
] as const;

const USERNAME = 'shape-user';
const EMAIL = 'shape-user@test.local';
const PASSWORD = 'shape-Password-123';

async function seed() {
  // makeFishUser 会先把余额经内核写进去，所以返回值里的 driedFish 是陈旧的 —— 需要它时重读。
  const user = await makeFishUser(10, { username: USERNAME, email: EMAIL });
  const other = await makeFishUser(0, { username: 'shape-peer' });

  // 一笔转账：让 reference_* / related_user_id / transfer_id 全部非空。
  const t = await transferFish(user.id, other.id, 2, '形状用例');
  expect(t.ok, JSON.stringify(t)).toBe(true);
  // 一笔签到式发鱼：让那几个字段全部为 null（形状的另一半）。
  await prisma.$transaction((tx) =>
    postEntry(tx, { userId: user.id, units: fishToUnits(3), type: 'checkin', description: '签到' })
  );

  return { user, other };
}

const getReq = (path: string) => new Request(`http://localhost${path}`);
const postReq = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 三种读口各取一次，返回各自的 transactions 数组。 */
async function readAllThree() {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: USERNAME } });
  session.token = await createSessionToken({ uid: u.id, sv: u.sessionVersion });

  const a = await (await txList(getReq('/api/fish/transactions'))).json();
  const b = await (await balanceWithTx(getReq('/api/fish/balance'))).json();
  const c = await (
    await marketTx(postReq('/api/fish/market/transactions', { username: USERNAME, password: PASSWORD }))
  ).json();
  return { list: a, balance: b, market: c };
}

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});
afterEach(() => vi.restoreAllMocks());

/** 把某个用户的密码设成可校验的（无状态那条读口要走真校验）。 */
async function setPassword(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(PASSWORD) },
  });
}

describe('★ 三条流水读口逐字段同形', () => {
  it('同一条流水经三条读口读回来，对象**完全相等**', async () => {
    const { user } = await seed();
    await setPassword(user.id);

    const { list, balance, market } = await readAllThree();

    // 3 条：makeFishUser 造余额时经内核留的 admin_grant，加上转账与签到。
    // 硬写条数是刻意的 —— 哪条读口悄悄少给了一行，这里要红。
    expect(list.transactions, '会话口没给流水（先确认会话 mock 生效）').toHaveLength(3);
    expect(market.transactions).toHaveLength(3);
    expect(balance.transactions).toHaveLength(3);

    // 两两相等 —— 一条漂了就红。顺序也一样（都按 id 倒序）。
    expect(balance.transactions, 'GET /api/fish/balance 与 GET /api/fish/transactions 漂了').toEqual(
      list.transactions
    );
    expect(market.transactions, 'POST /api/fish/market/transactions 与站内读口漂了').toEqual(
      list.transactions
    );
  });

  it('★ 键集**精确**匹配（多一个 camelCase 副本也要红）', async () => {
    const { user } = await seed();
    await setPassword(user.id);

    const { list, balance, market } = await readAllThree();

    for (const [name, rows] of [
      ['GET /api/fish/transactions', list.transactions],
      ['GET /api/fish/balance', balance.transactions],
      ['POST /api/fish/market/transactions', market.transactions],
    ] as const) {
      for (const row of rows as Array<Record<string, unknown>>) {
        expect(
          Object.keys(row).sort(),
          `${name} 的流水字段集不对 —— 对外契约是 snake_case，多出来的键多半是` +
            `服务层 DTO 被直接透传了（见 fish-service.toFishTxJson）`
        ).toEqual([...EXPECTED_KEYS].sort());
      }
    }
  });

  it('值为 null 的字段照常出现（别把 null 键省掉 —— 调用方按固定字段集写代码）', async () => {
    const { user } = await seed();
    await setPassword(user.id);

    const { list } = await readAllThree();
    const checkin = (list.transactions as Array<Record<string, unknown>>).find(
      (r) => r.type === 'checkin'
    );
    expect(checkin, '夹具应当造出一条 checkin 流水').toBeTruthy();
    // 这五个对签到流水全是 null —— 键必须在、值为 null。
    for (const k of ['reference_type', 'reference_id', 'related_user_id', 'transfer_id']) {
      expect(k in checkin!, `${k} 这个键被省掉了`).toBe(true);
      expect(checkin![k]).toBeNull();
    }
  });

  it('值本身没错位（不是「键对了、值串了」）', async () => {
    const { user, other } = await seed();
    await setPassword(user.id);

    const { list } = await readAllThree();
    const out = (list.transactions as Array<Record<string, unknown>>).find(
      (r) => r.type === 'transfer'
    );
    const row = await prisma.fishTransaction.findFirstOrThrow({
      where: { userId: user.id, type: 'transfer' },
    });

    expect(out!.amount).toBe(-2);
    expect(out!.related_user_id).toBe(other.id);
    expect(out!.reference_id).toBe(other.id);
    expect(out!.transfer_id).toBe(row.transferId);
    expect(out!.description).toContain(other.username);
    // created_at 是 ISO 串（DTO 里 toISOString 出来的），不是 Date 对象
    expect(typeof out!.created_at).toBe('string');
  });

  it('游标模式走的是同一份映射（两种模式的流水项不能各长一样）', async () => {
    const { user } = await seed();
    await setPassword(user.id);
    session.token = await createSessionToken({ uid: user.id, sv: user.sessionVersion });

    const cursor = await (
      await marketTx(
        postReq('/api/fish/market/transactions', {
          username: USERNAME,
          password: PASSWORD,
          since_id: 0,
        })
      )
    ).json();
    const page = await (
      await marketTx(
        postReq('/api/fish/market/transactions', { username: USERNAME, password: PASSWORD })
      )
    ).json();

    expect(cursor.mode).toBe('cursor');
    expect(page.mode).toBe('page');
    // 游标信封是另一套键（next_cursor / has_more 而不是 page / total）
    expect(Object.keys(cursor).sort()).toEqual(
      ['code', 'has_more', 'message', 'mode', 'next_cursor', 'transactions', 'user_id', 'username'].sort()
    );
    // 游标是 id 升序、翻页是倒序，故逐条比对象（不比数组顺序）
    expect(cursor.transactions).toHaveLength(page.transactions.length);
    for (const row of cursor.transactions as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_KEYS].sort());
    }
    expect([...cursor.transactions].reverse()).toEqual(page.transactions);
  });

  it('信封本来就是 snake_case —— 那份不变，别把它也「统一」成别的', async () => {
    const { user } = await seed();
    await setPassword(user.id);

    const { list, balance, market } = await readAllThree();

    expect(Object.keys(list).sort()).toEqual(
      [
        'code',
        'has_next',
        'has_prev',
        'message',
        'next_num',
        'page',
        'pages',
        'per_page',
        'prev_num',
        'total',
        'transactions',
      ].sort()
    );
    expect(Object.keys(balance).sort()).toEqual(
      [
        'balance',
        'code',
        'has_next',
        'has_prev',
        'message',
        'page',
        'pages',
        'per_page',
        'total',
        'transactions',
      ].sort()
    );
    // 上面那次调用没给 since_id → 翻页模式（信封与游标模式不同，见下一条用例）。
    expect(Object.keys(market).sort()).toEqual(
      [
        'code',
        'has_next',
        'has_prev',
        'message',
        'mode',
        'page',
        'pages',
        'per_page',
        'total',
        'transactions',
        'user_id',
        'username',
      ].sort()
    );
  });
});
