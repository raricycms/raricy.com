// /api/blogs 的 search_fields —— route handler 层
//
// 【为什么单独一个文件】这里打的是**真实 route handler**，重点在 service 层测不到的三件事：
//   ① 档位。本路由**整体**是 core+（与 `/blog` 页面同档 —— 见 `docs/architecture.md` §8
//      「档位阶梯：页面与接口必须同档，每层都自己判」）。它此前完全免认证，匿名拉一次
//      就能拿到全站文章的标题、简介、
//      作者名、栏目与计数。档位判定必须在**解析任何参数之前**：先按参数分叉再判档位，等于
//      匿名调用方可以从 400 与 401 的差别里读出「哪些字段名是认识的」。
//   ② search_fields 白名单。未知字段名要 400，不能静默丢弃 —— 调用方把 titel 拼错
//      却拿到一份「看着正常、其实搜的是别的字段」的结果，是最难查的那类问题。
//   ③ 向后兼容。不传 search_fields 时行为必须与改动前逐字一致（引用弹窗走的就是这条）。
// 与 service 层的用例（字段组合、片段、默认值契约）关注点不同，混在一起会互相干扰。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { __resetRateLimitStore, RULES } from '@/lib/rate-limit';
import { GET as blogsApi } from '@/app/api/blogs/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** 建一个 core 账号并登录 —— 本路由的**所有**成功路径都要先过它。 */
const loginCore = async () => {
  const u = await makeUser({ role: 'core' });
  await login(u.id);
  return u;
};

const get = (qs: string) => blogsApi(new Request(`http://localhost/api/blogs${qs}`));

beforeEach(async () => {
  await resetDb();
  // 限频桶是进程内的，不重置会跨用例累积（本文件末尾那条会把额度打满）。
  __resetRateLimitStore();
  session.token = undefined;
});

describe('GET /api/blogs — 档位', () => {
  it('匿名 → 401（任何参数组合都一样，不给「哪个字段认识」的探针）', async () => {
    expect((await get('?search=x')).status).toBe(401);
    expect((await get('?search=x&search_fields=content')).status).toBe(401);
    // 参数非法也先答 401：档位判定在参数解析之前，否则 400 就成了白名单探针
    expect((await get('?search=x&search_fields=titel')).status).toBe(401);
  });

  it('非 core → 403', async () => {
    const u = await makeUser({ role: 'user' });
    await login(u.id);
    expect((await get('?search=x')).status).toBe(403);
    expect((await get('?search=x&search_fields=content')).status).toBe(403);
  });
});

describe('GET /api/blogs — search_fields 的白名单与限频', () => {
  it('未知字段名 → 400，且 message 里列出允许值', async () => {
    await loginCore();
    const res = await get('?search=x&search_fields=titel');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message, '要指出是哪个字段不认识').toContain('titel');
    expect(body.message, '要列出可选项，否则调用方无从改').toContain('content');
  });

  it('带 search_fields=content → 200，搜得到正文独有词且带片段', async () => {
    const u = await loginCore();
    await makeBlog({ authorId: u.id, title: '标题无关', content: '正文里有恐龙化石' });

    const res = await get('?search=恐龙化石&search_fields=content');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blogs: { title: string; snippet: string | null }[] };
    expect(body.blogs).toHaveLength(1);
    expect(body.blogs[0].snippet, '正文命中要给出「为什么命中」').toContain('恐龙化石');
  });

  it('不传 search_fields → 默认字段集不含正文（全表扫描不因缺参数而开放）', async () => {
    const u = await loginCore();
    await makeBlog({ authorId: u.id, title: '标题无关', content: '正文里有恐龙化石' });

    const res = await get('?search=恐龙化石');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blogs: unknown[] };
    expect(body.blogs, '默认字段集不含正文').toHaveLength(0);
  });

  it('search_fields 不含 content 时不计 blogSearchMinute（按标题/简介搜照常）', async () => {
    const u = await loginCore();
    await makeBlog({ authorId: u.id, title: '标题无关', description: '简介里有蜻蜓' });

    const res = await get('?search=蜻蜓&search_fields=title,description');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { blogs: unknown[] }).blogs).toHaveLength(1);
  });

  it('搜正文超过 blogSearchMinute 额度 → 429', async () => {
    const u = await loginCore();
    await makeBlog({ authorId: u.id, title: 'T', content: '正文' });

    for (let i = 0; i < RULES.blogSearchMinute.limit; i++) {
      expect((await get(`?search=z${i}&search_fields=content`)).status).toBe(200);
    }
    const over = await get('?search=z&search_fields=content');
    expect(over.status).toBe(429);
  });
});
