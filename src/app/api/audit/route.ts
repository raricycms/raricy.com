// GET /api/audit?page=&action= — 管理操作公示日志
//
// 【鉴权】需 core+ 登录，与 `/audit` 页面同档（见 `docs/architecture.md` §8
// 「档位阶梯：页面与接口必须同档，每层都自己判」）。
// 这条此前匿名可读 —— 而它返回的是**管理员与被处置用户的用户名、处置理由**，
// 等于把站内的处置记录对全互联网敞开。「公示」在本站的口径是**公示给站内成员**
// （母版 `src/app/audit/layout.tsx` 就是 `requireCoreUser()`），不是对外透明。
// 未登录 → 401；非 core → 403。**成功路径的形状一字不动**。
import { listPublicLogs } from '@/lib/audit-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const url = new URL(req.url);
  const result = await listPublicLogs({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    action: url.searchParams.get('action'),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    logs: result.items.map((l: {
      id: string | number;
      createdAt: Date | null;
      action: string;
      admin: { id: string | number; username: string | null };
      targetUser?: { id: string | number; username: string | null } | null;
      object?: { type: string | null; id: string | null } | null;
      reason: string | null;
      extra?: Record<string, unknown> | null;
      visibility: string;
      hasPendingAppeal: boolean;
    }) => ({
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
