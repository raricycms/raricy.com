// GET  /api/admin/users?page=&search=&perPage= — 用户列表（管理员）
// POST /api/admin/users                        — 站长建号（仅站长）
import { getCurrentUser, hasAdminRights, isOwner } from '@/lib/auth';
import { listUsers, adminCreateUser } from '@/lib/admin-user-service';
import { apiOk, apiErr } from '@/lib/format';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

  const url = new URL(req.url);
  const result = await listUsers({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    perPage: parseInt(url.searchParams.get('perPage') || '0', 10) || undefined,
    search: url.searchParams.get('search'),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    users: result.users,
    pagination: {
      page: result.page,
      pages: result.pages,
      total: result.total,
      per_page: result.perPage,
      has_prev: result.hasPrev,
      has_next: result.hasNext,
    },
  });
}

// POST /api/admin/users — 站长建号 { username, email?, password, reason? }
//
// 跳过人机验证与邀请码，直接建成 core（见 adminCreateUser 的注释：生产机到 Cloudflare
// 的出口不通，Turnstile 服务端校验不可用，于是改成站长手动开号）。
//
// 这里只做**粗筛**：权限的真边界在 service（adminCreateUser 内部会再判一次 isOwner），
// 因为网页与运维 CLI 共用那个函数。角色不接受入参 —— 硬编码 core。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return apiErr(403, '没有站长权限');

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiErr(400, '请求体格式错误');

  const str = (v: unknown) => (typeof v === 'string' ? v : null);

  const res = await adminCreateUser({
    actor: user!,
    username: str(body.username) ?? '',
    email: str(body.email),
    password: str(body.password) ?? '',
    reason: str(body.reason),
  });

  if (!res.ok) return apiErr(res.code, res.message);
  return apiOk(
    { user: res.user, email: res.email, emailSynthesized: res.emailSynthesized },
    res.message
  );
}
