// format.ts —— API 响应封装 + 展示辅助（对齐 Flask 的序列化约定）。
// guard.ts  —— 服务端组件的权限闸门（对齐 Flask 的 @authenticated_required / @owner_required）。
//
// 这两个模块都是纯逻辑，但都在"跨端对齐"的关键路径上：
//   - apiErr 的 body.code 与 HTTP status 必须一致：前端统一靠 data.code === 200 判成功，
//     一旦两者错位，前端会把失败当成功（或反之）。
//   - guard 的角色边界一旦放宽，就是越权（图床管理页原为 @owner_required）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// next/navigation 需在 import guard 之前 mock。
// 真实的 forbidden() 会抛出一个特殊错误来中断渲染并交给 forbidden.tsx，
// 这里也让它抛，才能验证 guard 在拒绝时不会继续往下返回 user。
const nav = vi.hoisted(() => ({
  forbidden: vi.fn(() => {
    throw new Error('NEXT_FORBIDDEN');
  }),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));
vi.mock('next/navigation', () => nav);

// 只替换 getCurrentUser（它要读 cookie + 查库），角色判定 isCoreUser/isOwner 保留真实实现 ——
// 权限边界正是被测语义，不能用测试里的假逻辑替身。
const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getCurrentUser: auth.getCurrentUser,
}));

import { apiOk, apiErr, categoryFullPath, ymd } from '@/lib/format';
import { requireCoreUser, requireOwner } from '@/lib/guard';

/** 造一个够用的 SafeUser 替身：guard 只关心 role。 */
function userWithRole(role: string) {
  return { id: `u-${role}`, username: role, role } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// format.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('apiOk —— 成功响应（对齐 Flask 的 { code, message, ...data }）', () => {
  it('HTTP 200 + JSON Content-Type', async () => {
    const res = apiOk({ id: 'x' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('body 为 { code: 200, message, ...data } 平铺结构（data 不嵌套在 data 字段里）', async () => {
    const body = await apiOk({ id: 'b1', title: '标题' }, '发布成功').json();
    expect(body).toEqual({ code: 200, message: '发布成功', id: 'b1', title: '标题' });
  });

  it('默认 message 为 "ok"，默认 data 为空对象', async () => {
    expect(await apiOk().json()).toEqual({ code: 200, message: 'ok' });
  });

  it('data 里的 code 字段会覆盖默认的 200（展开顺序所致，属当前行为）', async () => {
    // 记录事实：apiOk 里 ...data 在 code 之后展开，调用方若传 code 会顶掉 200。
    const body = await apiOk({ code: 201 } as never).json();
    expect(body.code, 'data 中的 code 覆盖了默认值 —— 调用方不应传 code 字段').toBe(201);
  });

  it('数组/嵌套对象等复杂 data 能原样序列化', async () => {
    const body = await apiOk({ items: [{ n: 1 }, { n: 2 }], meta: { total: 2 } }).json();
    expect(body.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(body.meta).toEqual({ total: 2 });
  });
});

describe('apiErr —— 错误响应：body.code 必须等于 HTTP status', () => {
  // 这是全站最容易出错、后果最隐蔽的一处约定：前端只看 data.code。
  for (const code of [400, 401, 403, 404, 429, 500, 503]) {
    it(`code=${code} 时 HTTP status 与 body.code 一致`, async () => {
      const res = apiErr(code, '出错了');
      expect(res.status, `HTTP status 应为 ${code}`).toBe(code);
      const body = await res.json();
      expect(body.code, `body.code 应为 ${code}（前端靠它判定成功/失败）`).toBe(code);
      expect(body.message).toBe('出错了');
    });
  }

  it('extra 字段合并进 body 顶层', async () => {
    const body = await apiErr(429, '太快了', { retryAfter: 60, limit: 100 }).json();
    expect(body).toEqual({ code: 429, message: '太快了', retryAfter: 60, limit: 100 });
  });

  it('extra 默认为空对象（不传也不炸）', async () => {
    expect(await apiErr(404, '未找到').json()).toEqual({ code: 404, message: '未找到' });
  });

  it('extra 里的 code/message 会覆盖参数（展开顺序所致，属当前行为）', async () => {
    // 后果：body.code 与 HTTP status 就此错位 —— 调用方不应在 extra 里塞 code。
    const res = apiErr(400, '原始', { code: 200, message: '被覆盖' });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code, 'extra.code 顶掉了 400 —— body 与 status 错位').toBe(200);
    expect(body.message).toBe('被覆盖');
  });

  it('错误响应也是 JSON Content-Type（不是 HTML 错误页）', () => {
    expect(apiErr(403, '无权限').headers.get('content-type')).toContain('application/json');
  });
});

describe('categoryFullPath —— 对齐 Category.get_full_path()', () => {
  it('无父分类（parentId 为 null）→ 返回自身名', () => {
    expect(categoryFullPath({ name: '技术', parentId: null })).toBe('技术');
  });

  it('有父分类 → 返回「父 > 子」', () => {
    expect(
      categoryFullPath({ name: 'Python', parentId: 1, parent: { name: '技术' } })
    ).toBe('技术 > Python');
  });

  it('分隔符固定为 " > "（前后各一个空格，与 Flask 一致）', () => {
    expect(categoryFullPath({ name: '子', parentId: 9, parent: { name: '父' } })).toContain(' > ');
  });

  it('有 parentId 但未 include parent（parent 为 undefined）→ 降级为自身名，不抛异常', () => {
    // Prisma 查询忘记 include: { parent: true } 时的兜底，避免详情页 500。
    expect(categoryFullPath({ name: '孤儿', parentId: 3 })).toBe('孤儿');
  });

  it('有 parentId 但 parent 显式为 null → 同样降级为自身名', () => {
    expect(categoryFullPath({ name: '孤儿', parentId: 3, parent: null })).toBe('孤儿');
  });

  it('只判到二级：父的父不参与（层级体系本就只有两级）', () => {
    expect(
      categoryFullPath({
        name: '孙',
        parentId: 2,
        parent: { name: '子', parentId: 1, parent: { name: '祖' } } as never,
      })
    ).toBe('子 > 孙');
  });
});

describe('ymd —— 对齐 Blog.to_dict 的 %Y-%m-%d', () => {
  it('null / undefined → null（不返回空串，前端可据此隐藏日期）', () => {
    expect(ymd(null)).toBeNull();
    expect(ymd(undefined)).toBeNull();
  });

  it('正常日期 → YYYY-MM-DD，长度 10、不带时间部分', () => {
    const s = ymd(new Date(Date.UTC(2026, 6, 16, 8, 30, 0)));
    expect(s).toBe('2026-07-16');
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('月/日补零到两位', () => {
    expect(ymd(new Date(Date.UTC(2026, 0, 5, 12, 0, 0)))).toBe('2026-01-05');
  });

  it('【钉住当前行为】按 UTC 切片，不按本地时区', () => {
    // 实现是 d.toISOString().slice(0, 10) —— 恒为 UTC 日历日。
    // 库里存的是 Flask 写入的 naive datetime（实为本地/UTC+8 语义），
    // 因此 UTC+8 当天 00:00–07:59 的时间戳会被渲染成"前一天"。
    // 此处只钉住现状，风险已在交付说明中单列。
    const t = new Date(Date.UTC(2026, 6, 16, 23, 59, 59)); // UTC 7/16 深夜
    expect(ymd(t), 'toISOString 取 UTC 日历日').toBe('2026-07-16');

    const t2 = new Date(Date.UTC(2026, 6, 17, 0, 0, 0)); // UTC 刚跨到 7/17
    expect(ymd(t2)).toBe('2026-07-17');
  });

  it('Unix 纪元前后的边界日期不越界', () => {
    expect(ymd(new Date(Date.UTC(1970, 0, 1, 0, 0, 0)))).toBe('1970-01-01');
    expect(ymd(new Date(Date.UTC(1999, 11, 31, 23, 59, 59)))).toBe('1999-12-31');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// guard.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('requireCoreUser —— 对齐 @authenticated_required（core 及以上）', () => {
  for (const role of ['core', 'admin', 'owner']) {
    it(`✅ ${role} 通过，并原样返回该用户`, async () => {
      const u = userWithRole(role);
      auth.getCurrentUser.mockResolvedValue(u);
      await expect(requireCoreUser()).resolves.toBe(u);
      expect(nav.forbidden, `${role} 不应被拦截`).not.toHaveBeenCalled();
    });
  }

  it('❌ 普通 user（未通过邀请码认证）→ forbidden()', async () => {
    auth.getCurrentUser.mockResolvedValue(userWithRole('user'));
    await expect(requireCoreUser()).rejects.toThrow('NEXT_FORBIDDEN');
    expect(nav.forbidden).toHaveBeenCalledTimes(1);
  });

  it('❌ 未登录（getCurrentUser 返回 null）→ forbidden()', async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    await expect(requireCoreUser()).rejects.toThrow('NEXT_FORBIDDEN');
    expect(nav.forbidden).toHaveBeenCalledTimes(1);
  });

  it('❌ 未知角色不误放行（白名单语义，不是黑名单）', async () => {
    for (const role of ['', 'guest', 'Core', 'OWNER', 'superadmin']) {
      vi.clearAllMocks();
      auth.getCurrentUser.mockResolvedValue(userWithRole(role));
      await expect(requireCoreUser(), `role=${role} 不应被放行`).rejects.toThrow('NEXT_FORBIDDEN');
    }
  });

  it('拒绝时调用 forbidden() 而非 redirect() —— 原站是 abort(403) 原地渲染 403 页', async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    await expect(requireCoreUser()).rejects.toThrow();
    expect(nav.forbidden).toHaveBeenCalled();
    expect(nav.redirect, '不应跳转到登录页：URL 必须保持不变').not.toHaveBeenCalled();
  });
});

describe('requireOwner —— 对齐 @owner_required（仅站长）', () => {
  it('✅ owner 通过，并原样返回该用户', async () => {
    const u = userWithRole('owner');
    auth.getCurrentUser.mockResolvedValue(u);
    await expect(requireOwner()).resolves.toBe(u);
    expect(nav.forbidden).not.toHaveBeenCalled();
  });

  // 这条边界最关键：图床管理页（硬删除 + 删磁盘文件）靠它把 admin 挡在门外。
  for (const role of ['admin', 'core', 'user']) {
    it(`❌ ${role} 被拦截（admin 也不行 —— owner 专属能力）`, async () => {
      auth.getCurrentUser.mockResolvedValue(userWithRole(role));
      await expect(requireOwner(), `${role} 越权访问站长页`).rejects.toThrow('NEXT_FORBIDDEN');
      expect(nav.forbidden).toHaveBeenCalledTimes(1);
    });
  }

  it('❌ 未登录（null）→ forbidden()', async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    await expect(requireOwner()).rejects.toThrow('NEXT_FORBIDDEN');
    expect(nav.forbidden).toHaveBeenCalledTimes(1);
  });

  it('拒绝时调用 forbidden() 而非 redirect()', async () => {
    auth.getCurrentUser.mockResolvedValue(userWithRole('admin'));
    await expect(requireOwner()).rejects.toThrow();
    expect(nav.forbidden).toHaveBeenCalled();
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('两个 guard 都会实际调用 getCurrentUser（不缓存、不跳过校验）', async () => {
    auth.getCurrentUser.mockResolvedValue(userWithRole('owner'));
    await requireCoreUser();
    await requireOwner();
    expect(auth.getCurrentUser).toHaveBeenCalledTimes(2);
  });
});
