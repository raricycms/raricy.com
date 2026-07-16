// auth.ts —— 角色判定 + 禁言自动过期（纯函数部分）。
//
// 这些函数是全站鉴权的最底层：blog/admin 路由、API 权限检查都建立在它们之上。
// 一旦某个角色被意外提权（比如未知角色字符串被当成 admin），影响面是整站。
// 所以这里用「角色矩阵」把 Flask 的 user → core → admin → owner 体系逐格钉死。
//
// 不测 getCurrentUser：它依赖 cookie + DB，属于集成范畴，另有用例覆盖。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { isOwner, hasAdminRights, isCoreUser, isCurrentlyBanned } from '@/lib/auth';

/** 角色矩阵：对齐 Flask User 模型的 is_owner / has_admin_rights / is_core_user。 */
const ROLE_MATRIX = [
  //  role       isOwner  hasAdminRights  isCoreUser
  { role: 'owner', owner: true, admin: true, core: true },
  { role: 'admin', owner: false, admin: true, core: true },
  { role: 'core', owner: false, admin: false, core: true },
  { role: 'user', owner: false, admin: false, core: false },
] as const;

describe('角色矩阵（user → core → admin → owner 逐级包含）', () => {
  for (const row of ROLE_MATRIX) {
    it(`role=${row.role} → isOwner=${row.owner} / hasAdminRights=${row.admin} / isCoreUser=${row.core}`, () => {
      const u = { role: row.role };
      expect(isOwner(u), `isOwner('${row.role}')`).toBe(row.owner);
      expect(hasAdminRights(u), `hasAdminRights('${row.role}')`).toBe(row.admin);
      expect(isCoreUser(u), `isCoreUser('${row.role}')`).toBe(row.core);
    });
  }

  it('owner 满足全部三项（站长是最高权限，不能漏任何一项）', () => {
    const owner = { role: 'owner' };
    expect([isOwner(owner), hasAdminRights(owner), isCoreUser(owner)]).toEqual([true, true, true]);
  });

  it('admin 有管理权但不是站长（owner-only 操作必须挡住 admin）', () => {
    const admin = { role: 'admin' };
    expect(isOwner(admin), 'admin 被判为 owner ⇒ 越权访问站长功能').toBe(false);
    expect(hasAdminRights(admin)).toBe(true);
    expect(isCoreUser(admin)).toBe(true);
  });

  it('core 只是认证用户，无任何管理权', () => {
    const core = { role: 'core' };
    expect(hasAdminRights(core), 'core 被判为 admin ⇒ 普通认证用户能进后台').toBe(false);
    expect(isOwner(core)).toBe(false);
    expect(isCoreUser(core)).toBe(true);
  });

  it('普通 user 三项全否（未通过邀请码认证，authenticated_required 应拦截）', () => {
    const user = { role: 'user' };
    expect([isOwner(user), hasAdminRights(user), isCoreUser(user)]).toEqual([false, false, false]);
  });
});

describe('null / 异常输入（未登录与防意外提权）', () => {
  it('null（未登录）→ 三项均 false，且不抛异常', () => {
    expect(() => isOwner(null)).not.toThrow();
    expect(isOwner(null), '未登录被判为 owner').toBe(false);
    expect(hasAdminRights(null), '未登录被判为 admin').toBe(false);
    expect(isCoreUser(null), '未登录被判为 core').toBe(false);
  });

  it('未知角色字符串一律 false —— 白名单判定，不能被意外提权', () => {
    // 关键：实现必须是「等于某个已知值」而不是「包含 admin」之类的模糊匹配，
    // 否则数据库里塞进 'superadmin' 就能白拿管理权。
    const unknown = ['superadmin', 'admin ', 'Admin', 'OWNER', 'root', 'owner;--', 'core_user', ''];
    for (const role of unknown) {
      const u = { role };
      expect(isOwner(u), `isOwner('${role}') 应为 false`).toBe(false);
      expect(hasAdminRights(u), `hasAdminRights('${role}') 应为 false`).toBe(false);
      expect(isCoreUser(u), `isCoreUser('${role}') 应为 false`).toBe(false);
    }
  });

  it('角色判定大小写敏感（DB 里存的就是小写，大写视为未知角色）', () => {
    expect(isOwner({ role: 'Owner' })).toBe(false);
    expect(hasAdminRights({ role: 'ADMIN' })).toBe(false);
  });
});

// ── 禁言判定 ────────────────────────────────────────────────────────────────

describe('isCurrentlyBanned —— 对齐 Flask is_currently_banned 的自动过期语义', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW = new Date('2026-07-16T12:00:00.000Z');
  const future = (ms: number) => new Date(NOW.getTime() + ms);
  const past = (ms: number) => new Date(NOW.getTime() - ms);

  it('isBanned=false → 未禁言（banUntil 是什么都不看）', () => {
    expect(isCurrentlyBanned({ isBanned: false, banUntil: null })).toBe(false);
    // 历史遗留的 banUntil 不该让没被禁言的人挨罚
    expect(
      isCurrentlyBanned({ isBanned: false, banUntil: new Date('2099-01-01') }),
      'isBanned=false 时不应因残留的 banUntil 被判禁言'
    ).toBe(false);
  });

  it('isBanned=true 且 banUntil=null → 永久禁言，始终为 true', () => {
    expect(
      isCurrentlyBanned({ isBanned: true, banUntil: null }),
      '永久禁言（无到期时间）被判为已过期 ⇒ 禁言形同虚设'
    ).toBe(true);
  });

  it('isBanned=true 且 banUntil 在未来 → 禁言生效中', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isCurrentlyBanned({ isBanned: true, banUntil: future(1000) })).toBe(true);
    expect(isCurrentlyBanned({ isBanned: true, banUntil: future(7 * 24 * 3600_000) })).toBe(true);
  });

  it('isBanned=true 但 banUntil 已过去 → 自动过期为未禁言（无需后台清理）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(
      isCurrentlyBanned({ isBanned: true, banUntil: past(1000) }),
      '禁言已到期却仍被判禁言 ⇒ 用户被永久卡死'
    ).toBe(false);
    expect(isCurrentlyBanned({ isBanned: true, banUntil: past(365 * 24 * 3600_000) })).toBe(false);
  });

  it('边界：banUntil 恰好等于当前时刻 → 仍算禁言中', () => {
    // 实现为 `new Date() > banUntil` 才判过期（严格大于），
    // 因此「恰好等于」这一毫秒尚未过期，判定为仍在禁言 —— 对用户更严格的一侧。
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isCurrentlyBanned({ isBanned: true, banUntil: new Date(NOW.getTime()) })).toBe(true);
  });

  it('边界：banUntil = now + 1ms 仍禁言，now - 1ms 即解除（切换点精确在到期时刻）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isCurrentlyBanned({ isBanned: true, banUntil: future(1) }), 'now+1ms').toBe(true);
    expect(isCurrentlyBanned({ isBanned: true, banUntil: past(1) }), 'now-1ms').toBe(false);
  });

  it('isBanned=null（DB 可空字段未设置）视为未禁言，不抛异常', () => {
    expect(() => isCurrentlyBanned({ isBanned: null, banUntil: null })).not.toThrow();
    expect(isCurrentlyBanned({ isBanned: null, banUntil: null })).toBe(false);
  });

  it('是纯判定，不产生副作用（不改传入对象；过期状态的落库由调用方负责）', () => {
    // Flask 的 is_currently_banned 会顺手清掉过期禁言状态；TS 版只读不写。
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const u = { isBanned: true, banUntil: past(1000) };
    isCurrentlyBanned(u);
    expect(u.isBanned, '判定函数不应就地修改用户对象').toBe(true);
    expect(u.banUntil).toEqual(past(1000));
  });
});
