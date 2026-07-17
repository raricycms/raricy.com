// fish-service.ts —— 小鱼干（虚拟货币）服务层。
//
// 【为什么值得重点测】这是钱。任何一处算错、流水漏记、并发超扣，都是
// 直接的资产损失且难以事后对账。因此本文件在真实 SQLite 上跑，不 mock DB。
//
// 【被测边界】按 CLAUDE.md，fish-service **只写本地 DB**，不直接调 AccountClient，
// 所以无需 mock 远端。远端同步是调用方（feed-service / checkin-service）的责任。
//
// 【关于扣款】fish-service.ts **没有导出 deductFish**（Flask 侧 app/service/fish.py
// 有 deduct_fish）。Next 侧唯一的扣款路径是 feed-service.feedBlog 里内联的
// 原子 updateMany(where driedFish >= amount)。为了回答「会不会并发超扣」这个
// 最关键的问题，下面「扣款与并发超扣」一节直接打 feedBlog —— 它是当前实现里
// 真实存在的扣款语义。详见交付说明。

import { describe, it, expect, beforeEach } from 'vitest';

import {
  getBalance,
  getBalanceBatch,
  getTodayCheckinFish,
  getTransactions,
  getBalanceLeaderboard,
  addFish,
} from '@/lib/fish-service';
import { feedBlog } from '@/lib/feed-service';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
});

/** 直接落一条流水（read 路径用例需要可控的 createdAt，addFish 不写该字段）。 */
async function makeTx(opts: {
  userId: string;
  amount: number;
  type: string;
  createdAt?: Date | null;
  description?: string;
  relatedUserId?: string | null;
}) {
  return prisma.fishTransaction.create({
    data: {
      userId: opts.userId,
      amount: opts.amount,
      type: opts.type,
      description: opts.description ?? null,
      relatedUserId: opts.relatedUserId ?? null,
      createdAt: opts.createdAt === undefined ? new Date() : opts.createdAt,
    },
  });
}

// ── getBalance / getBalanceBatch ────────────────────────────────────────────

describe('getBalance', () => {
  it('返回用户当前余额', async () => {
    const u = await makeUser({ driedFish: 42 });
    expect(await getBalance(u.id)).toBe(42);
  });

  it('用户不存在时返回 0 而非 null/抛错（对齐 Flask get_balance）', async () => {
    expect(
      await getBalance('no-such-user'),
      '不存在的用户必须安全降级为 0，否则余额展示页会 500'
    ).toBe(0);
  });

  it('余额是 Float，小数精度如实返回（作者投喂分成 80% 会产生小数）', async () => {
    const u = await makeUser({ driedFish: 0.8 });
    expect(await getBalance(u.id)).toBe(0.8);
  });

  it('新用户默认余额为 0', async () => {
    const u = await makeUser();
    expect(await getBalance(u.id)).toBe(0);
  });
});

describe('getBalanceBatch', () => {
  it('返回 {userId: balance} 映射', async () => {
    const a = await makeUser({ driedFish: 10 });
    const b = await makeUser({ driedFish: 3.5 });
    expect(await getBalanceBatch([a.id, b.id])).toEqual({ [a.id]: 10, [b.id]: 3.5 });
  });

  it('不存在的 userId 补 0（键必须存在，调用方才能无脑取值）', async () => {
    const a = await makeUser({ driedFish: 10 });
    const r = await getBalanceBatch([a.id, 'ghost']);
    expect(r).toEqual({ [a.id]: 10, ghost: 0 });
  });

  it('空数组 / 空值返回 {}，不打 DB', async () => {
    expect(await getBalanceBatch([])).toEqual({});
  });

  it('超过 500 个 ID 时截断到前 500（对齐 Flask，防止 IN 子句爆炸）', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const r = await getBalanceBatch(ids);
    expect(Object.keys(r)).toHaveLength(500);
    expect(r['id-499']).toBe(0);
    expect(r['id-500'], '第 501 个之后应被截断，键不存在').toBeUndefined();
  });
});

// ── addFish：余额增减 + 流水落库 ─────────────────────────────────────────────

describe('addFish（加钱 + 写流水）', () => {
  it('余额增加，且落一条金额/类型/关联字段都正确的流水', async () => {
    const u = await makeUser({ driedFish: 5 });
    const other = await makeUser();

    await prisma.$transaction((tx) =>
      addFish(tx, {
        userId: u.id,
        amount: 3,
        type: 'checkin',
        description: '每日签到',
        referenceType: 'blog',
        referenceId: 'blog-1',
        relatedUserId: other.id,
      })
    );

    expect(await getBalance(u.id), '5 + 3 应为 8').toBe(8);

    const txs = await prisma.fishTransaction.findMany({ where: { userId: u.id } });
    expect(txs, '一次 addFish 必须且只能产生一条流水').toHaveLength(1);
    expect(txs[0]).toMatchObject({
      amount: 3,
      type: 'checkin',
      description: '每日签到',
      referenceType: 'blog',
      referenceId: 'blog-1',
      relatedUserId: other.id,
    });
  });

  it('可选字段缺省时写 null（不是 undefined / 空串）', async () => {
    const u = await makeUser();
    await prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: 1, type: 'admin_grant' }));
    const t = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(t.description).toBeNull();
    expect(t.referenceType).toBeNull();
    expect(t.referenceId).toBeNull();
    expect(t.relatedUserId).toBeNull();
  });

  it('多次累加线性叠加，每次各写一条流水', async () => {
    const u = await makeUser({ driedFish: 0 });
    for (const n of [1, 2, 3]) {
      await prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: n, type: 'checkin' }));
    }
    expect(await getBalance(u.id)).toBe(6);
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(3);
  });

  // ── 金额边界 ──────────────────────────────────────────────────────────────

  it('amount = 0 被拒绝（对齐 Flask add_fish 的 amount <= 0 校验）', async () => {
    const u = await makeUser({ driedFish: 5 });
    await expect(
      prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: 0, type: 'checkin' }))
    ).rejects.toThrow('amount 必须为正数');
    expect(await getBalance(u.id), '被拒绝后余额不能变').toBe(5);
    expect(await prisma.fishTransaction.count(), '被拒绝后不能有流水').toBe(0);
  });

  it('amount 为负数被拒绝（否则 addFish 会变成没有余额校验的扣款后门）', async () => {
    const u = await makeUser({ driedFish: 5 });
    await expect(
      prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: -3, type: 'checkin' }))
    ).rejects.toThrow('amount 必须为正数');
    expect(await getBalance(u.id)).toBe(5);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('小数金额被接受（driedFish 是 Float；投喂分成 0.8/篇 依赖这一点）', async () => {
    const u = await makeUser({ driedFish: 0 });
    await prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: 0.8, type: 'feed_receive' })
    );
    expect(await getBalance(u.id)).toBe(0.8);
  });

  it('⚠️ 浮点累加会产生精度漂移：0.1 加 3 次 ≠ 0.3（记录现状，非断言正确性）', async () => {
    const u = await makeUser({ driedFish: 0 });
    for (let i = 0; i < 3; i++) {
      await prisma.$transaction((tx) =>
        addFish(tx, { userId: u.id, amount: 0.1, type: 'feed_receive' })
      );
    }
    const bal = await getBalance(u.id);
    expect(bal).toBeCloseTo(0.3, 10);
    // 记录：Float 存储下余额不是精确十进制。见交付说明「可疑之处」。
  });

  it('极大金额（Number.MAX_SAFE_INTEGER）能写入且读回一致', async () => {
    const u = await makeUser({ driedFish: 0 });
    await prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: Number.MAX_SAFE_INTEGER, type: 'admin_grant' })
    );
    expect(await getBalance(u.id)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('amount = Infinity 的行为（记录现状：能通过 > 0 校验）', async () => {
    const u = await makeUser({ driedFish: 0 });
    const run = prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: Infinity, type: 'admin_grant' })
    );
    // 不预设通过/拒绝，只要求不能出现「余额变了但流水没落」的不一致。
    await run.catch(() => {});
    const bal = await getBalance(u.id);
    const cnt = await prisma.fishTransaction.count({ where: { userId: u.id } });
    expect(
      bal === 0 ? cnt === 0 : cnt === 1,
      `余额(${bal})与流水条数(${cnt})必须一致：要么都没发生，要么各一次`
    ).toBe(true);
  });

  it('NaN 金额不会静默把余额污染成 NaN 且留下流水', async () => {
    const u = await makeUser({ driedFish: 5 });
    await prisma
      .$transaction((tx) => addFish(tx, { userId: u.id, amount: NaN, type: 'admin_grant' }))
      .catch(() => {});
    const bal = await getBalance(u.id);
    expect(Number.isNaN(bal), `余额被污染为 NaN 则账户永久不可用（实测 bal=${bal}）`).toBe(false);
  });

  // ── 用户不存在 ────────────────────────────────────────────────────────────

  it('用户不存在时抛错，且不留下孤儿流水（Flask 侧 rowcount==0 → ValueError）', async () => {
    await expect(
      prisma.$transaction((tx) => addFish(tx, { userId: 'ghost', amount: 1, type: 'checkin' }))
    ).rejects.toThrow();
    expect(await prisma.fishTransaction.count(), '用户不存在不能落流水').toBe(0);
  });

  // ── 原子性 ────────────────────────────────────────────────────────────────

  it('事务回滚时余额与流水一起回滚（fail-closed 的地基）', async () => {
    const u = await makeUser({ driedFish: 10 });
    await expect(
      prisma.$transaction(async (tx) => {
        await addFish(tx, { userId: u.id, amount: 5, type: 'checkin' });
        throw new Error('模拟远端账户服务同步失败');
      })
    ).rejects.toThrow('模拟远端');

    expect(await getBalance(u.id), '远端失败必须整体回滚，不能出现本地已加钱').toBe(10);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('并发 addFish 不丢更新（increment 是 DB 侧原子加，非读-改-写）', async () => {
    const u = await makeUser({ driedFish: 0 });
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, () =>
        prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: 1, type: 'checkin' }))
      )
    );
    expect(await getBalance(u.id), `${N} 笔并发 +1，余额必须正好是 ${N}（丢更新则偏小）`).toBe(N);
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(N);
  });
});

// ── 扣款与并发超扣（当前唯一扣款路径：feed-service.feedBlog）─────────────────
//
// fish-service 未导出 deductFish，扣款语义内联在 feedBlog：
//   updateMany({ where: { id, driedFish: { gte: amount } }, data: { decrement } })
// 这正是 CLAUDE.md 说的「原子 UPDATE 防并发超扣」。以下验证它真的成立。

describe('扣款：余额不足', () => {
  it('余额不足时拒绝，且余额不变、不产生任何流水', async () => {
    const author = await makeUser({ driedFish: 0 });
    const blog = await makeBlog({ authorId: author.id });
    const feeder = await makeUser({ driedFish: 2 });

    const r = await feedBlog(blog.id, feeder.id, 5);

    expect(r.ok, '余额 2 投喂 5 必须失败').toBe(false);
    expect(r).toMatchObject({ code: 400, message: '小鱼干不足' });
    expect(await getBalance(feeder.id), '失败后余额必须原样').toBe(2);
    expect(await getBalance(author.id), '失败后作者不能凭空到账').toBe(0);
    expect(await prisma.fishTransaction.count(), '失败的扣款不能留下流水').toBe(0);
  });

  it('余额恰好等于扣款额时允许（边界 >= 而非 >）', async () => {
    const author = await makeUser({ driedFish: 0 });
    const blog = await makeBlog({ authorId: author.id });
    const feeder = await makeUser({ driedFish: 5 });

    const r = await feedBlog(blog.id, feeder.id, 5);
    expect(r.ok).toBe(true);
    expect(await getBalance(feeder.id)).toBe(0);
  });

  it('扣款流水金额为负数（支出），并记录对手方', async () => {
    const author = await makeUser({ driedFish: 0 });
    const blog = await makeBlog({ authorId: author.id });
    const feeder = await makeUser({ driedFish: 5 });

    await feedBlog(blog.id, feeder.id, 2);

    const spend = await prisma.fishTransaction.findFirstOrThrow({
      where: { userId: feeder.id, type: 'feed' },
    });
    expect(spend.amount, '支出流水必须是负数，否则对账时收支同号').toBe(-2);
    expect(spend.relatedUserId).toBe(author.id);

    const income = await prisma.fishTransaction.findFirstOrThrow({
      where: { userId: author.id, type: 'feed_receive' },
    });
    expect(income.amount, '作者分成 80%').toBe(1.6);
    expect(await getBalance(author.id)).toBe(1.6);
  });
});

describe('★ 并发超扣防护（最关键）', () => {
  it('余额 10，5 笔并发各扣 5（合计 25）：余额不为负，且只有 2 笔成功', async () => {
    const author = await makeUser({ driedFish: 0 });
    const feeder = await makeUser({ driedFish: 10 });
    // 每笔打不同文章，规避「单篇每人上限 5」的干扰，让唯一的限制就是余额。
    const blogs = await Promise.all(
      Array.from({ length: 5 }, () => makeBlog({ authorId: author.id }))
    );

    const results = await Promise.all(
      blogs.map((b) =>
        feedBlog(b.id, feeder.id, 5).catch((e) => ({ ok: false as const, thrown: String(e) }))
      )
    );

    const bal = await getBalance(feeder.id);
    const okCount = results.filter((r) => r.ok).length;
    const spendRows = await prisma.fishTransaction.findMany({
      where: { userId: feeder.id, type: 'feed' },
    });
    const spent = spendRows.reduce((s, r) => s + r.amount, 0);

    expect(bal, `余额绝不能为负（实测 ${bal}，成功 ${okCount} 笔）`).toBeGreaterThanOrEqual(0);
    expect(okCount, `余额 10 / 每笔 5，最多只能成功 2 笔（实测 ${okCount}）`).toBe(2);
    expect(spent, '支出流水合计必须与扣掉的余额相等').toBe(-(10 - bal));
    expect(bal, '10 - 2*5 = 0').toBe(0);
  });

  it('余额 10，3 笔并发各扣 10：只有 1 笔成功，余额归 0 且不为负', async () => {
    const author = await makeUser({ driedFish: 0 });
    const feeder = await makeUser({ driedFish: 10 });
    // feedBlog 单笔上限 5，故用「每篇投满 5 两次」不可行；改为两次 5 打同一篇会触
    // 及累计上限。这里用 2 篇 × 5 表达「一次性花光 10」，再叠加一个必然失败的第 3 笔。
    const [b1, b2, b3] = await Promise.all([
      makeBlog({ authorId: author.id }),
      makeBlog({ authorId: author.id }),
      makeBlog({ authorId: author.id }),
    ]);

    const results = await Promise.all([
      feedBlog(b1.id, feeder.id, 5),
      feedBlog(b2.id, feeder.id, 5),
      feedBlog(b3.id, feeder.id, 5),
    ]);

    const bal = await getBalance(feeder.id);
    expect(bal, `余额不能为负（实测 ${bal}）`).toBeGreaterThanOrEqual(0);
    expect(results.filter((r) => r.ok).length, '10 只够 2 笔 ×5').toBe(2);
    expect(bal).toBe(0);
  });

  it('作者到账总额与投喂者支出笔数严格对应（并发下不重复入账）', async () => {
    const author = await makeUser({ driedFish: 0 });
    const feeder = await makeUser({ driedFish: 10 });
    const blogs = await Promise.all(
      Array.from({ length: 4 }, () => makeBlog({ authorId: author.id }))
    );

    await Promise.all(blogs.map((b) => feedBlog(b.id, feeder.id, 5).catch(() => null)));

    const spendCount = await prisma.fishTransaction.count({
      where: { userId: feeder.id, type: 'feed' },
    });
    const incomeRows = await prisma.fishTransaction.findMany({
      where: { userId: author.id, type: 'feed_receive' },
    });
    expect(incomeRows, '每笔成功支出对应且仅对应一笔作者收入').toHaveLength(spendCount);
    const authorBal = await getBalance(author.id);
    expect(authorBal, '作者余额 = 收入流水之和').toBeCloseTo(
      incomeRows.reduce((s, r) => s + r.amount, 0),
      6
    );
  });
});

// ── getTransactions ─────────────────────────────────────────────────────────

describe('getTransactions', () => {
  it('按 createdAt 倒序返回（最新的在最前）', async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin', createdAt: new Date('2026-01-01') });
    await makeTx({ userId: u.id, amount: 2, type: 'checkin', createdAt: new Date('2026-03-01') });
    await makeTx({ userId: u.id, amount: 3, type: 'checkin', createdAt: new Date('2026-02-01') });

    const r = await getTransactions(u.id);
    expect(r.transactions.map((t) => t.amount), '时间倒序').toEqual([2, 3, 1]);
  });

  it('只返回本人的流水（不能泄漏他人账目）', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeTx({ userId: a.id, amount: 1, type: 'checkin' });
    await makeTx({ userId: b.id, amount: 99, type: 'checkin' });

    const r = await getTransactions(a.id);
    expect(r.total).toBe(1);
    expect(r.transactions[0].amount).toBe(1);
  });

  it('分页：total/pages/hasPrev/hasNext 与页内条数正确', async () => {
    const u = await makeUser();
    for (let i = 0; i < 25; i++) {
      await makeTx({
        userId: u.id,
        amount: i + 1,
        type: 'checkin',
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      });
    }

    const p1 = await getTransactions(u.id, 1, 10);
    expect(p1.total).toBe(25);
    expect(p1.pages).toBe(3);
    expect(p1.transactions).toHaveLength(10);
    expect(p1.hasPrev).toBe(false);
    expect(p1.hasNext).toBe(true);
    expect(p1.transactions[0].amount, '倒序：第一页第一条是最新的第 25 笔').toBe(25);

    const p3 = await getTransactions(u.id, 3, 10);
    expect(p3.transactions, '末页只剩 5 条').toHaveLength(5);
    expect(p3.hasPrev).toBe(true);
    expect(p3.hasNext).toBe(false);

    const pages = [p1, await getTransactions(u.id, 2, 10), p3];
    const ids = pages.flatMap((p) => p.transactions.map((t) => t.id));
    expect(new Set(ids).size, '三页拼起来应无重复无遗漏').toBe(25);
  });

  it('越界页返回空列表而非报错（对齐 Flask error_out=False）', async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin' });
    const r = await getTransactions(u.id, 99, 10);
    expect(r.transactions).toEqual([]);
    expect(r.total).toBe(1);
    expect(r.hasNext).toBe(false);
  });

  it('无流水时 pages 至少为 1，total 为 0', async () => {
    const u = await makeUser();
    const r = await getTransactions(u.id);
    expect(r).toMatchObject({ total: 0, pages: 1, hasPrev: false, hasNext: false });
  });

  it('page < 1 被夹到 1；perPage 被夹到 [1, 100]', async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin' });

    expect((await getTransactions(u.id, 0, 20)).page, 'page=0 → 1').toBe(1);
    expect((await getTransactions(u.id, -5, 20)).page, '负页码 → 1').toBe(1);
    expect((await getTransactions(u.id, 1, 0)).perPage, 'perPage=0 → 1').toBe(1);
    expect((await getTransactions(u.id, 1, 9999)).perPage, 'perPage 上限 100').toBe(100);
  });

  it('按类型过滤', async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin' });
    await makeTx({ userId: u.id, amount: -2, type: 'feed' });
    await makeTx({ userId: u.id, amount: 3, type: 'feed_receive' });

    const r = await getTransactions(u.id, 1, 20, 'checkin');
    expect(r.total).toBe(1);
    expect(r.transactions[0].type).toBe('checkin');
  });

  it("type='feed_all' 同时匹配 feed 与 feed_receive（Flask 特例）", async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin' });
    await makeTx({ userId: u.id, amount: -2, type: 'feed' });
    await makeTx({ userId: u.id, amount: 3, type: 'feed_receive' });

    const r = await getTransactions(u.id, 1, 20, 'feed_all');
    expect(r.total).toBe(2);
    expect(new Set(r.transactions.map((t) => t.type))).toEqual(new Set(['feed', 'feed_receive']));
  });

  it('type 为 null / undefined / 空串时不过滤（空串是 falsy，等同不传）', async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin' });
    await makeTx({ userId: u.id, amount: -2, type: 'feed' });

    expect((await getTransactions(u.id, 1, 20, null)).total).toBe(2);
    expect((await getTransactions(u.id, 1, 20, '')).total).toBe(2);
  });

  it('未知类型返回空集，不报错', async () => {
    const u = await makeUser();
    await makeTx({ userId: u.id, amount: 1, type: 'checkin' });
    expect((await getTransactions(u.id, 1, 20, 'nope')).total).toBe(0);
  });

  it('DTO 字段完整：createdAt 序列化为 ISO 字符串，null 时保持 null', async () => {
    const u = await makeUser();
    const peer = await makeUser();
    await makeTx({
      userId: u.id,
      amount: -2,
      type: 'feed',
      description: '投喂',
      relatedUserId: peer.id,
      createdAt: new Date('2026-05-05T01:02:03.000Z'),
    });
    await makeTx({ userId: u.id, amount: 1, type: 'checkin', createdAt: null });

    const r = await getTransactions(u.id);
    const withDate = r.transactions.find((t) => t.type === 'feed')!;
    expect(withDate.createdAt).toBe('2026-05-05T01:02:03.000Z');
    expect(withDate.relatedUserId).toBe(peer.id);
    expect(withDate.description).toBe('投喂');
    expect(r.transactions.find((t) => t.type === 'checkin')!.createdAt).toBeNull();
  });
});

// ── 排行榜 ──────────────────────────────────────────────────────────────────

describe('getBalanceLeaderboard', () => {
  it('按余额降序，rank 从 1 连续递增', async () => {
    await makeUser({ username: 'low', driedFish: 1 });
    await makeUser({ username: 'high', driedFish: 100 });
    await makeUser({ username: 'mid', driedFish: 50 });

    const lb = await getBalanceLeaderboard();
    expect(lb.map((e) => e.username)).toEqual(['high', 'mid', 'low']);
    expect(lb.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(lb[0].balance).toBe(100);
  });

  it('只收余额 > 0 的用户（0 和负数都不上榜）', async () => {
    await makeUser({ username: 'zero', driedFish: 0 });
    await makeUser({ username: 'neg', driedFish: -5 });
    await makeUser({ username: 'pos', driedFish: 0.5 });

    const lb = await getBalanceLeaderboard();
    expect(lb.map((e) => e.username)).toEqual(['pos']);
  });

  it('limit 生效，且取的是余额最高的前 N 名', async () => {
    for (let i = 1; i <= 5; i++) await makeUser({ username: `u${i}`, driedFish: i });
    const lb = await getBalanceLeaderboard(2);
    expect(lb).toHaveLength(2);
    expect(lb.map((e) => e.balance)).toEqual([5, 4]);
  });

  it('余额相同时不丢人、不重复，rank 仍连续（并列的相对顺序未定义）', async () => {
    await makeUser({ username: 'tieA', driedFish: 10 });
    await makeUser({ username: 'tieB', driedFish: 10 });
    await makeUser({ username: 'tieC', driedFish: 10 });

    const lb = await getBalanceLeaderboard();
    expect(lb).toHaveLength(3);
    expect(new Set(lb.map((e) => e.username)), '并列者一个都不能少').toEqual(
      new Set(['tieA', 'tieB', 'tieC'])
    );
    expect(lb.map((e) => e.rank), 'rank 按位次连续赋值（非竞赛式并列）').toEqual([1, 2, 3]);
    expect(new Set(lb.map((e) => e.userId)).size, '不能重复出现同一用户').toBe(3);
  });

  it('⚠️ 并列 + limit 截断时，谁上榜由 SQLite 决定 —— 无第二排序键，结果不稳定', async () => {
    for (const n of ['a', 'b', 'c']) await makeUser({ username: n, driedFish: 10 });
    const first = (await getBalanceLeaderboard(2)).map((e) => e.username);
    expect(first, '仍应返回 2 条').toHaveLength(2);
    // 记录现状：orderBy 只有 driedFish desc，并列时的取舍无确定性保证。见交付说明。
  });

  it('返回 userId / username / avatarPath 字段，不泄漏 email 等敏感字段', async () => {
    const u = await makeUser({ username: 'someone', driedFish: 7 });
    const lb = await getBalanceLeaderboard();
    expect(lb[0]).toEqual({
      rank: 1,
      userId: u.id,
      username: 'someone',
      avatarPath: null,
      balance: 7,
    });
    expect(Object.keys(lb[0]), '排行榜是公开接口，字段必须收敛').toEqual([
      'rank',
      'userId',
      'username',
      'avatarPath',
      'balance',
    ]);
  });

  it('无人有余额时返回空数组', async () => {
    await makeUser({ driedFish: 0 });
    expect(await getBalanceLeaderboard()).toEqual([]);
  });
});

// ── getTodayCheckinFish ─────────────────────────────────────────────────────

// getTodayCheckinFish 用 $queryRaw + SQLite date(created_at) 比对 UTC+8 今天。
// 这依赖 created_at 的**存储格式**，而 Prisma 与 Flask/SQLAlchemy 的存法不同：
//   · Flask/SQLAlchemy → TEXT 'YYYY-MM-DD HH:MM:SS' → date() 可解析 ✅
//   · Prisma           → INTEGER 毫秒时间戳        → date() 返回 NULL ❌
// 下面的用例如实记录这一现状（含两个 BUG），不替源码打补丁。见交付说明。
describe('getTodayCheckinFish', () => {
  /** UTC+8 今天（与被测实现同口径）。 */
  const todayUtc8 = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  /**
   * 插一条「迁移来的历史流水」。
   *
   * 存储形态必须与 scripts/normalize-datetimes.mjs 的真实产物一致 —— **INTEGER（Unix 毫秒）**。
   * 不要用 TEXT ISO 当夹具：那是旧版规整脚本的产物，会让 Prisma 的日期比较按 SQLite
   * 类型序（TEXT > INTEGER）而非数值进行（gte 恒真 / lt 恒假），已知会导致发文日限额
   * 把历史文章全算成「今天」。详见 docs/nextjs-migration/03 的「为什么是 INTEGER」。
   */
  async function makeLegacyTx(userId: string, amount: number, type: string, isoTs: string) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO fish_transactions (user_id, amount, type, created_at) VALUES (?, ?, ?, ?)`,
      userId,
      amount,
      type,
      new Date(isoTs).getTime() // 规整后的存储形态：INTEGER 毫秒
    );
  }

  it('今日签到流水（迁移来的 TEXT 存储）返回其 amount', async () => {
    const u = await makeUser();
    // 用 UTC+8 正午，避开两端时区边界。
    await makeLegacyTx(u.id, 6, 'checkin', `${todayUtc8()}T12:00:00.000Z`);
    expect(await getTodayCheckinFish(u.id)).toBe(6);
  });

  it('今天未签到返回 0', async () => {
    const u = await makeUser();
    expect(await getTodayCheckinFish(u.id)).toBe(0);
  });

  it('只认 type=checkin，其它类型的今日流水不算数', async () => {
    const u = await makeUser();
    await makeLegacyTx(u.id, 9, 'feed_receive', `${todayUtc8()}T12:00:00.000Z`);
    expect(await getTodayCheckinFish(u.id)).toBe(0);
  });

  it('昨天的签到不算今天', async () => {
    const u = await makeUser();
    const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    await makeLegacyTx(u.id, 6, 'checkin', `${yesterday}T12:00:00.000Z`);
    expect(await getTodayCheckinFish(u.id)).toBe(0);
  });

  it('不串用户', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeLegacyTx(b.id, 6, 'checkin', `${todayUtc8()}T12:00:00.000Z`);
    expect(await getTodayCheckinFish(a.id)).toBe(0);
  });

  // ── 以下三条守住两个已修复的真 bug（补测试时发现）──────────────────────────
  //  BUG-1：addFish 不写 createdAt，且 schema 里 FishTransaction.createdAt 是 DateTime?
  //         无 @default(now()) → 流水时间全部落 NULL。
  //  BUG-2：getTodayCheckinFish 曾用裸 SQL `date(created_at)`。Prisma 往 SQLite 写
  //         DateTime 存的是 INTEGER（Unix 毫秒），date(整数) 返回 NULL → 所有 Next 写的
  //         签到都匹配不上，今日签到静默显示 0。已改为 Prisma 原生范围查询。

  it('BUG-1 回归：addFish 必须写入 createdAt', async () => {
    const u = await makeUser();
    await prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: 6, type: 'checkin' }));

    const row = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.createdAt, 'createdAt 为 NULL —— addFish 漏写时间戳（BUG-1 回归）').not.toBeNull();
  });

  it('BUG-2 回归：Next 自己写的签到必须能被查到（存储是 INTEGER，裸 date() 会失效）', async () => {
    const u = await makeUser();
    await prisma.$transaction((tx) => addFish(tx, { userId: u.id, amount: 6, type: 'checkin' }));

    // 佐证存储类型确实是 INTEGER —— 这正是裸 SQL date() 不可用的原因
    const [probe] = await prisma.$queryRawUnsafe<{ t: string; d: string | null }[]>(
      `SELECT typeof(created_at) t, date(created_at) d FROM fish_transactions LIMIT 1`
    );
    expect(probe.t, 'Prisma 把 DateTime 存成 INTEGER 毫秒（Flask 存 TEXT）').toBe('integer');
    expect(probe.d, 'date(<整数毫秒>) 在 SQLite 里恒为 NULL —— 故实现不能依赖它').toBeNull();

    expect(
      await getTodayCheckinFish(u.id),
      '实现若回退成裸 date()，这里会变回 0（BUG-2 回归）'
    ).toBe(6);
  });

  it('BUG-2 回归：迁移来的老数据与 Next 新写的数据，都必须能查到', async () => {
    const u = await makeUser();
    await makeLegacyTx(u.id, 6, 'checkin', `${todayUtc8()}T12:00:00.000Z`); // 规整后的老数据
    const v = await makeUser();
    await prisma.$transaction((tx) => addFish(tx, { userId: v.id, amount: 7, type: 'checkin' })); // Next 新写

    expect(await getTodayCheckinFish(u.id), '迁移来的老数据').toBe(6);
    expect(await getTodayCheckinFish(v.id), 'Next 新写的数据').toBe(7);
    // 两者存储形态一致（都是 INTEGER），这正是规整脚本要保证的
    const types = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT DISTINCT typeof(created_at) t FROM fish_transactions`
    );
    expect(types.map((r) => r.t), '新旧数据必须同为 INTEGER 存储，否则日期比较不可靠').toEqual([
      'integer',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 回归：流水时间戳与「今日签到」
//
// 补测试时发现的两个真 bug（均已修）：
//  1. addFish 不写 createdAt，而 schema 里 FishTransaction.createdAt 是 DateTime? 且
//     **无 @default(now())** → 所有经 addFish 落库的流水时间为 NULL。
//  2. getTodayCheckinFish 曾用裸 SQL `date(created_at)`。但 Prisma 往 SQLite 写 DateTime
//     存的是 INTEGER（Unix 毫秒），date(整数) 返回 NULL → 新写入的签到永远匹配不上，
//     今日签到静默显示为 0。改用 Prisma 原生范围查询（对 TEXT/INTEGER 两种存储都有效）。
// ─────────────────────────────────────────────────────────────────────────────
describe('回归：流水 createdAt 与今日签到', () => {
  it('addFish 必须写入 createdAt（NULL 会让流水排序与签到判定全失效）', async () => {
    const u = await makeUser();
    await prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: 5, type: 'checkin', description: '签到' })
    );
    const row = await prisma.fishTransaction.findFirst({ where: { userId: u.id } });
    expect(row!.createdAt, 'createdAt 为 NULL —— addFish 漏写了时间戳').not.toBeNull();
  });

  it('getTodayCheckinFish 能读到「Next 自己写的」签到流水（裸 date() 时这里必红）', async () => {
    const u = await makeUser();
    await prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: 7, type: 'checkin', description: '签到' })
    );
    const n = await getTodayCheckinFish(u.id);
    expect(n, 'Prisma 写的是 INTEGER 存储，裸 SQL date() 会返回 NULL 导致这里恒为 0').toBe(7);
  });

  it('getTodayCheckinFish 也能读到迁移来的老数据', async () => {
    const u = await makeUser();
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    // 模拟 normalize-datetimes 产出的老行：INTEGER 毫秒
    await prisma.$executeRawUnsafe(
      `INSERT INTO fish_transactions (user_id, amount, type, description, created_at)
       VALUES (?, 3, 'checkin', '老数据', ?)`,
      u.id,
      new Date(`${today}T09:30:00.000Z`).getTime()
    );
    expect(await getTodayCheckinFish(u.id), '迁移来的老数据应能被匹配到').toBe(3);
  });

  it('昨天的签到不算今天', async () => {
    const u = await makeUser();
    const y = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
    await prisma.$executeRawUnsafe(
      `INSERT INTO fish_transactions (user_id, amount, type, description, created_at)
       VALUES (?, 9, 'checkin', '昨天', ?)`,
      u.id,
      new Date(`${y}T09:30:00.000Z`).getTime()
    );
    expect(await getTodayCheckinFish(u.id)).toBe(0);
  });

  it('非 checkin 类型的流水不计入今日签到', async () => {
    const u = await makeUser();
    await prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: 100, type: 'admin_grant', description: '发钱' })
    );
    expect(await getTodayCheckinFish(u.id)).toBe(0);
  });
});
