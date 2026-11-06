// GET /api/admin/appeals?page=&status= — 申诉列表（与裁决页面同为站长档）
import { getCurrentUser, isOwner } from '@/lib/auth';
import { listAppeals } from '@/lib/admin-appeal-service';
import { apiOk, apiErr } from '@/lib/format';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return apiErr(403, '仅站长可访问');

  const url = new URL(req.url);
  const result = await listAppeals({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    status: url.searchParams.get('status'),
  });

  // 走 apiOk 而不是裸 Response.json：统一带 Cache-Control: no-store（申诉列表含
  // 当事人与处置理由，不允许被中间缓存留副本）。
  return apiOk({
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
