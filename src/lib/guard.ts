import { forbidden, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser, isCoreUser, isOwner, type SafeUser } from './auth';

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

// 对齐原站 @authenticated_required：需登录 + 核心用户（core 及以上）。
// 行为差异（与 Flask 对齐）：
//   - 未登录 → 302 重定向到 /login?next=<原URL>（让用户能登录后再回来）
//   - 已登录但权限不够 → forbidden() 原地渲染 403 页
export async function requireCoreUser(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) {
    const next = await getSafeNextPath();
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!isCoreUser(user)) forbidden();
  return user;
}

// 对齐原站 @owner_required：仅站长可访问。
// 未登录 → 重定向到登录；已登录但非 owner → 403。
export async function requireOwner(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) {
    const next = await getSafeNextPath();
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!isOwner(user)) forbidden();
  return user;
}

// 通用鉴权门（只要求登录，不要求角色）—— 用于"编辑自己的资源"类页面。
// 未登录 → 重定向到登录；登录后权限够不够交给调用方判定。
export async function requireLogin(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) {
    const next = await getSafeNextPath();
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return user;
}