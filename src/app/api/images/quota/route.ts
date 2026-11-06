import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getQuotaLimitMb, getUserUsedBytes } from '@/lib/image-upload';
import { quotaView } from '@/lib/upload-quota';

// 依赖 DB 聚合，需 Node 运行时
export const runtime = 'nodejs';

// GET /api/images/quota — 当前用户存储配额
//   · 需登录 + 核心用户（core 及以上）
//   · 返回 { code, quota: { used_mb, limit_mb, remaining_mb, usage_percent } }
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '无权访问');

  const usedBytes = await getUserUsedBytes(user.id);
  const limitMb = getQuotaLimitMb(user.role);

  // 数值口径（MB 两位小数、百分比一位小数、配额 0 → 100）的唯一实现在 upload-quota.ts。
  const quota = quotaView(usedBytes, limitMb);

  return apiOk({ quota });
}
