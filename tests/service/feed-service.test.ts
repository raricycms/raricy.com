// feed-service.ts —— 文章投喂小鱼干。
//
// 【为什么值得重点测】这条路径一次动五处：投喂者余额、作者分成、BlogFeed 累计、
// Blog.fishCount，外加两条流水。任何一处漏写都是**静默**的账目损坏 —— 页面上看不出
// 异常，只在某次对账时才暴露。
//
// 【写路径的形状】这五处写入**全在同一个 SQLite 事务里**（账户微服务搬进站内之后
// 账目与业务数据同库，见 docs/architecture.md §6.3.1 的历史注记）。于是最危险的失败
// 模式从「远端没记账、本地已扣钱」变成了「事务中途炸掉、本地留下半笔」——
// 本文件最后那组用例专门盯它：注入一次真实的事务中途故障，断言本地零痕迹、异常如实
// 上抛（不被吞成「投喂失败」这种业务结果）。
//
// 【与 fish-service.test.ts 的分工】那边已经覆盖：
//   · 余额不足拒绝（余额 + 流水维度）
//   · ★ 并发超扣防护（带谓词的条件写）
//   · 扣款流水为负数 / 作者分成 80% 的基本形态
// 本文件不重复这些，专注它没覆盖的部分：
//   · 单篇每人上限 5（含多次累加、超限回滚、并发）
//   · Blog.fishCount 冗余计数
//   · 金额守恒与流水一一对应
//   · 文章/用户不存在、软删除、入参校验
//   · ★★ 事务中途故障：整笔回滚 + 异常上抛
//
// 【账目自洽】凡改过余额的用例末尾都调 expectLedgerConsistent()：**每个人的余额 ==
// 他自己的流水之和**（账户搬进站内后没有第二个存储可供核对了，内部一致性就是唯一的
// 证明）。注意它是**绝对口径**，且是「每人各自」而不是「全站之和」—— 平台回收的那
// 20% 本来就不落在任何人的账上（见下方「作者分成」一节）。
// 夹具里带余额的用户一律用 `makeFishUser()` 造（余额经由记账内核进入，与线上同构）。
//
// 【DB】真实 SQLite（tests/.tmp/test-<pid>-<rand>.db），不 mock 记账与数据库 ——
// 唯一的例外是「事务中途故障」那组，它用一条临时触发器制造真实的写失败。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { expectLedgerConsistent, makeFishUser } from '../helpers/fish-ledger';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { feedBlog, getFeedStatus } from '@/lib/feed-service';

/** 投喂自己写出来的两种流水 type（夹具那笔 admin_grant 不算）。 */
const FEED_TYPES = ['feed', 'feed_receive'];

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb();
  // 用例会故意触发故障路径（feed-service 在那条路径上打 console.error），
  // 别把它刷到屏幕上；要断言它的地方自己看 spy。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一篇文章 + 作者 + 投喂者的标准场景。 */
async function scene(opts: { feederFish?: number; authorFish?: number } = {}) {
  const author = await makeFishUser(opts.authorFish ?? 0);
  const blog = await makeBlog({ authorId: author.id, title: '测试文章' });
  const feeder = await makeFishUser(opts.feederFish ?? 100);
  return { author, blog, feeder };
}

/** 全量状态快照 —— 用于断言「什么都没发生」。 */
async function snapshot(feederId: string, authorId: string, blogId: string) {
  const [feeder, author, blog, feed, txCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: feederId }, select: { driedFish: true } }),
    prisma.user.findUnique({ where: { id: authorId }, select: { driedFish: true } }),
    prisma.blog.findUnique({ where: { id: blogId }, select: { fishCount: true } }),
    prisma.blogFeed.findUnique({
      where: { uq_blog_feed_user: { blogId, userId: feederId } },
      select: { amount: true },
    }),
    // 投喂流水的**全库**条数（任何一篇文章的）。按 type 过滤掉夹具开户那笔，
    // 于是「库里一条投喂流水都没有」这个原意得以保留。
    prisma.fishTransaction.count({ where: { type: { in: FEED_TYPES } } }),
  ]);
  return {
    // driedFish / blogFeed.amount 是 0.1 鱼干存储单位（fish-units.ts）→ 换回鱼干再比对
    feederBalance: feeder ? unitsToFish(feeder.driedFish) : null,
    authorBalance: author ? unitsToFish(author.driedFish) : null,
    fishCount: blog?.fishCount ?? null,
    fedAmount: feed ? unitsToFish(feed.amount) : null,
    txCount,
  };
}

// ── 入参校验 ────────────────────────────────────────────────────────────────

describe('feedBlog 入参校验', () => {
  it.each([
    ['0（边界：amount <= 0）', 0],
    ['负数', -3],
    ['超过单笔上限 5', 6],
    ['小数', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('%s 被拒为 400，且不触碰任何数据', async (_label, amount) => {
    const { author, blog, feeder } = await scene({ feederFish: 100 });
    const before = await snapshot(feeder.id, author.id, blog.id);

    const r = await feedBlog(blog.id, feeder.id, amount);

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 400 });
    expect(await snapshot(feeder.id, author.id, blog.id), '校验失败必须零副作用').toEqual(before);
    await expectLedgerConsistent('入参校验被拒之后');
  });

  it('amount = 5（上限边界）被接受', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 5 });
    const r = await feedBlog(blog.id, feeder.id, 5);
    expect(r.ok, '5 是合法上限，不是越界').toBe(true);
    expect((await snapshot(feeder.id, author.id, blog.id)).feederBalance).toBe(0);
    await expectLedgerConsistent('投满上限之后');
  });

  it('入参校验发生在最前面：文章不存在时也先报 400 而非 404', async () => {
    const u = await makeFishUser(10);
    const r = await feedBlog('ghost-blog', u.id, 99);
    expect(r).toMatchObject({ code: 400 });
  });
});

// ── 文章 / 用户存在性 ───────────────────────────────────────────────────────

describe('feedBlog 目标存在性', () => {
  it('文章不存在 → 404', async () => {
    const u = await makeFishUser(10);
    const r = await feedBlog('no-such-blog', u.id, 1);
    expect(r).toMatchObject({ code: 404, message: '文章不存在' });
    expect(await prisma.fishTransaction.count({ where: { type: { in: FEED_TYPES } } })).toBe(0);
  });

  it('软删除的文章（ignore=true）→ 404，且不扣款', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id, ignore: true });
    const feeder = await makeFishUser(10);

    const r = await feedBlog(blog.id, feeder.id, 2);

    expect(r, '软删除的文章不能再收投喂').toMatchObject({ code: 404, message: '文章不存在' });
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
    await expectLedgerConsistent('软删除文章被拒之后');
  });

  it('投喂者不存在 → 404（不会误报「小鱼干不足」）', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    const r = await feedBlog(blog.id, 'ghost-user', 1);
    expect(r).toMatchObject({ code: 404, message: '用户不存在' });
    expect(await prisma.fishTransaction.count({ where: { type: { in: FEED_TYPES } } })).toBe(0);
  });
});

// ── ★ 单篇每人上限 5 ────────────────────────────────────────────────────────

describe('★ 单用户单篇累计上限 5', () => {
  it('一次投满 5 成功；此后再投 1 被拒（第 6 条越界）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 20 });

    const first = await feedBlog(blog.id, feeder.id, 5);
    expect(first.ok).toBe(true);
    expect(first).toMatchObject({ fedTotal: 5, remaining: 0 });

    const after5 = await snapshot(feeder.id, author.id, blog.id);

    const sixth = await feedBlog(blog.id, feeder.id, 1);
    expect(sixth.ok, '第 6 条必须被拒').toBe(false);
    expect(sixth).toMatchObject({ code: 400, message: '投喂已满（单篇文章每人最多投喂 5 条）' });

    expect(
      await snapshot(feeder.id, author.id, blog.id),
      '超限被拒后，先扣的款必须随事务回滚 —— 状态与投满 5 之后完全一致'
    ).toEqual(after5);
    await expectLedgerConsistent('投满之后又越界一次');
  });

  it('分多次投（1+2+2）正确累计到 5，第 6 条被拒', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 20 });

    const r1 = await feedBlog(blog.id, feeder.id, 1);
    expect(r1).toMatchObject({ ok: true, fedTotal: 1, remaining: 4 });
    const r2 = await feedBlog(blog.id, feeder.id, 2);
    expect(r2).toMatchObject({ ok: true, fedTotal: 3, remaining: 2 });
    const r3 = await feedBlog(blog.id, feeder.id, 2);
    expect(r3, '1+2+2 = 5，恰好投满').toMatchObject({ ok: true, fedTotal: 5, remaining: 0 });

    const r4 = await feedBlog(blog.id, feeder.id, 1);
    expect(r4).toMatchObject({ ok: false, code: 400 });

    const feed = await prisma.blogFeed.findUniqueOrThrow({
      where: { uq_blog_feed_user: { blogId: blog.id, userId: feeder.id } },
    });
    expect(unitsToFish(feed.amount), 'BlogFeed 累计必须正好 5（存储单位换回鱼干）').toBe(5);
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 15, // 20 - 5
      authorBalance: 4, // 5 * 0.8
      fishCount: 5,
    });
    await expectLedgerConsistent('分多次投满之后');
  });

  it('已投 3，再投 3（合计 6）越界被拒；余额/BlogFeed/fishCount/流水全部不变', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 20 });
    await feedBlog(blog.id, feeder.id, 3);
    const before = await snapshot(feeder.id, author.id, blog.id);

    const r = await feedBlog(blog.id, feeder.id, 3);

    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(
      await snapshot(feeder.id, author.id, blog.id),
      '越界拒绝必须整体回滚：扣款、作者入账、两条流水、fishCount 一个都不能留'
    ).toEqual(before);
    expect(before).toMatchObject({ feederBalance: 17, authorBalance: 2.4, fishCount: 3, fedAmount: 3 });
    await expectLedgerConsistent('越界被拒之后');
  });

  it('已投 3 时，投 2（补满）成功而投 3 失败 —— 边界正好在 5', async () => {
    const { blog, feeder } = await scene({ feederFish: 20 });
    await feedBlog(blog.id, feeder.id, 3);

    expect((await feedBlog(blog.id, feeder.id, 3)).ok, '3+3=6 越界').toBe(false);
    expect((await feedBlog(blog.id, feeder.id, 2)).ok, '3+2=5 恰好，允许').toBe(true);
  });

  it('上限是「每人每篇」而非「每人」：换一篇文章可以重新投满 5', async () => {
    const author = await makeUser();
    const [b1, b2] = await Promise.all([
      makeBlog({ authorId: author.id }),
      makeBlog({ authorId: author.id }),
    ]);
    const feeder = await makeFishUser(20);

    expect((await feedBlog(b1.id, feeder.id, 5)).ok).toBe(true);
    expect((await feedBlog(b2.id, feeder.id, 5)).ok, '另一篇文章额度独立').toBe(true);
    expect((await feedBlog(b1.id, feeder.id, 1)).ok, '第一篇仍是满的').toBe(false);
    await expectLedgerConsistent('同一人在两篇文章上各投满');
  });

  it('上限是「每人每篇」而非「每篇」：另一个用户可以对同一篇再投满 5', async () => {
    const { blog } = await scene();
    const a = await makeFishUser(10);
    const b = await makeFishUser(10);

    expect((await feedBlog(blog.id, a.id, 5)).ok).toBe(true);
    expect((await feedBlog(blog.id, b.id, 5)).ok, '别人的额度不受影响').toBe(true);

    const blogRow = await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } });
    expect(blogRow.fishCount, '文章总量 = 5 + 5，文章本身没有上限').toBe(10);
    await expectLedgerConsistent('两人对同一篇各投满');
  });

  it('并发对同一篇投喂：累计绝不能突破 5（靠事务串行 + 事务内的累计判定）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 100 });

    const results = await Promise.all(
      Array.from({ length: 3 }, () => feedBlog(blog.id, feeder.id, 5).catch(() => null))
    );

    const feed = await prisma.blogFeed.findUniqueOrThrow({
      where: { uq_blog_feed_user: { blogId: blog.id, userId: feeder.id } },
    });
    const okCount = results.filter((r) => r && r.ok).length;

    expect(unitsToFish(feed.amount), `BlogFeed 累计突破上限（实测 ${feed.amount} 存储单位，成功 ${okCount} 笔）`).toBe(5);
    expect(okCount, '3 笔并发 ×5，只能成功 1 笔').toBe(1);

    const blogRow = await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } });
    expect(blogRow.fishCount, 'fishCount 必须与 BlogFeed 累计一致').toBe(5);
    expect(
      unitsToFish(
        (await prisma.user.findUniqueOrThrow({ where: { id: feeder.id } })).driedFish
      )
    ).toBe(95);
    await expectLedgerConsistent('并发投喂之后');
  });
});

// ── 余额不足（fish-service.test 已测余额+流水；这里补 BlogFeed / fishCount 维度）──

describe('余额不足', () => {
  it('拒绝时 BlogFeed 与 Blog.fishCount 也必须不变（不能白记一笔投喂量）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 2 });

    const r = await feedBlog(blog.id, feeder.id, 5);

    expect(r).toMatchObject({ ok: false, code: 400, message: '小鱼干不足' });
    expect(await snapshot(feeder.id, author.id, blog.id)).toEqual({
      feederBalance: 2,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
    await expectLedgerConsistent('余额不足被拒之后');
  });

  it('余额不足时不新增 BlogFeed，也不污染已有的 BlogFeed 累计', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 2 });
    await feedBlog(blog.id, feeder.id, 2); // 花光
    const before = await snapshot(feeder.id, author.id, blog.id);

    const r = await feedBlog(blog.id, feeder.id, 1);

    expect(r).toMatchObject({ ok: false, message: '小鱼干不足' });
    expect(await snapshot(feeder.id, author.id, blog.id)).toEqual(before);
    expect(before.fedAmount, '已投的 2 保持不变').toBe(2);
    await expectLedgerConsistent('花光之后再投被拒');
  });
});

// ── Blog.fishCount 冗余计数 ─────────────────────────────────────────────────

describe('Blog.fishCount 冗余计数', () => {
  it('等于所有 BlogFeed.amount 之和（多用户多次投喂后仍然对得上）', async () => {
    const { blog } = await scene();
    const a = await makeFishUser(50);
    const b = await makeFishUser(50);

    await feedBlog(blog.id, a.id, 2);
    await feedBlog(blog.id, b.id, 5);
    await feedBlog(blog.id, a.id, 3);
    await feedBlog(blog.id, b.id, 1).catch(() => null); // b 已满，应被拒

    const feeds = await prisma.blogFeed.findMany({ where: { blogId: blog.id } });
    const sum = feeds.reduce((s, f) => s + unitsToFish(f.amount), 0); // 存储单位换回鱼干再求和
    const blogRow = await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } });

    expect(sum, 'a 投 5 + b 投 5').toBe(10);
    expect(blogRow.fishCount, 'fishCount 与 BlogFeed 之和必须一致，否则前台数字是假的').toBe(sum);
    await expectLedgerConsistent('多人多次投喂之后');
  });

  it('返回值 fishCount 反映的是文章总量（含他人投喂），不是本人的 fedTotal', async () => {
    const { blog } = await scene();
    const a = await makeFishUser(50);
    const b = await makeFishUser(50);

    await feedBlog(blog.id, a.id, 4);
    const r = await feedBlog(blog.id, b.id, 3);

    expect(r).toMatchObject({ ok: true, fedTotal: 3, remaining: 2, fishCount: 7 });
  });

  it('其它文章的 fishCount 不受影响（不串篇）', async () => {
    const author = await makeUser();
    const [b1, b2] = await Promise.all([
      makeBlog({ authorId: author.id }),
      makeBlog({ authorId: author.id }),
    ]);
    const feeder = await makeFishUser(20);

    await feedBlog(b1.id, feeder.id, 3);

    expect((await prisma.blog.findUniqueOrThrow({ where: { id: b2.id } })).fishCount).toBe(0);
    await expectLedgerConsistent('只投了其中一篇');
  });
});

// ── 作者分成：金额守恒 + 流水一一对应 ───────────────────────────────────────

describe('作者分成 80% 与金额守恒', () => {
  it.each([
    [1, 0.8],
    [2, 1.6],
    [3, 2.4],
    [4, 3.2],
    [5, 4],
  ])('投喂 %i → 作者入账 %f（round(amount*0.8, 1)）', async (amount, expected) => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    const r = await feedBlog(blog.id, feeder.id, amount);

    expect(r).toMatchObject({ ok: true, authorIncome: expected });
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 10 - amount,
      authorBalance: expected,
    });
    await expectLedgerConsistent(`投喂 ${amount} 之后`);
  });

  it('两侧流水一一对应：一次投喂产生且仅产生 2 条流水，金额互为 -amount / +80%', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    await feedBlog(blog.id, feeder.id, 3);

    const all = await prisma.fishTransaction.findMany({
      where: { type: { in: FEED_TYPES } },
      orderBy: { id: 'asc' },
    });
    expect(all, '恰好两条：投喂者支出 + 作者收入').toHaveLength(2);

    const [spend, income] = all;
    expect(spend).toMatchObject({
      userId: feeder.id,
      amount: fishToUnits(-3), // 存储单位 = 0.1 鱼干
      type: 'feed',
      referenceType: 'blog',
      referenceId: blog.id,
      relatedUserId: author.id,
      description: '投喂文章「测试文章」',
    });
    expect(income).toMatchObject({
      userId: author.id,
      amount: fishToUnits(2.4),
      type: 'feed_receive',
      referenceType: 'blog',
      referenceId: blog.id,
      relatedUserId: feeder.id,
      description: '文章「测试文章」被投喂',
    });
    expect(spend.relatedUserId, '对手方必须互指，否则无法对账').toBe(author.id);
    expect(income.relatedUserId).toBe(feeder.id);
    expect(
      await prisma.accountSyncLedger.count(),
      '投喂不登记幂等记录：一次投喂就是一笔新交易，键带随机后缀，登记没有去重价值' +
        '（判据见 src/lib/fish-idempotency.ts 头部）。挡住重复投喂的是「单篇每人 ≤ 5」这条额度'
    ).toBe(0);
  });

  it('余额变动与流水金额严格守恒（每个人的余额 = 他自己的流水之和）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10, authorFish: 0 });

    await feedBlog(blog.id, feeder.id, 2);
    await feedBlog(blog.id, feeder.id, 3);

    const feederTxs = await prisma.fishTransaction.findMany({ where: { userId: feeder.id } });
    const authorTxs = await prisma.fishTransaction.findMany({ where: { userId: author.id } });
    // 流水金额是 0.1 鱼干存储单位 —— 换回鱼干后再与余额守恒比对
    const sum = (rows: { amount: number }[]) =>
      rows.reduce((s, r) => s + unitsToFish(r.amount), 0);

    const snap = await snapshot(feeder.id, author.id, blog.id);
    expect(snap.feederBalance, '10 − 2 − 3').toBe(5);
    expect(snap.authorBalance, '0 + 1.6 + 2.4').toBe(4);
    // 两侧都要对上（夹具那笔开户流水也算 —— 它同样是真实的一笔）
    expect(snap.feederBalance).toBeCloseTo(sum(feederTxs), 6);
    expect(snap.authorBalance).toBeCloseTo(sum(authorTxs), 6);
    await expectLedgerConsistent('两次投喂之后');
  });

  it('平台留成 20%：投喂者支出 5，作者只得 4 —— 差额 1 不落任何人的账', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 5, authorFish: 0 });
    await feedBlog(blog.id, feeder.id, 5);

    const snap = await snapshot(feeder.id, author.id, blog.id);
    expect(snap.feederBalance).toBe(0);
    expect(snap.authorBalance).toBe(4);
    // 那 1 条是**平台回收**：本地没有系统账户这一侧，也没有第二处存储需要配平。
    // 这是刻意的（见 feed-service.ts 文件头），别为了「全站之和守恒」给谁补一笔。
    // 账目自洽的口径是**每人各自**：余额 == 他自己的流水之和 —— 上面那条守恒用例
    // 与 expectLedgerConsistent() 都是这个口径。
    await expectLedgerConsistent('平台回收 20% 之后');
  });

  it('自己投喂自己的文章：允许（刻意不做拦截），净损失 20%，且不发通知给自己', async () => {
    const self = await makeFishUser(10);
    const blog = await makeBlog({ authorId: self.id, title: '自投' });

    const r = await feedBlog(blog.id, self.id, 5);

    expect(r.ok, '无自投拦截，仅跳过通知').toBe(true);
    const bal = unitsToFish(
      (await prisma.user.findUniqueOrThrow({ where: { id: self.id } })).driedFish
    );
    expect(bal, '10 - 5 + 4 = 9（自投净亏 20%）').toBe(9);
    expect(
      await prisma.fishTransaction.count({ where: { userId: self.id, type: { in: FEED_TYPES } } }),
      '仍然是两条流水（支出 + 收入）'
    ).toBe(2);
    expect(
      await prisma.notification.count({ where: { recipientId: self.id, actorId: self.id } }),
      '给自己投喂不该给自己发通知'
    ).toBe(0);
    await expectLedgerConsistent('自投之后');
  });

  it('投喂成功给作者发一条通知（钱记完之后才发，失败也不回退投喂）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    await feedBlog(blog.id, feeder.id, 2);

    const notes = await prisma.notification.findMany({
      where: { recipientId: author.id, action: '文章投喂' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actorId: feeder.id, objectType: 'blog', objectId: blog.id });
    await expectLedgerConsistent('发过通知之后');
  });
});

// ── getFeedStatus ───────────────────────────────────────────────────────────

describe('getFeedStatus', () => {
  it('未投喂过：fed=0 / remaining=5 / isFull=false', async () => {
    const { blog, feeder } = await scene();
    expect(await getFeedStatus(blog.id, feeder.id)).toEqual({ fed: 0, remaining: 5, isFull: false });
  });

  it('投喂后如实反映累计与剩余', async () => {
    const { blog, feeder } = await scene({ feederFish: 10 });
    await feedBlog(blog.id, feeder.id, 2);
    expect(await getFeedStatus(blog.id, feeder.id)).toEqual({ fed: 2, remaining: 3, isFull: false });
  });

  it('投满后 isFull=true / remaining=0', async () => {
    const { blog, feeder } = await scene({ feederFish: 10 });
    await feedBlog(blog.id, feeder.id, 5);
    expect(await getFeedStatus(blog.id, feeder.id)).toEqual({ fed: 5, remaining: 0, isFull: true });
  });

  it('不串用户 / 不串文章', async () => {
    const { blog, feeder } = await scene({ feederFish: 10 });
    const other = await makeFishUser(10);
    const otherBlog = await makeBlog({});
    await feedBlog(blog.id, feeder.id, 3);

    expect(await getFeedStatus(blog.id, other.id), '别人的额度不受影响').toMatchObject({ fed: 0 });
    expect(await getFeedStatus(otherBlog.id, feeder.id), '另一篇文章额度独立').toMatchObject({ fed: 0 });
  });

  it('文章不存在时安全返回 0，不抛错（详情页渲染不能因此 500）', async () => {
    const u = await makeUser();
    expect(await getFeedStatus('ghost-blog', u.id)).toEqual({ fed: 0, remaining: 5, isFull: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 事务中途故障：整笔回滚 + 异常如实上抛
//
// 这一组的前身叫「fail-closed：远端账户服务失败」，盯的是「远端没记账、本地却已扣钱」。
// 账户搬进站内之后那条边界消失了，但**同一类事故仍然存在**：事务已经写了一部分
// （投喂者已扣、作者已入账），提交前炸掉。断言因此照旧 ——
// 余额 / 流水 / BlogFeed / fishCount 一个都不能留，异常也不许被吞成「投喂失败」
// 那种业务结果（路由要把它当 500 真故障，而不是让用户以为「钱没扣、待会儿再试」）。
// ═══════════════════════════════════════════════════════════════════════════

describe('★★ 事务中途故障：本地零痕迹、异常如实上抛', () => {
  /**
   * 注入一次「写 blog_feeds 失败」的基础设施故障：临时触发器，随用随撤。
   *
   * 【为什么用触发器而不是 mock】故障必须发生在**真实事务的中途**（两次 postEntry
   * 之后）才谈得上验证回滚。触发器拦的是 Prisma 真正发下去的那条语句，与磁盘写满、
   * 约束冲突这类真故障同一性质；把服务层的函数 mock 掉，验的就只是 mock 自己。
   *
   * INSERT 与 UPDATE 两条都拦：第二次投喂走的是 update 分支。
   */
  async function withFeedWriteFailure<T>(fn: () => Promise<T>): Promise<T> {
    for (const [name, event] of [
      ['test_inject_fault_ins', 'INSERT'],
      ['test_inject_fault_upd', 'UPDATE'],
    ]) {
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE ${event} ON blog_feeds
         BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
      );
    }
    try {
      return await fn();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_inject_fault_ins');
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_inject_fault_upd');
    }
  }

  it('事务中途抛错 → 余额/流水/BlogFeed/fishCount 全无痕迹，且异常上抛', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });
    const before = await snapshot(feeder.id, author.id, blog.id);

    const err = await withFeedWriteFailure(() => feedBlog(blog.id, feeder.id, 3)).catch((e) => e);

    // ⚠️ 断言只钉「抛了」，不匹配文案：Prisma 会把触发器的 RAISE(ABORT) 报成
    // 「Foreign key constraint violated on the foreign key」—— 那是它的错误映射，
    // 不是真的外键问题（实测：同样的写入在触发器撤掉之后一切正常）。
    expect(err, '事务炸了就是真故障 —— 不许被吞成 ok:false 的业务结果').toBeInstanceOf(Error);
    expect(await snapshot(feeder.id, author.id, blog.id), '★ 半笔账 = 真实损失，必须为零').toEqual(
      before
    );
    expect(before).toEqual({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
    await expectLedgerConsistent('事务中途故障之后');
  });

  it('失败后额度原样保留 —— BlogFeed 不该留下行，否则用户额度被白白吃掉', async () => {
    const { blog, feeder } = await scene({ feederFish: 10 });

    await withFeedWriteFailure(() => feedBlog(blog.id, feeder.id, 5)).catch(() => null);

    expect(await getFeedStatus(blog.id, feeder.id), '额度必须原样保留 5').toEqual({
      fed: 0,
      remaining: 5,
      isFull: false,
    });
    await expectLedgerConsistent('故障吃掉额度之后');
  });

  it('已有成功投喂后再故障：状态停在上一次成功处，不多不少', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    expect((await feedBlog(blog.id, feeder.id, 2)).ok).toBe(true);
    const before = await snapshot(feeder.id, author.id, blog.id);

    await withFeedWriteFailure(() => feedBlog(blog.id, feeder.id, 3)).catch(() => null);

    expect(await snapshot(feeder.id, author.id, blog.id), '第二笔必须完全消失').toEqual(before);
    expect(before).toMatchObject({ feederBalance: 8, authorBalance: 1.6, fedAmount: 2, txCount: 2 });
    await expectLedgerConsistent('成功一笔、失败一笔之后');
  });

  it('故障 → 重试成功：只记一次账（回滚干净，不会双扣）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    await withFeedWriteFailure(() => feedBlog(blog.id, feeder.id, 3)).catch(() => null); // 第一次：写库炸
    const retry = await feedBlog(blog.id, feeder.id, 3); // 第二次：恢复

    expect(retry).toMatchObject({ ok: true, fedTotal: 3, remaining: 2 });
    expect(await snapshot(feeder.id, author.id, blog.id), '只能扣一次 3').toEqual({
      feederBalance: 7,
      authorBalance: 2.4,
      fishCount: 3,
      fedAmount: 3,
      txCount: 2,
    });
    await expectLedgerConsistent('故障后重试成功');
  });

  it('故障留下可诊断的日志（含 user / blog / amount）', async () => {
    const { blog, feeder } = await scene({ feederFish: 10 });

    await withFeedWriteFailure(() => feedBlog(blog.id, feeder.id, 2)).catch(() => null);

    // 路由靠它把真故障与业务结果分开：这里没有「稍后重试即可」的 503 可包装，
    // 只有一条能定位到人的日志。
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(feeder.id), expect.anything());
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(blog.id), expect.anything());
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('amount=2'), expect.anything());
  });
});

// ── 与账户 Key 无关 ─────────────────────────────────────────────────────────

describe('与账户 Key 无关', () => {
  it('投喂不看 users.fishApiKeyEncrypted：留一坨坏密文也照样投成', async () => {
    // 那一列（连同 ACCOUNT_SERVICE_* 环境变量）当年是发往站外账户微服务的**用户凭据**，
    // 现在没有任何代码读它。这条用例的价值不是「解密失败也能投」，而是钉住
    // 「投喂路径完全不碰它」—— 谁哪天把凭据校验加回来，这里会红。
    //
    // （这里原有两条「ACCOUNT_SERVICE_INTERNAL_TOKEN 未配置 → dev fallback」的用例，
    //   测的是「远端启用 / 未启用」两套模式：未启用时不打远端、不解密 Key、
    //   没有 Key 也能投。模式本身没有了 —— 那个 token 已无人读取，
    //   留下的就是这个更强的事实：**任何模式下都不需要 Key**。）
    const { blog, feeder } = await scene({ feederFish: 10 });
    await prisma.user.update({
      where: { id: feeder.id },
      data: { fishApiKeyEncrypted: 'fernet-blob-that-would-never-decrypt' },
    });

    expect((await feedBlog(blog.id, feeder.id, 1)).ok).toBe(true);
    await expectLedgerConsistent('投喂者带着坏密文时');
  });
});

// ── 禁言：校验在路由层，服务层不管 ──────────────────────────────────────────

describe('禁言用户', () => {
  it('禁言校验在 route 层（isCurrentlyBanned → 403），feed-service 本身不校验', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    const banned = await makeFishUser(10, {
      isBanned: true,
      banUntil: new Date(Date.now() + 86400_000),
      banReason: '测试禁言',
    });

    const r = await feedBlog(blog.id, banned.id, 1);

    // 记录现状：服务层放行。拦截点在 src/app/api/blogs/[id]/feed/route.ts:13
    // （getCurrentUser + isCurrentlyBanned → apiErr(403)）。
    expect(r.ok, 'feed-service 不做禁言校验 —— 该职责在路由层').toBe(true);
    await expectLedgerConsistent('被禁言者投喂之后');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 这里原有两组用例，测的是账户微服务**站在站外**时的契约，随那条边界一起消失：
//
//   · 「远端账户服务失败」的各种形态（AccountServiceError / 普通 Error / AbortError /
//     超时 / Key 解密失败 / 没有 Key）—— 现在没有远端可失败，故障注入点换成了
//     真实的写库失败（上面「事务中途故障」一组）。其中五条**性质改写**后保留：
//     失败 → 零痕迹、失败不吃额度、失败后状态停在上一次成功处、故障后重试只记一次、
//     故障留下可诊断日志；另外几条（错误类型与 503 的保留、AbortError 语义）是
//     远端契约本身，没有对应物。
//   · 「远端成功路径：本地先提交 + 账本登记，再同步」—— 包括传给远端的参数一致性、
//     feedSeq 是累计量、账本里的 pending 行（崩溃恢复的锚点）等：这些断言的**对象**
//     （远端调用参数、outbox 行）都不存在了。
//     它的现行残余 —— **投喂不登记幂等键**（键带随机后缀 → 登记没有去重价值，
//     判据见 src/lib/fish-idempotency.ts 头部）—— 已在「两侧流水一一对应」一例里直接钉住，
//     另见 fish-admin.test.ts 的同名断言。
// ─────────────────────────────────────────────────────────────────────────────
