import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getQuotaLimitMb, getUserUsedBytes } from '@/lib/image-upload';

// 依赖 DB 聚合，需 Node 运行时
export const runtime = 'nodejs';

// GET /api/images/quota — 当前用户存储配额（对齐 Flask image.api_quota）
//   · @authenticated_required：需登录 + 核心用户（core 及以上）
//   · 返回 { code, quota: { used_mb, limit_mb, remaining_mb, usage_percent } }
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '无权访问');

  const usedBytes = await getUserUsedBytes(user.id);
  const limitMb = getQuotaLimitMb(user.role);
  const limitBytes = limitMb * 1024 * 1024;
  const remaining = Math.max(0, limitBytes - usedBytes);

  // 数值口径逐字对齐 Flask ImageService.get_user_quota
  const quota = {
    used_mb: Math.round((usedBytes / (1024 * 1024)) * 100) / 100,
    limit_mb: limitMb,
    remaining_mb: Math.round((remaining / (1024 * 1024)) * 100) / 100,
    usage_percent: limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 100,
  };

  return apiOk({ quota });
}
