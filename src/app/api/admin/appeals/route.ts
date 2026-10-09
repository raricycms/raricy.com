// GET /api/admin/appeals?page=&status= — 申诉列表（与裁决页面同为站长档）
import { getCurrentUser, isOwner } from '@/lib/auth';
import { listAppeals } from '@/lib/admin-appeal-service';
import { apiErr } from '@/lib/format';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return apiErr(403, '仅站长可访问');

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
