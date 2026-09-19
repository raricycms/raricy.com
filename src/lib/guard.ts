import { forbidden, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser, hasAdminRights, isCoreUser, isOwner, type SafeUser } from './auth';

// ─── 内部工具：构造当前请求的 path（含 query），作为登录后回跳的 next 参数 ───
//
// 优先取 referer（同源）；referer 缺失或跨域时退回到根路径。
// 不强求精确 —— 登录页只需要一个安全回跳 URL。
async function getSafeNextPath(): Promise<string> {
  const h = await headers();
  const referer = h.get('referer');
  const host = h.get('host');
  if (referer) {
    try {
      const u = new URL(referer);
      // 只接受同源 referer，避免 open redirect
      if (!host || u.host === host) {
        const p = u.pathname + u.search;
        if (p.startsWith('/') && !p.startsWith('//')) return p;
      }
    } catch {
      /* 忽略解析错误 */
    }
  }
  return '/';
}

/**
 * 送未登录的人去登录页，并带上回跳目标。四个守卫共用这一个出口。
 *
 * 【为什么要能显式传 next】`getSafeNextPath()` 读的是 referer —— 从**站外**直接点进来
 * 的访客没有同源 referer，会回落到 '/'：登录完掉回首页，而不是他本来要看的那篇文章。
 * 调用方知道真正的目标时（例如 `/blog/<id>` 的访客分支）就显式传进来。
 *
 * ⚠️ 显式传的 next **仍要过**「以 `/` 开头且不以 `//` 开头」那一道 —— 别因为「反正
 * 调用方是我们自己」就把 open-redirect 的防线绕过去：`//evil.com` 是协议相对 URL，
 * 浏览器会当跨站处理。校验放在这里而不是各调用点，就是为了让下一个调用方无法忘记。
 */
export async function redirectToLogin(next?: string): Promise<never> {
  const safe =
    next && next.startsWith('/') && !next.startsWith('//') ? next : await getSafeNextPath();
  redirect(`/login?next=${encodeURIComponent(safe)}`);
}

// 需登录 + 核心用户（core 及以上）。
// 两道门的行为（改动即改全站入口表现）：
//   - 未登录 → 302 重定向到 /login?next=<原URL>（让用户能登录后再回来）
//   - 已登录但权限不够 → forbidden() 原地渲染 403 页
export async function requireCoreUser(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  if (!isCoreUser(user)) forbidden();
  return user;
}

// 已登录 + admin+（管理员或站长）。
//
// 【为什么需要它】/admin 段（admin/layout.tsx）是 core+ 的 —— 因为段内的「用户管理」
// 对核心用户只读开放（能看、不能改）。于是段内那些**真的**
// 要管理权的页面（概览、文章管理）必须自己去要这一档，不能再靠父 layout 兜。
// 这与 broadcast / categories / appeals 各自的 layout.tsx 是同一个套路。
export async function requireAdmin(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  if (!hasAdminRights(user)) forbidden();
  return user;
}

// 仅站长（owner）可访问。全站最高一档，admin 也进不来。
// 未登录 → 重定向到登录；已登录但非 owner → 403。
export async function requireOwner(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  if (!isOwner(user)) forbidden();
  return user;
}

// 通用鉴权门（只要求登录，不要求角色）—— 用于"编辑自己的资源"类页面。
// 未登录 → 重定向到登录；登录后权限够不够交给调用方判定。
export async function requireLogin(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  return user;
}