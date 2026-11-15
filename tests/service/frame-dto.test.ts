// frame-dto.test.ts —— **台账（表驱动，代表面）**：下发给界面的头像框 DTO 要真的带框
//
// ═══════════════════════════════════════════════════════════════════════════════
// 这个文件存在的唯一理由：**漏加字段是不报错的**
// ═══════════════════════════════════════════════════════════════════════════════
// 头像框要显示在多处（落点清单见 tests/unit/avatar-sites-guard.test.ts），而它们的**数据**
// 来自十来个各不相同的 service 函数。任何一个函数忘了把装备两列 select 出来、
// 或者忘了把结果过一遍 frameUrlFor，后果都完全一样：
//
//     那一处**永远没有框**。页面照常渲染、没有日志、没有 500。
//
// 「博客列表有框、讨论里没有」—— 只有人眼逐个页面看才发得现。
// 此前是每一面各写一条；15 条实际在反复验证同一条规则（选两列 → 过 frameUrlFor），
// 因此改成表驱动：只留 6 个形状各异的代表面（列表 / 公开列表 / 评论 / 讨论 / 个人页 / 商城），
// 新增 DTO 面时优先确认它是否已在代码层复用同一个装配函数，再决定是否补一行。
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
import { FRAME_KEYS, frameUrl } from '@/lib/frame-refs';
import { equipFrame, grantFrame, __resetFrameAssetCacheForTests } from '@/lib/frame-service';
import { makeBlog, makeUser, resetDb } from '../helpers/db';
import { makeFishUser } from '../helpers/fish-ledger';
import { listBlogs, listPublicBlogs } from '@/lib/blog-service';
import { listCommentsForBlog, createComment } from '@/lib/comment-service';
import { listMessages, sendMessage } from '@/lib/chat-service';
import { getPublicProfile } from '@/lib/user-service';
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

/**
 * 代表面：每行自己铺夹具并取出那个真正下发给界面的 frameUrl。
 * 一行 = 一个形状不同的出口（列表 / 公开列表 / 评论 / 讨论 / 个人页）。
 */
const frameSurfaces: { name: string; extract: () => Promise<string | null | undefined> }[] = [
  {
    name: 'listBlogs → author.frameUrl',
    extract: async () => {
      const a = await makeFramedUser('blogger');
      await makeBlog({ authorId: a.id, title: 'T' });

      const { blogs } = await listBlogs({});
      // 原始列不跟着出门（渲染层不该有机会绕过判定）
      expect(blogs[0].author).not.toHaveProperty('equippedFrameKey');
      expect(blogs[0].author).not.toHaveProperty('equippedFrameExpiresAt');
      return blogs[0].author.frameUrl;
    },
  },
  {
    name: '★ listPublicBlogs（/explore 与 sitemap 那条）→ author.frameUrl',
    extract: async () => {
      const a = await makeFramedUser('blogger');
      const blog = await makeBlog({ authorId: a.id });
      await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'public' } });

      const { blogs } = await listPublicBlogs({});
      expect(blogs).toHaveLength(1);
      return blogs[0].author?.frameUrl;
    },
  },
  {
    name: 'listCommentsForBlog → author.frame_url',
    extract: async () => {
      const blog = await makeBlog();
      const commenter = await makeFramedUser('commenter');
      const created = await createComment({ blogId: blog.id, authorId: commenter.id, content: '你好' });
      expect(created.ok, '台账前置：发评论失败').toBe(true);

      const nodes = await listCommentsForBlog(blog.id);
      return nodes[0].author.frame_url;
    },
  },
  {
    name: 'listMessages（讨论大区）→ author.frame_url',
    extract: async () => {
      const sender = await makeFramedUser('talker');
      const sent = await sendMessage({ channelId: 'lobby', authorId: sender.id, content: 'hi' });
      expect(sent.ok, '台账前置：发消息失败').toBe(true);

      const res = await listMessages('lobby', sender.id);
      expect(res.ok, '台账前置：拉消息失败').toBe(true);
      if (!res.ok) return undefined;
      return res.messages[0].author.frame_url;
    },
  },
  {
    name: 'getPublicProfile → frameUrl',
    extract: async () => {
      const u = await makeFramedUser('profile');
      const p = await getPublicProfile(u.id, { id: u.id, isCore: true });
      return p?.frameUrl;
    },
  },
];

describe('头像框 DTO 台账（代表面）', () => {
  it.each(frameSurfaces)('$name', async ({ extract }) => {
    expect(await extract()).toBe(EXPECTED);
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
