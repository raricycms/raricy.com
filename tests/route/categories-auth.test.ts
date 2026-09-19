// `GET /api/categories` 的档位与形状 —— route handler 层
//
// 【为什么单独一个文件】它是 2026-09 新加的读口，补的是「机器人没法知道栏目 ID」
// 这个缺口（`POST /api/blogs` 收 `category_id`，但此前只有管理员接口能列栏目）。
// 新读口最怕的是**默认匿名**：页面那道 `requireCoreUser()` 只挡浏览器，
// 匿名 curl 一下就是全站栏目树。所以这里按 read-auth.test.ts 的写法三连钉住
// （匿名 401 / 非 core 403 / core 放行）。
//
// 【为什么不属于 blog-auth.test.ts】那份按 DOMAIN_DIRS（blogs/comments/stickers）
// 扫盘并要求 handler 数与会话数严格相等。本路由在 `/api/categories`，不落在任何
// 一个域目录下 —— 塞进去会让它的自检口径变形。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { resetDb, makeUser, makeCategory } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { GET as listCategories } from '@/app/api/categories/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

const getCategories = () => listCategories();

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('GET /api/categories — core+ 档位', () => {
  it('★ 匿名 → 401（新读口不得默认开放）', async () => {
    await makeCategory({ name: '技术' });
    expect((await getCategories()).status).toBe(401);
  });

  it('非 core（普通 user）→ 403，且文案与同域一致', async () => {
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);

    const res = await getCategories();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe('需要核心用户权限');
  });

  it('core 放行 → 200，信封与字段形状', async () => {
    const u = await makeUser({ role: 'core' });
    const parent = await makeCategory({ name: '甲栏目' });
    const child = await makeCategory({ name: '乙子栏', parentId: parent.id });
    await login(u.id);

    const res = await getCategories();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      message: string;
      categories: { id: number; name: string; path: string; parent_id: number | null }[];
    };
    expect(body.code).toBe(200);
    expect(body.message).toBe('ok');
    // 只断言自己造的两条 —— 库是空的，但别把断言写成「恰好等于 2 条」，
    // 那会在将来加入种子栏目时无谓地红。
    const mine = body.categories.filter((c) => c.id === parent.id || c.id === child.id);
    expect(mine.map((c) => [c.name, c.path, c.parent_id])).toEqual([
      ['甲栏目', '甲栏目', null],
      ['乙子栏', '甲栏目 > 乙子栏', parent.id],
    ]);
  });

  it('停用栏目不进清单（机器人照着发也不会撞上「选择的栏目不存在」）', async () => {
    const u = await makeUser({ role: 'core' });
    const off = await makeCategory({ isActive: false });
    await login(u.id);

    const body = (await (await getCategories()).json()) as { categories: { id: number }[] };
    expect(body.categories.some((c) => c.id === off.id)).toBe(false);
  });
});
