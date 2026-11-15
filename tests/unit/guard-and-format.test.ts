// format.ts —— API 响应封装（前端统一靠 data.code 判成功 / 失败）。
// guard.ts  —— 服务端组件的权限闸门（未登录先跳登录页；已登录但权限不足 → 403）。
//   当前契约（07-24 引入）：
//   · 未登录 → redirect('/login?next=<原URL>') —— 保留目标 URL，登录后回跳
//   · 已登录但权限不足 → forbidden() 原地渲染 403 页
//   redirect / forbidden 都由 next/navigation 抛特殊错误中断渲染，测试里 mock 后同样抛。
//
// 这两个模块都是纯逻辑，但都在"跨端对齐"的关键路径上：
//   - apiErr 的 body.code 与 HTTP status 必须一致：前端统一靠 data.code === 200 判成功，
//     一旦两者错位，前端会把失败当成功（或反之）。
//   - guard 的角色边界一旦放宽，就是越权（图床管理页是仅站长可进的那类页面）。

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

// guard 的 getSafeNextPath() 会读 next/headers 的 referer / host 拼登录回跳 URL。
// vitest 里没有请求上下文，真实 headers() 直接抛「was called outside a request scope」，
// 必须 mock（复用 session.test.ts 的 Map 模式；getSafeNextPath 传的全是小写 key）。
const mockHeaders = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) => mockHeaders.current.get(k.toLowerCase()) ?? null,
  }),
}));

// 只替换 getCurrentUser（它要读 cookie + 查库），角色判定 isCoreUser/isOwner 保留真实实现 ——
// 权限边界正是被测语义，不能用测试里的假逻辑替身。
const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getCurrentUser: auth.getCurrentUser,
}));

import { apiOk, apiErr } from '@/lib/format';
import { requireCoreUser, requireOwner } from '@/lib/guard';

/** 造一个够用的 SafeUser 替身：guard 只关心 role。 */
function userWithRole(role: string) {
  return { id: `u-${role}`, username: role, role } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaders.current = new Map();
});

// ─────────────────────────────────────────────────────────────────────────────
// format.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('apiOk —— 成功响应（{ code, message, ...data } 平铺结构）', () => {
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

  it('错误响应也是 JSON Content-Type（不是 HTML 错误页）', () => {
    expect(apiErr(403, '无权限').headers.get('content-type')).toContain('application/json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// guard.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('requireCoreUser —— core 及以上放行，普通 user 拒绝', () => {
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

  it('❌ 未登录（getCurrentUser 返回 null）→ 重定向到 /login?next=<原URL>，不再原地 403', async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    // referer + host 同源 → getSafeNextPath 取 /audit，登录后回跳
    mockHeaders.current = new Map([
      ['referer', 'http://localhost/audit'],
      ['host', 'localhost'],
    ]);
    await expect(requireCoreUser()).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.redirect, '未登录应回跳登录页并保留原 URL').toHaveBeenCalledWith('/login?next=%2Faudit');
    expect(nav.forbidden).not.toHaveBeenCalled();
  });

  it('❌ 未知角色不误放行（白名单语义，不是黑名单）', async () => {
    for (const role of ['', 'guest', 'Core', 'OWNER', 'superadmin']) {
      vi.clearAllMocks();
      auth.getCurrentUser.mockResolvedValue(userWithRole(role));
      await expect(requireCoreUser(), `role=${role} 不应被放行`).rejects.toThrow('NEXT_FORBIDDEN');
    }
  });

  it('❌ 已登录但权限不足（非 core）→ forbidden() 而非 redirect() —— URL 必须保持不变', async () => {
    auth.getCurrentUser.mockResolvedValue(userWithRole('user'));
    await expect(requireCoreUser()).rejects.toThrow('NEXT_FORBIDDEN');
    expect(nav.forbidden).toHaveBeenCalledTimes(1);
    expect(nav.redirect, '已登录不该跳登录页：URL 必须保持不变').not.toHaveBeenCalled();
  });
});

describe('requireOwner —— 仅站长放行，admin 也不放行', () => {
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

  it('❌ 未登录（null）→ 重定向到 /login?next=<原URL>，不再原地 403', async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    mockHeaders.current = new Map([
      ['referer', 'http://localhost/admin/appeals'],
      ['host', 'localhost'],
    ]);
    await expect(requireOwner()).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.redirect).toHaveBeenCalledWith('/login?next=%2Fadmin%2Fappeals');
    expect(nav.forbidden).not.toHaveBeenCalled();
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
