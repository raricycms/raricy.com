// feed-service.ts —— 文章投喂小鱼干。
//
// 【为什么值得重点测】这条路径同时动三样东西：投喂者余额、作者余额、以及远端账户
// 微服务的复式账本。任何一处失配都是真实资产损失。最危险的失败模式不是「投喂失败」，
// 而是「远端失败但本地已扣钱」—— CLAUDE.md Phase 1.5 的 fail-closed 就是为了它。
//
// 【与 fish-service.test.ts 的分工】那边已经覆盖：
//   · 余额不足拒绝（余额 + 流水维度）
//   · ★ 并发超扣防护（原子 updateMany）
//   · 扣款流水为负数 / 作者分成 80% 的基本形态
// 本文件不重复这些，专注它没覆盖的部分：
//   · 单篇每人上限 5（含多次累加、超限回滚、并发）
//   · Blog.fishCount 冗余计数
//   · 金额守恒与流水一一对应
//   · 文章/用户不存在、软删除、入参校验
//   · ★★ fail-closed：远端失败时本地事务必须整体回滚
//
// 【DB】真实 SQLite（tests/.tmp/test.db），不 mock。只 mock 远端账户服务。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';

// ── 远端账户服务 mock ────────────────────────────────────────────────────────
//
// 只替换三个出口，其余（AccountServiceError 类等）保留真身 —— feed-service 里
// `e instanceof AccountServiceError` 依赖类身份，spread actual 才不会被破坏。
const { mockEnabled, mockDecrypt, mockFeedTransfer } = vi.hoisted(() => ({
  mockEnabled: vi.fn<() => boolean>(),
  mockDecrypt: vi.fn<() => string>(),
  mockFeedTransfer: vi.fn<(input: unknown) => Promise<void>>(),
}));

vi.mock('@/lib/account-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-client')>();
  return {
    ...actual,
    accountServiceEnabled: mockEnabled,
    decryptApiKey: mockDecrypt,
    accountClient: { ...actual.accountClient, feedTransfer: mockFeedTransfer },
  };
});

import { feedBlog, getFeedStatus } from '@/lib/feed-service';
import { AccountServiceError } from '@/lib/account-client';

/** 让远端「已配置且一切正常」。默认（不调用）是 dev fallback。 */
function enableRemote() {
  mockEnabled.mockReturnValue(true);
  mockDecrypt.mockReturnValue('decrypted-api-key');
  mockFeedTransfer.mockResolvedValue(undefined);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  // 默认：账户服务未配置 → dev fallback（与 tests/setup.ts 的真实环境一致）
  mockEnabled.mockReturnValue(false);
  mockDecrypt.mockReturnValue('decrypted-api-key');
  mockFeedTransfer.mockResolvedValue(undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 造一个「远端可用」的投喂者：带 fishApiKeyEncrypted。 */
async function makeFeederWithKey(driedFish: number) {
  const u = await makeUser({ driedFish });
  await prisma.user.update({
    where: { id: u.id },
    data: { fishApiKeyEncrypted: 'fernet-blob-placeholder' },
  });
  return u;
}

/** 一篇文章 + 作者 + 投喂者的标准场景。 */
async function scene(opts: { feederFish?: number; authorFish?: number; withKey?: boolean } = {}) {
  const author = await makeUser({ driedFish: opts.authorFish ?? 0 });
  const blog = await makeBlog({ authorId: author.id, title: '测试文章' });
  const feeder = opts.withKey
    ? await makeFeederWithKey(opts.feederFish ?? 100)
    : await makeUser({ driedFish: opts.feederFish ?? 100 });
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
    prisma.fishTransaction.count(),
  ]);
  return {
    feederBalance: feeder?.driedFish ?? null,
    authorBalance: author?.driedFish ?? null,
    fishCount: blog?.fishCount ?? null,
    fedAmount: feed?.amount ?? null,
    txCount,
  };
}

// ── 入参校验 ────────────────────────────────────────────────────────────────

describe('feedBlog 入参校验', () => {
  it.each([
    ['0（Flask: amount <= 0）', 0],
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
  });

  it('amount = 5（上限边界）被接受', async () => {
    const { blog, feeder } = await scene({ feederFish: 5 });
    const r = await feedBlog(blog.id, feeder.id, 5);
    expect(r.ok, '5 是合法上限，不是越界').toBe(true);
  });

  it('入参校验发生在最前面：文章不存在时也先报 400 而非 404', async () => {
    const u = await makeUser({ driedFish: 10 });
    const r = await feedBlog('ghost-blog', u.id, 99);
    expect(r).toMatchObject({ code: 400 });
  });
});

// ── 文章 / 用户存在性 ───────────────────────────────────────────────────────

describe('feedBlog 目标存在性', () => {
  it('文章不存在 → 404', async () => {
    const u = await makeUser({ driedFish: 10 });
    const r = await feedBlog('no-such-blog', u.id, 1);
    expect(r).toMatchObject({ code: 404, message: '文章不存在' });
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('软删除的文章（ignore=true）→ 404，且不扣款', async () => {
    const author = await makeUser({ driedFish: 0 });
    const blog = await makeBlog({ authorId: author.id, ignore: true });
    const feeder = await makeUser({ driedFish: 10 });

    const r = await feedBlog(blog.id, feeder.id, 2);

    expect(r, '软删除的文章不能再收投喂').toMatchObject({ code: 404, message: '文章不存在' });
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
  });

  it('投喂者不存在 → 404（不会误报「小鱼干不足」）', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    const r = await feedBlog(blog.id, 'ghost-user', 1);
    expect(r).toMatchObject({ code: 404, message: '用户不存在' });
    expect(await prisma.fishTransaction.count()).toBe(0);
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
    expect(feed.amount, 'BlogFeed 累计必须正好 5').toBe(5);
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 15, // 20 - 5
      authorBalance: 4, // 5 * 0.8
      fishCount: 5,
    });
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
  });

  it('已投 3 时，投 2（补满）成功而投 3 失败 —— 边界正好在 5', async () => {
    const { blog, feeder } = await scene({ feederFish: 20 });
    await feedBlog(blog.id, feeder.id, 3);

    expect((await feedBlog(blog.id, feeder.id, 3)).ok, '3+3=6 越界').toBe(false);
    expect((await feedBlog(blog.id, feeder.id, 2)).ok, '3+2=5 恰好，允许').toBe(true);
  });

  it('上限是「每人每篇」而非「每人」：换一篇文章可以重新投满 5', async () => {
    const author = await makeUser({ driedFish: 0 });
    const [b1, b2] = await Promise.all([
      makeBlog({ authorId: author.id }),
      makeBlog({ authorId: author.id }),
    ]);
    const feeder = await makeUser({ driedFish: 20 });

    expect((await feedBlog(b1.id, feeder.id, 5)).ok).toBe(true);
    expect((await feedBlog(b2.id, feeder.id, 5)).ok, '另一篇文章额度独立').toBe(true);
    expect((await feedBlog(b1.id, feeder.id, 1)).ok, '第一篇仍是满的').toBe(false);
  });

  it('上限是「每人每篇」而非「每篇」：另一个用户可以对同一篇再投满 5', async () => {
    const { blog } = await scene();
    const a = await makeUser({ driedFish: 10 });
    const b = await makeUser({ driedFish: 10 });

    expect((await feedBlog(blog.id, a.id, 5)).ok).toBe(true);
    expect((await feedBlog(blog.id, b.id, 5)).ok, '别人的额度不受影响').toBe(true);

    const blogRow = await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } });
    expect(blogRow.fishCount, '文章总量 = 5 + 5，文章本身没有上限').toBe(10);
  });

  it('并发对同一篇投喂：累计绝不能突破 5（Flask 用原子 UPDATE ... WHERE amount+n<=5）', async () => {
    const { blog, feeder } = await scene({ feederFish: 100 });

    const results = await Promise.all(
      Array.from({ length: 3 }, () => feedBlog(blog.id, feeder.id, 5).catch(() => null))
    );

    const feed = await prisma.blogFeed.findUniqueOrThrow({
      where: { uq_blog_feed_user: { blogId: blog.id, userId: feeder.id } },
    });
    const okCount = results.filter((r) => r && r.ok).length;

    expect(feed.amount, `BlogFeed 累计突破上限（实测 ${feed.amount}，成功 ${okCount} 笔）`).toBe(5);
    expect(okCount, '3 笔并发 ×5，只能成功 1 笔').toBe(1);

    const blogRow = await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } });
    expect(blogRow.fishCount, 'fishCount 必须与 BlogFeed 累计一致').toBe(5);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: feeder.id } }).then((u) => u.driedFish))
      .toBe(95);
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
  });

  it('余额不足时不新增 BlogFeed，也不污染已有的 BlogFeed 累计', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 2 });
    await feedBlog(blog.id, feeder.id, 2); // 花光
    const before = await snapshot(feeder.id, author.id, blog.id);

    const r = await feedBlog(blog.id, feeder.id, 1);

    expect(r).toMatchObject({ ok: false, message: '小鱼干不足' });
    expect(await snapshot(feeder.id, author.id, blog.id)).toEqual(before);
    expect(before.fedAmount, '已投的 2 保持不变').toBe(2);
  });
});

// ── Blog.fishCount 冗余计数 ─────────────────────────────────────────────────

describe('Blog.fishCount 冗余计数', () => {
  it('等于所有 BlogFeed.amount 之和（多用户多次投喂后仍然对得上）', async () => {
    const { blog } = await scene();
    const a = await makeUser({ driedFish: 50 });
    const b = await makeUser({ driedFish: 50 });

    await feedBlog(blog.id, a.id, 2);
    await feedBlog(blog.id, b.id, 5);
    await feedBlog(blog.id, a.id, 3);
    await feedBlog(blog.id, b.id, 1).catch(() => null); // b 已满，应被拒

    const feeds = await prisma.blogFeed.findMany({ where: { blogId: blog.id } });
    const sum = feeds.reduce((s, f) => s + f.amount, 0);
    const blogRow = await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } });

    expect(sum, 'a 投 5 + b 投 5').toBe(10);
    expect(blogRow.fishCount, 'fishCount 与 BlogFeed 之和必须一致，否则前台数字是假的').toBe(sum);
  });

  it('返回值 fishCount 反映的是文章总量（含他人投喂），不是本人的 fedTotal', async () => {
    const { blog } = await scene();
    const a = await makeUser({ driedFish: 50 });
    const b = await makeUser({ driedFish: 50 });

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
    const feeder = await makeUser({ driedFish: 20 });

    await feedBlog(b1.id, feeder.id, 3);

    expect((await prisma.blog.findUniqueOrThrow({ where: { id: b2.id } })).fishCount).toBe(0);
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
  });

  it('两侧流水一一对应：一次投喂产生且仅产生 2 条流水，金额互为 -amount / +80%', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    await feedBlog(blog.id, feeder.id, 3);

    const all = await prisma.fishTransaction.findMany({ orderBy: { id: 'asc' } });
    expect(all, '恰好两条：投喂者支出 + 作者收入').toHaveLength(2);

    const [spend, income] = all;
    expect(spend).toMatchObject({
      userId: feeder.id,
      amount: -3,
      type: 'feed',
      referenceType: 'blog',
      referenceId: blog.id,
      relatedUserId: author.id,
      description: '投喂文章「测试文章」',
    });
    expect(income).toMatchObject({
      userId: author.id,
      amount: 2.4,
      type: 'feed_receive',
      referenceType: 'blog',
      referenceId: blog.id,
      relatedUserId: feeder.id,
      description: '文章「测试文章」被投喂',
    });
    expect(spend.relatedUserId, '对手方必须互指，否则无法对账').toBe(author.id);
    expect(income.relatedUserId).toBe(feeder.id);
  });

  it('余额变动与流水金额严格守恒（余额 = 流水之和）', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 10, authorFish: 0 });

    await feedBlog(blog.id, feeder.id, 2);
    await feedBlog(blog.id, feeder.id, 3);

    const feederTxs = await prisma.fishTransaction.findMany({ where: { userId: feeder.id } });
    const authorTxs = await prisma.fishTransaction.findMany({ where: { userId: author.id } });
    const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

    const snap = await snapshot(feeder.id, author.id, blog.id);
    expect(snap.feederBalance, '10 + (-2) + (-3)').toBeCloseTo(10 + sum(feederTxs), 6);
    expect(snap.authorBalance, '0 + 1.6 + 2.4').toBeCloseTo(sum(authorTxs), 6);
    expect(snap.feederBalance).toBe(5);
    expect(snap.authorBalance).toBe(4);
  });

  it('平台留成 20%：投喂者支出 5，作者只得 4 —— 差额 1 不在任何本地账户上', async () => {
    const { author, blog, feeder } = await scene({ feederFish: 5, authorFish: 0 });
    await feedBlog(blog.id, feeder.id, 5);

    const snap = await snapshot(feeder.id, author.id, blog.id);
    expect(snap.feederBalance).toBe(0);
    expect(snap.authorBalance).toBe(4);
    // 本地库里没有系统账户，20% 的去向只体现在远端（SYSTEM_USER_ID 账户）。
    // 记录现状：本地两侧之和不守恒是**设计如此**，对账要看账户服务。
  });

  it('自己投喂自己的文章：允许（对齐 Flask，不做拦截），净损失 20%', async () => {
    const self = await makeUser({ driedFish: 10 });
    const blog = await makeBlog({ authorId: self.id, title: '自投' });

    const r = await feedBlog(blog.id, self.id, 5);

    expect(r.ok, 'Flask feed_fish 无自投拦截，仅跳过通知 —— Next 保持一致').toBe(true);
    const bal = (await prisma.user.findUniqueOrThrow({ where: { id: self.id } })).driedFish;
    expect(bal, '10 - 5 + 4 = 9（自投净亏 20%）').toBe(9);
    expect(await prisma.fishTransaction.count(), '仍然是两条流水（支出 + 收入）').toBe(2);
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
    const other = await makeUser({ driedFish: 10 });
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
// ★★★ fail-closed（CLAUDE.md Phase 1.5）★★★
//
// 最危险的失败模式：远端没记账，本地却已经扣了钱（或反过来）。
// 约定：远端失败 → 本地事务整体回滚 + 向上抛 AccountServiceError（路由转 503），
//       绝不静默成功。
// ═══════════════════════════════════════════════════════════════════════════

describe('dev fallback（ACCOUNT_SERVICE_INTERNAL_TOKEN 未配置）', () => {
  it('前置事实：测试环境确实没有 internal token，真实 accountServiceEnabled() 为 false', async () => {
    const actual = await vi.importActual<typeof import('@/lib/account-client')>(
      '@/lib/account-client'
    );
    expect(process.env.ACCOUNT_SERVICE_INTERNAL_TOKEN, 'tests/setup.ts 已 delete').toBeUndefined();
    expect(actual.accountServiceEnabled(), '未配置 token → 走 dev fallback 分支').toBe(false);
  });

  it('走 dev fallback：不打远端、不解密 Key，仅写本地并 console.warn 告警', async () => {
    mockEnabled.mockReturnValue(false);
    const { author, blog, feeder } = await scene({ feederFish: 10 });

    const r = await feedBlog(blog.id, feeder.id, 2);

    expect(r.ok).toBe(true);
    expect(mockFeedTransfer, 'fallback 分支绝不能打远端').not.toHaveBeenCalled();
    expect(mockDecrypt, 'fallback 分支不需要解密 Key').not.toHaveBeenCalled();
    expect(warnSpy, 'fallback 必须留下告警，避免在生产被误当成正常路径').toHaveBeenCalledWith(
      expect.stringContaining('ACCOUNT_SERVICE 未配置')
    );
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 8,
      authorBalance: 1.6,
      fishCount: 2,
      fedAmount: 2,
      txCount: 2,
    });
  });

  it('fallback 下投喂者即使没有 fishApiKeyEncrypted 也能投（Key 只在远端模式下要求）', async () => {
    mockEnabled.mockReturnValue(false);
    const { blog, feeder } = await scene({ feederFish: 10, withKey: false });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: feeder.id } })).fishApiKeyEncrypted
    ).toBeNull();
    expect((await feedBlog(blog.id, feeder.id, 1)).ok).toBe(true);
  });
});

describe('★★ fail-closed：远端账户服务失败', () => {
  it('远端抛 AccountServiceError → 本地整体回滚（余额/流水/BlogFeed/fishCount 全无痕迹）', async () => {
    enableRemote();
    mockFeedTransfer.mockRejectedValue(new AccountServiceError('账户服务不可达: timeout', 503));
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });
    const before = await snapshot(feeder.id, author.id, blog.id);

    await expect(
      feedBlog(blog.id, feeder.id, 3),
      '远端失败必须抛出（而非返回 ok:true）'
    ).rejects.toBeInstanceOf(AccountServiceError);

    const after = await snapshot(feeder.id, author.id, blog.id);
    expect(after, '★ 远端没记账、本地却扣了钱 = 最危险的失败模式，必须为零').toEqual(before);
    expect(after).toEqual({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
  });

  it('远端抛出的 AccountServiceError 原样上抛（status 保留，路由据此返回 503）', async () => {
    enableRemote();
    const err = new AccountServiceError('余额不足（远端）', 400);
    mockFeedTransfer.mockRejectedValue(err);
    const { blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await expect(feedBlog(blog.id, feeder.id, 1)).rejects.toBe(err);
  });

  it('远端抛普通 Error（网络异常/TypeError）→ 包装为 AccountServiceError(503)，本地照样回滚', async () => {
    enableRemote();
    mockFeedTransfer.mockRejectedValue(new TypeError('fetch failed'));
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });

    const err = await feedBlog(blog.id, feeder.id, 2).catch((e) => e);

    expect(err, '未预期异常也必须 fail-closed，不能漏成 ok').toBeInstanceOf(AccountServiceError);
    expect((err as AccountServiceError).status, '兜底一律 503').toBe(503);
    expect(await snapshot(feeder.id, author.id, blog.id)).toEqual({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
  });

  it('远端超时（AbortError 形态）同样回滚且不静默成功', async () => {
    enableRemote();
    mockFeedTransfer.mockImplementation(async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    });
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await expect(feedBlog(blog.id, feeder.id, 5)).rejects.toBeInstanceOf(AccountServiceError);
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 10,
      txCount: 0,
      fedAmount: null,
    });
  });

  it('远端启用但投喂者没有账户 Key → 抛 503，且在进入事务前就拒绝（零脏写）', async () => {
    enableRemote();
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: false });

    const err = await feedBlog(blog.id, feeder.id, 2).catch((e) => e);

    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as AccountServiceError).status).toBe(503);
    expect((err as Error).message).toContain('账户 Key');
    expect(mockFeedTransfer, '没 Key 就不该发起远端调用').not.toHaveBeenCalled();
    expect(await snapshot(feeder.id, author.id, blog.id)).toEqual({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
  });

  it('Key 解密失败（密钥轮换/密文损坏）→ 抛 503，本地零变化', async () => {
    mockEnabled.mockReturnValue(true);
    mockDecrypt.mockImplementation(() => {
      throw new AccountServiceError('用户账户 Key 解密失败: bad token', 503);
    });
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await expect(feedBlog(blog.id, feeder.id, 2)).rejects.toBeInstanceOf(AccountServiceError);
    expect(mockFeedTransfer).not.toHaveBeenCalled();
    expect(await snapshot(feeder.id, author.id, blog.id)).toEqual({
      feederBalance: 10,
      authorBalance: 0,
      fishCount: 0,
      fedAmount: null,
      txCount: 0,
    });
  });

  it('远端失败后 BlogFeed 记录压根不该存在 —— 否则用户额度被白白吃掉', async () => {
    enableRemote();
    mockFeedTransfer.mockRejectedValue(new AccountServiceError('down', 503));
    const { blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await feedBlog(blog.id, feeder.id, 5).catch(() => null);

    expect(await getFeedStatus(blog.id, feeder.id), '额度必须原样保留 5').toEqual({
      fed: 0,
      remaining: 5,
      isFull: false,
    });
  });

  it('已有成功投喂后远端再失败：状态停在上一次成功处，不多不少', async () => {
    enableRemote();
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });

    expect((await feedBlog(blog.id, feeder.id, 2)).ok).toBe(true);
    const before = await snapshot(feeder.id, author.id, blog.id);

    mockFeedTransfer.mockRejectedValue(new AccountServiceError('down', 503));
    await feedBlog(blog.id, feeder.id, 3).catch(() => null);

    expect(await snapshot(feeder.id, author.id, blog.id), '第二笔必须完全消失').toEqual(before);
    expect(before).toMatchObject({ feederBalance: 8, authorBalance: 1.6, fedAmount: 2, txCount: 2 });
  });

  it('远端失败 → 重试成功：只记一次账（回滚干净，不会双扣）', async () => {
    enableRemote();
    mockFeedTransfer.mockRejectedValueOnce(new AccountServiceError('transient', 503));
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await feedBlog(blog.id, feeder.id, 3).catch(() => null); // 第一次：远端挂
    const retry = await feedBlog(blog.id, feeder.id, 3); // 第二次：远端恢复

    expect(retry).toMatchObject({ ok: true, fedTotal: 3, remaining: 2 });
    expect(await snapshot(feeder.id, author.id, blog.id), '只能扣一次 3').toEqual({
      feederBalance: 7,
      authorBalance: 2.4,
      fishCount: 3,
      fedAmount: 3,
      txCount: 2,
    });
  });

  it('远端失败时留下可诊断的告警日志（含 user/blog/amount）', async () => {
    enableRemote();
    mockFeedTransfer.mockRejectedValue(new AccountServiceError('down', 503));
    const { blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await feedBlog(blog.id, feeder.id, 2).catch(() => null);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('本地事务已回滚'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(feeder.id));
  });
});

describe('★★ fail-closed：远端成功路径（同步在提交之前发生）', () => {
  it('远端成功 → 本地提交，且传给 feedTransfer 的参数与本地账目一致', async () => {
    enableRemote();
    const { author, blog, feeder } = await scene({ feederFish: 10, withKey: true });

    const r = await feedBlog(blog.id, feeder.id, 3);

    expect(r.ok).toBe(true);
    expect(mockFeedTransfer, '远端必须被调用且仅一次').toHaveBeenCalledTimes(1);
    expect(mockFeedTransfer).toHaveBeenCalledWith({
      feederId: feeder.id,
      feederApiKey: 'decrypted-api-key',
      authorId: author.id,
      amount: 3,
      authorIncome: 2.4, // 与本地作者入账同源，两侧金额必须一致
      blogId: blog.id,
      blogTitle: '测试文章',
      feederName: feeder.username,
      feedSeq: 3,
    });
    expect(await snapshot(feeder.id, author.id, blog.id)).toMatchObject({
      feederBalance: 7,
      authorBalance: 2.4,
      txCount: 2,
    });
  });

  it('feedSeq 传的是「投喂后累计量」而非本次量（幂等键靠它区分第 N 次投喂）', async () => {
    enableRemote();
    const { blog, feeder } = await scene({ feederFish: 10, withKey: true });

    await feedBlog(blog.id, feeder.id, 2);
    await feedBlog(blog.id, feeder.id, 3);

    const seqs = mockFeedTransfer.mock.calls.map((c) => (c[0] as { feedSeq: number }).feedSeq);
    expect(seqs, '2 → 累计 2；再投 3 → 累计 5。若两次都传本次量，幂等键会撞车').toEqual([2, 5]);
  });

  it('★ 远端调用发生在本地提交之前：远端观察到的时刻，本地事务尚未提交', async () => {
    enableRemote();
    const { blog, feeder } = await scene({ feederFish: 10, withKey: true });

    // 在远端回调里用**独立连接**读库：若此时已能读到扣款，说明本地先提交了 —— 顺序错。
    let balanceSeenByRemote: number | null = null;
    mockFeedTransfer.mockImplementation(async () => {
      const u = await prisma.user.findUnique({
        where: { id: feeder.id },
        select: { driedFish: true },
      });
      balanceSeenByRemote = u?.driedFish ?? null;
    });

    await feedBlog(blog.id, feeder.id, 4);

    expect(
      balanceSeenByRemote,
      '远端同步时本地事务必须还未提交（外部连接仍看到旧余额 10）—— 顺序反了就不是 fail-closed'
    ).toBe(10);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: feeder.id } })).driedFish, '提交后才扣').toBe(6);
  });

  it('业务失败（余额不足/超限）不打远端 —— 不浪费远端幂等键，也不产生远端脏账', async () => {
    enableRemote();
    const { blog, feeder } = await scene({ feederFish: 1, withKey: true });

    const r = await feedBlog(blog.id, feeder.id, 5);

    expect(r).toMatchObject({ ok: false, message: '小鱼干不足' });
    expect(mockFeedTransfer, '本地就能判定失败时，不该打远端').not.toHaveBeenCalled();
  });

  it('超限被拒时也不打远端', async () => {
    enableRemote();
    const { blog, feeder } = await scene({ feederFish: 20, withKey: true });
    await feedBlog(blog.id, feeder.id, 5);
    mockFeedTransfer.mockClear();

    const r = await feedBlog(blog.id, feeder.id, 1);

    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(mockFeedTransfer).not.toHaveBeenCalled();
  });
});

// ── 禁言：校验在路由层，服务层不管 ──────────────────────────────────────────

describe('禁言用户', () => {
  it('禁言校验在 route 层（isCurrentlyBanned → 403），feed-service 本身不校验', async () => {
    const author = await makeUser({ driedFish: 0 });
    const blog = await makeBlog({ authorId: author.id });
    const banned = await makeUser({
      driedFish: 10,
      isBanned: true,
      banUntil: new Date(Date.now() + 86400_000),
      banReason: '测试禁言',
    });

    const r = await feedBlog(blog.id, banned.id, 1);

    // 记录现状：服务层放行。拦截点在 src/app/api/blogs/[id]/feed/route.ts:13
    // （getCurrentUser + isCurrentlyBanned → apiErr(403)）。
    expect(r.ok, 'feed-service 不做禁言校验 —— 该职责在路由层，见交付说明').toBe(true);
  });
});
