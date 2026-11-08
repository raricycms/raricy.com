// 收藏夹 API —— route handler 层
//
// 【为什么单独一个文件】这里打的是**真实 route handler**，重点在
//   ① 档位分叉（未登录 401 / 非 core 403）—— 页面挡了 core、接口也必须挡，
//      否则「用不了界面但 curl 得动」；
//   ② spider 出口（需 core+）：私密 / 不存在 / 已软删**同为 404**，不确认存在性
//      —— 但这是在**身份合格之后**才做的区分，档位不足在进业务逻辑前就 401/403 了；
//   ③ 响应头（导出的 Content-Disposition 不能把用户标题直接拼进去）。
// 与 service 层的用例（六条不变量、越权审计）关注点不同，混在一起会互相干扰。
// 业务规则（句柄分配、导入/导出内容、软删过滤、配额、条目幂等）由
// tests/service/favorite-service.test.ts 承担；这里只留 route 独有的状态码映射、
// 档位分叉、请求校验与响应头。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。

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

import { resetDb, makeUser, makeBlog } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { __resetRateLimitStore, rateLimit, RULES } from '@/lib/rate-limit';
import { GET as listApi, POST as createApi } from '@/app/api/favorites/route';
import {
  GET as detailApi,
  PATCH as patchApi,
} from '@/app/api/favorites/[id]/route';
import { POST as addItemApi } from '@/app/api/favorites/[id]/items/route';
import { DELETE as removeItemApi } from '@/app/api/favorites/[id]/items/[blogId]/route';
import { POST as copyApi } from '@/app/api/favorites/[id]/copy/route';
import { GET as exportApi } from '@/app/api/favorites/[id]/export/route';
import { POST as importApi } from '@/app/api/favorites/import/route';
import { GET as spiderApi } from '@/app/api/spider/favorites/[id]/route';
import { GET as posterApi } from '@/app/api/poster/favorite/[id]/route';
import { GET as collectApi } from '@/app/api/poster/collect/route';

function jsonReq(path: string, method: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** Next 15 的 params 是 Promise。 */
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  session.token = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── 档位 ─────────────────────────────────────────────────────────────────────

describe('档位：页面挡 core，接口也必须挡', () => {
  it('未登录 → 401', async () => {
    expect((await listApi(jsonReq('/api/favorites', 'GET'))).status).toBe(401);
    expect((await createApi(jsonReq('/api/favorites', 'POST', { title: 'x', isPublic: false }))).status).toBe(401);
  });

  it('非 core（普通 user 角色）→ 403', async () => {
    const u = await makeUser({ role: 'user' });
    await login(u.id);
    expect((await listApi(jsonReq('/api/favorites', 'GET'))).status).toBe(403);
  });

  it('core → 200', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const res = await listApi(jsonReq('/api/favorites', 'GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe(200);
  });
});

// ── 创建 / 列出 ──────────────────────────────────────────────────────────────

describe('创建', () => {
  it('必须显式指定 isPublic（不给默认值，性质创建后不可改）', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const res = await createApi(jsonReq('/api/favorites', 'POST', { title: '夹' }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('isPublic');
  });

  it('列表带上 item_count 与 contains（选择器一次拿全）', async () => {
    const u = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    await login(u.id);
    const blog = await makeBlog({ authorId: other.id });

    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '夹', isPublic: false }))
    ).json()).favorite;
    await addItemApi(jsonReq(`/api/favorites/${fav.id}/items`, 'POST', { blogId: blog.id }), ctx({ id: fav.id }));

    const listed = await (await listApi(jsonReq(`/api/favorites?blogId=${blog.id}`, 'GET'))).json();
    expect(listed.favorites).toHaveLength(1);
    expect(listed.favorites[0].item_count).toBe(1);
    expect(listed.favorites[0].contains).toBe(true);

    const without = await (await listApi(jsonReq('/api/favorites', 'GET'))).json();
    expect(without.favorites[0].contains).toBeUndefined();
  });
});

// ── 改名不能改性质 ───────────────────────────────────────────────────────────

describe('PATCH：只接受 title', () => {
  it('改名成功', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '旧', isPublic: true }))
    ).json()).favorite;

    const res = await patchApi(jsonReq(`/api/favorites/${fav.id}`, 'PATCH', { title: '新' }), ctx({ id: fav.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.favorite.title).toBe('新');
    expect(body.favorite.public_id).toBe(fav.public_id); // 句柄不因改名而变
  });

  it('★ 想改 isPublic / is_public → 明确报错，而不是静默忽略', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '私', isPublic: false }))
    ).json()).favorite;

    for (const extra of [{ isPublic: true }, { is_public: true }]) {
      const res = await patchApi(
        jsonReq(`/api/favorites/${fav.id}`, 'PATCH', { title: '私', ...extra }),
        ctx({ id: fav.id })
      );
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    // 且真的没被改
    const after = await (await detailApi(jsonReq('', 'GET'), ctx({ id: fav.id }))).json();
    expect(after.favorite.is_public).toBe(false);
    expect(after.favorite.public_id).toBeNull();
    expect(after.favorite.title).toBe('私');
  });

  it('他人改不动 → 404（不是 403，不确认存在性）', async () => {    const owner = await makeUser({ role: 'core' });
    await login(owner.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '夹', isPublic: false }))
    ).json()).favorite;

    const other = await makeUser({ role: 'core' });
    await login(other.id);
    const res = await patchApi(jsonReq('', 'PATCH', { title: '偷改' }), ctx({ id: fav.id }));
    expect(res.status).toBe(404);
  });
});

// ── 条目 ─────────────────────────────────────────────────────────────────────

describe('条目增删', () => {
  it('加入 → 移出：200 且 item_count 如实回落', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const blog = await makeBlog({ authorId: u.id });
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '夹', isPublic: false }))
    ).json()).favorite;

    const add = await addItemApi(
      jsonReq('', 'POST', { blogId: blog.id }),
      ctx({ id: fav.id })
    );
    expect(add.status).toBe(200);

    const rm = await removeItemApi(jsonReq('', 'DELETE'), ctx({ id: fav.id, blogId: blog.id }));
    expect(rm.status).toBe(200);
    expect((await rm.json()).item_count).toBe(0);
  });
});

// ── 复制 ─────────────────────────────────────────────────────────────────────

describe('复制', () => {
  it('用 6 位句柄复制别人的公开收藏夹 → 得到自己的私密副本', async () => {
    const owner = await makeUser({ role: 'core' });
    const copier = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: owner.id, title: '甲' });

    await login(owner.id);
    const pub = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '分享', isPublic: true }))
    ).json()).favorite;
    await addItemApi(jsonReq('', 'POST', { blogId: blog.id }), ctx({ id: pub.id }));

    await login(copier.id);
    const res = await copyApi(
      jsonReq('', 'POST', { isPublic: false }),
      ctx({ id: pub.public_id })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.favorite.is_public).toBe(false);
    expect(body.favorite.public_id).toBeNull();
    expect(body.item_count).toBe(1);
  });

  it('必须显式指定复制成哪种', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '夹', isPublic: false }))
    ).json()).favorite;
    const res = await copyApi(jsonReq('', 'POST', {}), ctx({ id: fav.id }));
    expect(res.status).toBe(400);
  });
});

// ── 导出 ─────────────────────────────────────────────────────────────────────

describe('导出', () => {
  it('是 attachment，且中文标题走 RFC 5987（不直接拼进头）', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '我的 收藏夹', isPublic: false }))
    ).json()).favorite;

    const res = await exportApi(jsonReq('', 'GET'), ctx({ id: fav.id }));
    expect(res.status).toBe(200);
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('filename="favorite.json"'); // ASCII 兜底名不含用户输入
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).not.toContain('我的 收藏夹'); // 原文不出现（已百分号化）
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('★ 标题里的换行注入不了响应头', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const fav = (await (
      await createApi(
        jsonReq('/api/favorites', 'POST', { title: 'x\r\nX-Injected: 1', isPublic: false })
      )
    ).json()).favorite;

    const res = await exportApi(jsonReq('', 'GET'), ctx({ id: fav.id }));
    expect(res.headers.get('X-Injected')).toBeNull();
    expect(res.headers.get('Content-Disposition') ?? '').not.toMatch(/[\r\n]/);
  });
});

// ── 导入 ─────────────────────────────────────────────────────────────────────

describe('导入', () => {
  it('按 body.data 建一个新收藏夹，返回 created / skipped', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const a = await makeBlog({ authorId: u.id });
    const b = await makeBlog({ authorId: u.id });

    const res = await importApi(
      jsonReq('/api/favorites/import', 'POST', {
        isPublic: false,
        data: { version: 1, title: '导进来', blogs: [{ id: a.id }, { id: b.id }, { id: 'nope' }] },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(1);
    expect(body.favorite.public_id).toBeNull();
  });
});

// ── 分享二维码（画报）────────────────────────────────────────────────────────

describe('GET /api/poster/favorite/:publicId', () => {
  const OLD = { SITE_URL: process.env.SITE_URL, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS };
  afterEach(() => {
    process.env.SITE_URL = OLD.SITE_URL;
    process.env.ALLOWED_ORIGINS = OLD.ALLOWED_ORIGINS;
  });

  /** 建一个公开收藏夹，返回它的句柄与所有者 id。 */
  async function seeded() {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '分享', isPublic: true }))
    ).json()).favorite;
    return { userId: u.id, fav };
  }

  it('未登录 → 401；非 core → 403', async () => {
    const { fav } = await seeded();
    session.token = undefined;
    expect((await posterApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }))).status).toBe(401);

    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect((await posterApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }))).status).toBe(403);
  });

  it('★ 拿不到公开句柄就 404 —— 私密收藏夹结构性不可达', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const priv = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '私藏', isPublic: false }))
    ).json()).favorite;
    expect(priv.public_id).toBeNull();

    // 用内部 UUID 与「假句柄」都出不了图
    expect((await posterApi(jsonReq('', 'GET'), ctx({ id: priv.id }))).status).toBe(404);
    expect((await posterApi(jsonReq('', 'GET'), ctx({ id: '000001' }))).status).toBe(404);
  });

  it('SITE_URL 未配置 → 503（绝不生成相对路径的废码）', async () => {
    const { fav, userId } = await seeded();
    process.env.SITE_URL = '';
    process.env.ALLOWED_ORIGINS = '';
    await login(userId);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await posterApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }));
    expect(res.status).toBe(503);
  });

  it('配好 SITE_URL → 200 + image/png，且响应头不写 filename', async () => {
    const { fav, userId } = await seeded();
    process.env.SITE_URL = 'https://raricy.com';
    await login(userId);
    const res = await posterApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    // 只写 inline、不写 filename —— 否则前端 <a download="..."> 会被浏览器无视
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    // 真的出了一张 PNG（魔法字节）
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('限频：按 RULES.posterMinute 计，桶满后 429', async () => {
    const { fav, userId } = await seeded();
    process.env.SITE_URL = 'https://raricy.com';
    await login(userId);
    // 直接按路由使用的同一个桶键填满 —— 每次出 PNG 约 1s，真打 30 次会撞 30s 用例超时。
    // 这里验证的是「路由用的键/额度来自 RULES.posterMinute」，不是 PNG 渲染速度。
    for (let i = 0; i < RULES.posterMinute.limit; i++) {
      rateLimit(`poster:${userId}`, RULES.posterMinute);
    }
    const res = await posterApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }));
    expect(res.status, `桶满（${RULES.posterMinute.limit} 次/分）后必须 429`).toBe(429);
  });

  it('★ 与收款码海报**共桶**：poster:<userId> 满后 collect 也 429', async () => {
    const { userId } = await seeded();
    process.env.SITE_URL = 'https://raricy.com';
    await login(userId);
    // 三条海报路由的桶键都是 `poster:${user.id}`（见各 route.ts）——共桶是刻意的：
    // 它们都在烤 CPU 出 PNG，分开计数等于把配额放大三倍。
    for (let i = 0; i < RULES.posterMinute.limit; i++) {
      rateLimit(`poster:${userId}`, RULES.posterMinute);
    }
    const res = await collectApi();
    expect(res.status, '换一条海报路由不能绕过同一个桶').toBe(429);
  });
});

// ── spider：需 core+ 的机器人读路径 ──────────────────────────────────────────
//
// 这几条曾经是**免认证**的。现在与站点的机器人模型一致：「一个 core+ 账号 + 会话
// cookie」。所以下面每个用例都必须带着会话调，档位断言单独成两条。

describe('GET /api/spider/favorites/:id（需 core+）', () => {
  /** 造一个公开收藏夹（带一篇博客），返回句柄与所有者 id。**保持 core 会话**。 */
  async function seededPublic() {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: '甲文' });
    await login(u.id);
    const fav = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '分享', isPublic: true }))
    ).json()).favorite;
    await addItemApi(jsonReq('', 'POST', { blogId: blog.id }), ctx({ id: fav.id }));
    return { userId: u.id, blog, fav };
  }

  it('未登录 → 401（这条不再是免认证接口）', async () => {
    const { fav } = await seededPublic();
    session.token = undefined;
    expect((await spiderApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }))).status).toBe(401);
  });

  it('非 core → 403', async () => {
    const { fav } = await seededPublic();
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect((await spiderApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }))).status).toBe(403);
  });

  it('core 可读，返回裸 JSON（无 { code, message } 信封）', async () => {
    const { fav } = await seededPublic();
    const res = await spiderApi(jsonReq('', 'GET'), ctx({ id: fav.public_id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 成功路径不套信封是 spider 命名空间的既有口径，别因为加了鉴权就顺手改掉
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
    expect(body.id).toBe(fav.public_id);
    expect(body.title).toBe('分享');
    expect(body.count).toBe(1);
    expect(body.blogs).toEqual([{ id: expect.any(String), title: '甲文' }]);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('★ 私密收藏夹不可达：它没有句柄，用任何 6 位串都是 404', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const priv = (await (
      await createApi(jsonReq('/api/favorites', 'POST', { title: '私藏', isPublic: false }))
    ).json()).favorite;
    expect(priv.public_id).toBeNull();

    // 拿内部 UUID 的前 6 位当真句柄去试（最接近「猜到」的情形）。
    // 注意与上面的 401/403 是**不同档位**：身份已合格，此时才谈「存在但不可见」。
    const res = await spiderApi(jsonReq('', 'GET'), ctx({ id: priv.id.slice(0, 6) }));
    expect(res.status).toBe(404);
  });

  it('不存在 / 形态不对（非 6 位数字）→ 404', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    for (const bad of ['000001', 'abcdef', '12345', '1234567', 'has-dash']) {
      const res = await spiderApi(jsonReq('', 'GET'), ctx({ id: bad }));
      expect(res.status, `应 404：${bad}`).toBe(404);
    }
  });

  it('限频：超过 120 次/分被拒（鉴权不替代限频）', async () => {
    const { fav } = await seededPublic();
    let limited = false;
    for (let i = 0; i < RULES.spiderFavoritePerIp.limit + 2; i++) {
      const res = await spiderApi(
        new Request('http://localhost/api/spider/favorites/x', {
          headers: { 'x-real-ip': '203.0.113.9' },
        }),
        ctx({ id: fav.public_id })
      );
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
