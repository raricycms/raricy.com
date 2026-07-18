// GET /api/admin/users?page=&search=&perPage= — 用户列表（管理员）
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { listUsers } from '@/lib/admin-user-service';
import { apiErr } from '@/lib/format';

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
