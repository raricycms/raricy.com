// GET /api/admin/appeals?page=&status= — 申诉列表（管理员）
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { listAppeals } from '@/lib/admin-appeal-service';
import { apiErr } from '@/lib/format';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

  const url = new URL(req.url);
  const result = await listAppeals({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    status: url.searchParams.get('status'),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    appeals: result.items,
    pagination: {
      page: result.page,
      pages: result.pages,
      total: result.total,
      has_prev: result.hasPrev,
      has_next: result.hasNext,
    },
  });
}
