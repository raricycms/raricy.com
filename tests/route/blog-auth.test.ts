// 博客 / 评论 / 表情这一域的档位 —— route handler 层
//
// 【为什么单独一个文件】这一域共 15 个 handler：14 个是 core+ 档，1 个**刻意匿名**
// （`/api/stickers/:collection/:name` 的字节路由，理由见该文件头）。但这 14 条里，
// 此前**只有 1 条**被档位用例钉过（GET 评论树，在 tests/route/spider-auth.test.ts）。
// 也就是说：把剩下 13 条里的任何一条守卫删掉，现有测试都不会变红 —— 而这一域恰恰是
// 上一轮真的出过事的地方（7 条漏网：评论发表/点赞/删评论、表情清单、点赞与投喂名单、
// 文章的 PUT/DELETE 都曾只判登录）。本文件把它们逐条钉住。
//
// 【为什么赶在第 1 期之前写】第 1 期要往这一域加「公开文章」的对外读口，届时这一域
// 就从「一律 core+」变成「有刻意的公开例外」。趁现在口径均匀，断言最简单；等公开
// 上线再补，同一条断言就得处理「匿名读这篇 200、读那篇 401」，不是一个量级。
//
// 【判据为什么看 message 而不只看 status】归属与栏目这些业务分支自己也会回 403
// （'无权查看' / '无权编辑该文章' / '该栏目仅允许管理员发布文章'），与「档位不够」
// 是两回事。所以：
//   · 拒绝路径断言 status **且** message 恰是档位那几条文案；
//   · 放行路径断言它**不是**档位拒绝 —— 而不是断言 200，否则业务侧的 404/403
//     会把「档位已放行」误判成失败，测试就变成了「顺带测业务」，脆且跑偏。
//
// 【与 tests/route/chat-auth.test.ts 的一处差别】讨论那边档位收在一个 helper
// （`requireChatUser`）里，连禁言都是它发的，所以那份的 GUARD_MESSAGES 含禁言文案。
// 这一域没有 helper，档位是各 route 内联的；而禁言是**档位之后的另一道闸** ——
// 核心用户撞上禁言，说明档位**已经过了**，所以禁言文案不算档位拒绝。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。用例一律用不存在的 id：拒绝方向上守卫跑在
// 一切之前，id 无所谓；放行方向要的也只是「过了档位」这一件事，落进业务后的 404
// 正合适 —— 那恰好证明它没被挡在档位上。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import fs from 'node:fs';
import path from 'node:path';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { BLOG_VISIBILITIES } from '@/lib/blog-service';
import { GET as blogOgImage } from '@/app/api/og/blog/[id]/route';

import { GET as listBlogs, POST as createBlog } from '@/app/api/blogs/route';
import {
  GET as getBlog,
  PUT as updateBlog,
  PATCH as patchBlogVisibility,
  DELETE as deleteBlog,
} from '@/app/api/blogs/[id]/route';
import {
  GET as listComments,
  POST as postComment,
} from '@/app/api/blogs/[id]/comments/route';
import { POST as toggleLike } from '@/app/api/blogs/[id]/like/route';
import { GET as listLikers } from '@/app/api/blogs/[id]/likers/route';
import { POST as feedBlog } from '@/app/api/blogs/[id]/feed/route';
import { GET as listFeeders } from '@/app/api/blogs/[id]/feeders/route';
import { POST as toggleCommentLike } from '@/app/api/comments/[id]/like/route';
import { DELETE as deleteComment } from '@/app/api/comments/[id]/route';
import { GET as listStickers } from '@/app/api/stickers/route';
import { GET as stickerBytes } from '@/app/api/stickers/[collection]/[name]/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const stickerCtx = (collection: string, name: string) => ({
  params: Promise.resolve({ collection, name }),
});

/**
 * 档位守卫的拒绝文案（这一域内联在各 route 里）—— 一字不差地钉住。
 *
 * 前两条是大多数 handler 用的；`POST /api/blogs` 的档位文案是第三条（它历史更久，
 * 改它没有收益，只会动对外契约）。**禁言的文案不在这个集合里** —— 见文件头。
 */
const GUARD_MESSAGES = ['请先登录', '需要核心用户权限', '只有核心用户才能发布文章'];

/** 递归找出所有 route.ts（用于「清单完整性」那条自检）。 */
function findRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** 这一域的目录（与下面「清单完整性」自检的扫描范围必须一致）。 */
const DOMAIN_DIRS = ['blogs', 'comments', 'stickers'];

const url = (p: string) => new Request(`http://localhost${p}`);
const withBody = (method: string) => (p: string, body: unknown = {}) =>
  new Request(`http://localhost${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const post = withBody('POST');
const put = withBody('PUT');
const patch = withBody('PATCH');
const del = (p: string) => new Request(`http://localhost${p}`, { method: 'DELETE' });

/** 该响应是不是「被档位守卫挡住」的那个（而不是业务逻辑自己的 401/403）。 */
async function isGuardRejection(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return GUARD_MESSAGES.includes(body?.message ?? '');
}

// 一律用不存在的 id —— 见文件头【DB】那段：拒绝方向上守卫跑在一切之前，
// 放行方向要的只是「过了档位」，业务回 404 恰好证明了这一点。
const BLOG_ID = 'no-such-blog';
const COMMENT_ID = 'no-such-comment';

/**
 * 15 个 core+ handler。刻意匿名的那个（表情字节）**不在这里** —— 它的方向相反，
 * 单列在下面。
 *
 * 没有 `canProbeAllow: false` 的条目：这一域没有 SSE 那种一放行就挂住的路由，
 * 三连（匿名 / 非 core / core 放行）全都跑得完。
 */
const cases: { name: string; call: () => Promise<Response> }[] = [
  { name: 'GET    /api/blogs', call: () => listBlogs(url('/api/blogs')) },
  { name: 'POST   /api/blogs', call: () => createBlog(post('/api/blogs', {})) },
  { name: 'GET    /api/blogs/:id', call: () => getBlog(url('/x'), ctx(BLOG_ID)) },
  { name: 'PUT    /api/blogs/:id', call: () => updateBlog(put('/x', {}), ctx(BLOG_ID)) },
  {
    name: 'PATCH  /api/blogs/:id (可见性)',
    call: () => patchBlogVisibility(patch('/x', { visibility: 'public' }), ctx(BLOG_ID)),
  },
  { name: 'DELETE /api/blogs/:id', call: () => deleteBlog(del('/x'), ctx(BLOG_ID)) },
  { name: 'GET    /api/blogs/:id/comments', call: () => listComments(url('/x'), ctx(BLOG_ID)) },
  {
    name: 'POST   /api/blogs/:id/comments',
    call: () => postComment(post('/x', { content: 'x' }), ctx(BLOG_ID)),
  },
  { name: 'POST   /api/blogs/:id/like', call: () => toggleLike(post('/x'), ctx(BLOG_ID)) },
  { name: 'GET    /api/blogs/:id/likers', call: () => listLikers(url('/x'), ctx(BLOG_ID)) },
  { name: 'POST   /api/blogs/:id/feed', call: () => feedBlog(post('/x', { amount: 1 }), ctx(BLOG_ID)) },
  { name: 'GET    /api/blogs/:id/feeders', call: () => listFeeders(url('/x'), ctx(BLOG_ID)) },
  { name: 'POST   /api/comments/:id/like', call: () => toggleCommentLike(post('/x'), ctx(COMMENT_ID)) },
  { name: 'DELETE /api/comments/:id', call: () => deleteComment(del('/x'), ctx(COMMENT_ID)) },
  { name: 'GET    /api/stickers', call: () => listStickers() },
];

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('博客 / 评论 / 表情的档位（15 个 core+ handler）', () => {
  it('清单要盖住这一域的**全部** handler（漏一条 = 漏一个免检的口子）', async () => {
    // 真的去扫盘，不是断言我自己写的数组长度 —— 新增一条本域路由而忘了补进 cases 时，
    // 它必须变红。否则那条路由在「有没有测试保护」这件事上是隐形的。
    const root = path.resolve(import.meta.dirname, '../../src/app/api');
    let count = 0;
    for (const d of DOMAIN_DIRS) {
      for (const f of findRouteFiles(path.join(root, d))) {
        const src = fs.readFileSync(f, 'utf8');
        count += (
          src.match(/\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []
        ).length;
      }
    }
    // +1 = 刻意匿名的表情字节路由（下面单列的那条）
    expect(
      count,
      `${DOMAIN_DIRS.join('/')} 下的 handler 数与 cases 对不上，新路由要补进本文件`
    ).toBe(cases.length + 1);
  });

  for (const c of cases) {
    it(`${c.name}：匿名 → 被守卫挡下`, async () => {
      const res = await c.call();
      expect(res.status, '匿名必须 401').toBe(401);
      expect(await isGuardRejection(res), '且要是档位那条文案，不是业务逻辑凑巧的 401').toBe(true);
    });

    it(`${c.name}：非 core → 被守卫挡下`, async () => {
      const plain = await makeUser({ role: 'user' });
      await login(plain.id);
      const res = await c.call();
      expect(res.status, '非 core 必须 403').toBe(403);
      expect(await isGuardRejection(res), '且要是档位那条文案').toBe(true);
    });

    it(`${c.name}：core → 过档位`, async () => {
      const core = await makeUser({ role: 'core' });
      await login(core.id);
      const res = await c.call();
      expect(await isGuardRejection(res), 'core 不该被档位挡住').toBe(false);
    });
  }
});

// ── 本域之外、但同属博客的对外读口 ────────────────────────────────────────────
//
// 【为什么不放进上面的 DOMAIN_DIRS】「每篇可选对外公开」带来的匿名读口是
// `GET /api/og/blog/:id`（社交卡片 PNG），它在 `src/app/api/og/` 下。上面那 14 条是
// **一律 core+**，混进一条方向相反的会让那组三连断言失去意义 —— 所以它单列在这里。
// 这也正是 OG 路由**刻意不放在** `/api/blogs/[id]/og/` 的原因。
//
// 【它的判据与别处不同】没有会话档位，只有 **per-object 可见性**：任何人可请求，
// 但只对 link / public 的文章返回 200。而「不存在」「已软删」「private」三者
// **必须完全同形**（404 且响应体逐字相同）—— 差一个字就是个存在性探针：
// 拿一批 id 挨个试，能筛出哪些是真实文章。

/** 造一篇指定可见性的文章。 */
async function seedBlogWith(visibility: string | null, ignore = false): Promise<string> {
  const author = await makeUser({ role: 'core' });
  const b = await makeBlog({ authorId: author.id, title: 'OG 卡片标题' });
  await prisma.blog.update({
    where: { id: b.id },
    data: { ...(visibility ? { visibility } : {}), ignore },
  });
  return b.id;
}

describe('对外读口：GET /api/og/blog/:id（分享卡片）', () => {
  it('public：匿名 200，是 PNG，且 X-Robots-Tag 为 all、可缓存', async () => {
    const id = await seedBlogWith('public');
    const res = await blogOgImage(url('/x'), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-robots-tag'), 'public 档的卡片可索引').toBe('all');
    expect(res.headers.get('cache-control'), 'OG 图要可缓存（与画报的 no-store 相反）').toContain(
      'public'
    );
    // 真的渲染出了一张图（不是空 body）
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('link：匿名 200，但 X-Robots-Tag 为 noindex（读得到 ≠ 该被索引）', async () => {
    const id = await seedBlogWith('link');
    const res = await blogOgImage(url('/x'), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag'), 'link 档的卡片不许被索引').toBe('noindex');
  });

  it('private / 软删 / 不存在：三者 404 且响应体**逐字相同**（不确认存在性）', async () => {
    const priv = await seedBlogWith('private');
    const gone = await seedBlogWith('public', true);

    const res = await Promise.all(
      [priv, gone, 'no-such-blog-id'].map((id) => blogOgImage(url('/x'), ctx(id)))
    );
    for (const r of res) {
      expect(r.status).toBe(404);
      expect(r.headers.get('cache-control'), '404 不该被缓存').toBe('no-store');
    }
    const bodies = await Promise.all(res.map((r) => r.text()));
    expect(bodies[1], '「已软删」与「不存在」必须同形').toBe(bodies[2]);
    expect(bodies[0], '「private」与「不存在」必须同形').toBe(bodies[2]);
    expect(bodies[0], '不确认存在性：响应里不该带标题').not.toContain('OG 卡片标题');
  });

  it('三档走同一个出口取数 —— 少一档都不会有人发现，所以三档都要点名', async () => {
    // 这条不是重复劳动：它把「判定走的是 EXTERNAL_VISIBILITIES 白名单」这件事
    // 摊在三档上。加第四档时，若有人忘了决定它算不算对外可见，这里会逼他想一次。
    for (const v of BLOG_VISIBILITIES) {
      const id = await seedBlogWith(v);
      const res = await blogOgImage(url('/x'), ctx(id));
      const shouldRead = v === 'link' || v === 'public';
      expect(res.status, `${v} 档应${shouldRead ? '' : '不'}可读`).toBe(shouldRead ? 200 : 404);
    }
  });
});

describe('PATCH /api/blogs/:id —— 可见性只能由**作者本人**改', () => {
  // 上面那张 cases 表钉的是「谁能进这个 handler」（档位）。这一组钉的是**进了之后
  // 能动谁的文章**（归属）—— 两层不是一回事，见 src/lib/blog-service.ts 的
  // 「档位 vs 归属是两层」。
  const patchVis = (id: string, visibility: unknown) =>
    patchBlogVisibility(patch('/x', { visibility }), ctx(id));

  it('★ 管理员也不是例外：改别人的文章一律 403，且库里**真的没变**', async () => {
    // 这条钉的是一条边界，不是权限阶梯。让管理员能把**别人的**私密文章推成对外公开，
    // 是个独立的隐私决定（与「评论者没同意就不公开评论」同类），不该顺手实现 ——
    // 一旦放开，被公开的人不会收到任何通知，而公开是不可逆的。
    const author = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });
    const b = await makeBlog({ authorId: author.id });

    await login(admin.id);
    const res = await patchVis(b.id, 'public');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe('无权编辑该文章');

    // 只看状态码不够：万一守卫在写库**之后**才返回 403 呢？
    const row = await prisma.blog.findUnique({
      where: { id: b.id },
      select: { visibility: true },
    });
    expect(row?.visibility, '403 之后库里不许有任何变化').toBe('private');
  });

  it('作者本人可以改，回显新档位与 changed', async () => {
    const author = await makeUser({ role: 'core' });
    const b = await makeBlog({ authorId: author.id });
    await login(author.id);

    const res = await patchVis(b.id, 'public');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { visibility: string; changed: boolean };
    expect(body.visibility).toBe('public');
    expect(body.changed).toBe(true);
  });

  it('本来就那一档 → changed=false（幂等不是错误）', async () => {
    const author = await makeUser({ role: 'core' });
    const b = await makeBlog({ authorId: author.id }); // 默认 private
    await login(author.id);
    const res = await patchVis(b.id, 'private');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
  });

  it('非法档位 → 400，且**库里不变**（尤其不能被静默打回 private）', async () => {
    // 把 link 先立在那儿，再看这四次非法请求会不会把它冲掉 —— 若实现走了
    // parseVisibility 的「空串/缺省 → private」那条路，`''` 这一发就会让一篇
    // 凭链接可读的文章从站外消失。
    const author = await makeUser({ role: 'core' });
    const b = await makeBlog({ authorId: author.id });
    await prisma.blog.update({ where: { id: b.id }, data: { visibility: 'link' } });
    await login(author.id);

    for (const bad of ['pulbic', '', 'PUBLIC', 3, null]) {
      const res = await patchVis(b.id, bad);
      expect(res.status, `${JSON.stringify(bad)} 应 400`).toBe(400);
    }

    const row = await prisma.blog.findUnique({
      where: { id: b.id },
      select: { visibility: true },
    });
    expect(row?.visibility, '五次非法请求要全部落空').toBe('link');
  });

  it('键集封闭：多传别的字段 → 400，且那个字段一个字都不生效', async () => {
    // 报错而不是忽略：忽略的话调用方会以为「我传了 title，它一定改了吧」。
    const author = await makeUser({ role: 'core' });
    const b = await makeBlog({ authorId: author.id, title: '原标题' });
    await login(author.id);

    const res = await patchBlogVisibility(
      patch('/x', { visibility: 'public', title: '偷改的标题' }),
      ctx(b.id)
    );
    expect(res.status).toBe(400);

    const row = await prisma.blog.findUnique({
      where: { id: b.id },
      select: { title: true, visibility: true },
    });
    expect(row?.visibility).toBe('private');
    expect(row?.title, '多传的键不许生效').toBe('原标题');
  });

  it('改可见性**不碰**正文的 updatedAt —— 不该在「按更新时间」的列表里凭空跳位', async () => {
    const author = await makeUser({ role: 'core' });
    const before = new Date('2026-01-02T03:04:05.000Z');
    const b = await makeBlog({ authorId: author.id, contentUpdatedAt: before });
    await login(author.id);

    await patchVis(b.id, 'public');

    const c = await prisma.blogContent.findUnique({
      where: { blogId: b.id },
      select: { updatedAt: true },
    });
    expect(c?.updatedAt?.toISOString(), '分开了就是分开了').toBe(before.toISOString());
  });

  it('软删的文章：404（与 PUT 同口径，不确认存在性）', async () => {
    const author = await makeUser({ role: 'core' });
    const b = await makeBlog({ authorId: author.id, ignore: true });
    await login(author.id);
    expect((await patchVis(b.id, 'public')).status).toBe(404);
  });
});

// ── 这一域唯一的刻意例外 ──────────────────────────────────────────────────────
//
// 方向与上面那批**相反**：它要断言的是「匿名**不该**被挡」。这条断言不是凑数的 ——
// 它挡的是「顺手给表情字节加个登录校验」这种看起来天经地义的改动。表情素材是站点
// 素材、不属于任何账号、对所有人的答案都一样，压根没有「档位」可言；真正的访问控制
// 在别处（隐藏合集由 resolveSticker 拦 404，不是权限）。
// 台账见 tests/unit/anonymous-read-guard.test.ts。
describe('刻意匿名的读口（本域唯一一条）', () => {
  it('GET /api/stickers/:collection/:name：匿名不该被档位挡住', async () => {
    const res = await stickerBytes(url('/x'), stickerCtx('no-such', 'no-such.png'));
    expect(
      await isGuardRejection(res),
      '表情字节无档位可言，别顺手给它加登录校验（要加请先改 anonymous-read-guard 的台账）'
    ).toBe(false);
  });
});
