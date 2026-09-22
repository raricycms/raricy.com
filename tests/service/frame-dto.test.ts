// frame-dto.test.ts —— **台账**：每一个下发给界面的 DTO 面，都要带上头像框
//
// ═══════════════════════════════════════════════════════════════════════════════
// 这个文件存在的唯一理由：**漏加字段是不报错的**
// ═══════════════════════════════════════════════════════════════════════════════
// 头像框要显示在 15 处（落点清单见 docs/frontend-styles.md §4.1），而它们的**数据**
// 来自十来个各不相同的 service 函数。任何一个函数忘了把装备两列 select 出来、
// 或者忘了把结果过一遍 frameUrlFor，后果都完全一样：
//
//     那一处**永远没有框**。页面照常渲染、没有日志、没有 500。
//
// 「博客列表有框、讨论里没有」—— 只有人眼逐个页面看才发得现。所以这里把每一个
// 面都钉一条：造一个**真戴着框**的用户，走完那条 service 函数，断言框真的到了。
//
// ⚠️ 它是**台账，不是证明器**：新增一个会显示头像的 DTO 面时，这里要添一行。
//    更硬的那道是 tests/unit/avatar-sites-guard.test.ts（按渲染落点反向对账），
//    但那条拦不住「DTO 有字段、渲染时没传 prop」—— 那种只有 e2e 能抓。
//
// 【为什么这一条比「字段存在」更强】断言的是 `frameUrl === '/api/frames/<key>'`，
// 即整条链**从头到尾**都对：装备真的写进了 users、判定真的通过了（没被当成过期）、
// 素材真的被认为在盘上、URL 真的按 frame-refs 的唯一口径拼出来。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const TEST_FRAMES_DIR = path.resolve(import.meta.dirname, '../.tmp/frames-dto-test');
process.env.FRAMES_DIR = TEST_FRAMES_DIR;

import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { FRAME_KEYS, frameUrl } from '@/lib/frame-refs';
import { equipFrame, grantFrame, __resetFrameAssetCacheForTests } from '@/lib/frame-service';
import { makeBlog, makeUser, resetDb } from '../helpers/db';
import { makeFishUser } from '../helpers/fish-ledger';
import { listBlogs, getBlogDetail, listPublicBlogs, getLikers } from '@/lib/blog-service';
import { getFeeders } from '@/lib/feed-service';
import { listCommentsForBlog, createComment } from '@/lib/comment-service';
import { listMessages, searchCoreUsers, listChannelsForUser, sendMessage } from '@/lib/chat-service';
import { getCountLeaderboard } from '@/lib/checkin-service';
import { getPublicProfile } from '@/lib/user-service';
import { listUsers } from '@/lib/admin-user-service';
import { searchTransferTargets, findTransferTargetByUsername } from '@/lib/fish-market-service';
import { listShopItems } from '@/lib/frame-shop-service';
import { rentableFrameKeys } from '@/lib/frame-refs';

const KEY = FRAME_KEYS[0];
const EXPECTED = frameUrl(KEY);

/** 最小合法 PNG 头（扫盘只认文件名，字节是路由的事）。 */
const PNG_HEAD = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);

function assertTempDir() {
  if (!TEST_FRAMES_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑头像框用例：${TEST_FRAMES_DIR}`);
  }
}

/** 造一个「真的戴着框」的用户：授权 → 装备，走服务层（不直接写库）。 */
async function makeFramedUser(username: string) {
  const u = await makeUser({ username, role: 'core' });
  const granted = await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
  expect(granted.ok, '台账前置：授权失败').toBe(true);
  const equipped = await equipFrame(u.id, KEY);
  expect(equipped.ok, '台账前置：装备失败').toBe(true);
  return u;
}

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
  __resetFrameAssetCacheForTests();
});

// ── 博客侧 ──────────────────────────────────────────────────────────────────

describe('博客侧', () => {
  it('listBlogs → author.frameUrl', async () => {
    const a = await makeFramedUser('blogger');
    await makeBlog({ authorId: a.id, title: 'T' });

    const { blogs } = await listBlogs({});
    expect(blogs[0].author.frameUrl).toBe(EXPECTED); // listBlogs 的 author 是必选关系，非空
    // 原始列不跟着出门（渲染层不该有机会绕过判定）
    expect(blogs[0].author).not.toHaveProperty('equippedFrameKey');
    expect(blogs[0].author).not.toHaveProperty('equippedFrameExpiresAt');
  });

  it('getBlogDetail → author.frameUrl', async () => {
    const a = await makeFramedUser('blogger');
    const blog = await makeBlog({ authorId: a.id });

    const detail = await getBlogDetail(blog.id, { id: a.id, isCore: true });
    expect(detail?.author.frameUrl).toBe(EXPECTED);
    expect(detail?.author).not.toHaveProperty('equippedFrameKey');
  });

  it('★ listPublicBlogs（/explore 与 sitemap 那条）→ author.frameUrl', async () => {
    const a = await makeFramedUser('blogger');
    const blog = await makeBlog({ authorId: a.id });
    await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'public' } });

    const { blogs } = await listPublicBlogs({});
    expect(blogs).toHaveLength(1);
    expect(blogs[0].author?.frameUrl).toBe(EXPECTED);
  });

  it('getLikers → frame_url', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    const liker = await makeFramedUser('liker');
    await prisma.blogLike.create({
      data: { blogId: blog.id, userId: liker.id, createdAt: nowForDb() },
    });

    const r = await getLikers(blog.id);
    expect(r!.users[0].frame_url).toBe(EXPECTED);
  });

  it('getFeeders → frame_url', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    const feeder = await makeFramedUser('feeder');
    await prisma.blogFeed.create({
      data: { blogId: blog.id, userId: feeder.id, amount: 20, createdAt: nowForDb() },
    });

    const r = await getFeeders(blog.id);
    expect(r.feeders[0].frame_url).toBe(EXPECTED);
  });
});

// ── 评论与讨论 ──────────────────────────────────────────────────────────────

describe('评论与讨论', () => {
  it('listCommentsForBlog → author.frame_url', async () => {
    const blog = await makeBlog();
    const commenter = await makeFramedUser('commenter');
    const created = await createComment({ blogId: blog.id, authorId: commenter.id, content: '你好' });
    expect(created.ok, '台账前置：发评论失败').toBe(true);

    const nodes = await listCommentsForBlog(blog.id);
    expect(nodes[0].author.frame_url).toBe(EXPECTED);
  });

  it('listMessages（讨论大区）→ author.frame_url', async () => {
    const sender = await makeFramedUser('talker');
    const sent = await sendMessage({ channelId: 'lobby', authorId: sender.id, content: 'hi' });
    expect(sent.ok, '台账前置：发消息失败').toBe(true);

    const res = await listMessages('lobby', sender.id);
    expect(res.ok, '台账前置：拉消息失败').toBe(true);
    if (!res.ok) return;
    expect(res.messages[0].author.frame_url).toBe(EXPECTED);
  });
});

// ── 个人页 / 排行榜 / 后台 ──────────────────────────────────────────────────

describe('个人页 / 排行榜 / 后台', () => {
  it('getPublicProfile → frameUrl', async () => {
    const u = await makeFramedUser('profile');
    const p = await getPublicProfile(u.id, { id: u.id, isCore: true });
    expect(p?.frameUrl).toBe(EXPECTED);
  });

  it('getCountLeaderboard（签到榜）→ frameUrl', async () => {
    const u = await makeFramedUser('checkin');
    // checkinDate 是 DATETIME 列（不是文本），与生产写路径同钟
    await prisma.dailyCheckIn.create({
      data: {
        userId: u.id,
        checkinDate: new Date('2026-09-01T00:00:00.000Z'),
        fortuneValue: 3,
        fortunePool: '3,1,5,2,4',
        createdAt: nowForDb(),
      },
    });

    const lb = await getCountLeaderboard();
    expect(lb[0].frameUrl).toBe(EXPECTED);
  });

  it('listUsers（后台用户卡片）→ frameUrl', async () => {
    const u = await makeFramedUser('adminview');
    const { users } = await listUsers({ search: u.username });
    expect(users[0].frameUrl).toBe(EXPECTED);
  });
});

// ── 私聊与会话侧栏 ──────────────────────────────────────────────────────────

describe('私聊与会话侧栏', () => {
  it('searchCoreUsers（发起私聊的搜索）→ frame_url', async () => {
    const me = await makeUser({ role: 'core' });
    await makeFramedUser('findme');

    const { users } = await searchCoreUsers('findme', me.id);
    expect(users[0].frame_url).toBe(EXPECTED);
  });

  it('listChannelsForUser → peer.frame_url（侧栏与私聊标题栏共用）', async () => {
    const me = await makeUser({ role: 'core' });
    const peer = await makeFramedUser('peer');
    // 显式建一个私聊频道：两人各一条成员行
    await prisma.chatChannel.create({
      data: { id: 'ch-frame-test', kind: 'direct', createdAt: nowForDb() },
    });
    await prisma.chatMember.createMany({
      data: [
        { channelId: 'ch-frame-test', userId: me.id, lastReadMessageId: 0, createdAt: nowForDb() },
        { channelId: 'ch-frame-test', userId: peer.id, lastReadMessageId: 0, createdAt: nowForDb() },
      ],
    });

    // 空会话默认**不进**侧栏（侧栏不该列一条没说过话的私聊）—— 发起方要立刻看到它，
    // 所以显式带上这个 id。这也说明下面那条断言测的正是「侧栏渲染的那条路」。
    const channels = await listChannelsForUser(me.id, false, {
      includeEmptyChannelId: 'ch-frame-test',
    });
    const direct = channels.find((c) => c.id === 'ch-frame-test');
    expect(direct?.peer?.frame_url).toBe(EXPECTED);
  });
});

// ── 鱼干转账 ────────────────────────────────────────────────────────────────

describe('鱼干转账', () => {
  it('searchTransferTargets → frame_url', async () => {
    const me = await makeUser();
    await makeFramedUser('payee');

    const { users } = await searchTransferTargets('payee', me.id);
    expect(users[0].frame_url).toBe(EXPECTED);
  });

  it('findTransferTargetByUsername → frame_url', async () => {
    const u = await makeFramedUser('exactname');
    expect((await findTransferTargetByUsername('exactname'))?.frame_url).toBe(EXPECTED);
    expect(await findTransferTargetByUsername('nobody')).toBeNull();
  });
});

// ── 鱼干商城的预览 ──────────────────────────────────────────────────────────

describe('鱼干商城', () => {
  it('listShopItems → 面板拿得到渲染预览所需的一切（key + assetMissing）', async () => {
    // ⚠️ 这一条与上面那些**形状不同**：商城的预览画的是**商品**的框，不是
    // 「这个用户的框」—— 面板把商品图直接叠在访问者自己的头像上，所以这一面
    // 不带 `frame_url`，带的是 `key`（由 `frameUrl(key)` 拼出预览地址）。
    // 台账真正要保的不变量还是那一件事：**那一处的框显示得出来**。
    // 在售的那款框 —— 与上面那些用例用的 KEY（FRAME_KEYS[0]）不是同一个，
    // 所以素材要单独铺一份
    const shopKey = rentableFrameKeys()[0];
    const shopAsset = path.join(TEST_FRAMES_DIR, `${shopKey}.png`);
    fs.writeFileSync(shopAsset, PNG_HEAD);
    __resetFrameAssetCacheForTests();

    const buyer = await makeFishUser(10);

    const [item] = await listShopItems(buyer.id);
    expect(item.key).toBe(shopKey);
    // 素材在盘上 → 面板显示预览而不是「素材缺失」；拼出来的地址要是真能取图的那个路由
    expect(item.assetMissing).toBe(false);
    expect(frameUrl(shopKey)).toBe(`/api/frames/${shopKey}`);

    // 同一条路的另一半：素材缺失时面板退回**不显示预览**（而不是画一张裂图，
    // 更不是照卖 —— 服务层那侧会直接 409 拒卖）
    fs.rmSync(shopAsset);
    __resetFrameAssetCacheForTests();
    const [missing] = await listShopItems(buyer.id);
    expect(missing.assetMissing).toBe(true);

    // 还原，免得污染后面可能新增的用例
    fs.writeFileSync(shopAsset, PNG_HEAD);
    __resetFrameAssetCacheForTests();
  });
});
