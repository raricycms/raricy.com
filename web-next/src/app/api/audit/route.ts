// GET /api/audit?page=&action= — 管理操作公示日志（对齐 Flask /audit/logs）
import { listPublicLogs } from '@/lib/audit-service';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const result = await listPublicLogs({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    action: url.searchParams.get('action'),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    logs: result.items.map((l) => ({
      id: l.id,
      created_at: l.createdAt ? l.createdAt.toISOString() : null,
      action: l.action,
      admin: l.admin,
      target_user: l.targetUser,
      object: l.object,
      reason: l.reason,
      extra: l.extra,
      visibility: l.visibility,
      has_pending_appeal: l.hasPendingAppeal,
    })),
    pagination: {
      page: result.page,
      pages: result.pages,
      total: result.total,
      has_prev: result.hasPrev,
      has_next: result.hasNext,
    },
  });
}
