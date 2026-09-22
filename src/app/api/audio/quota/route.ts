import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getQuotaLimitMb } from '@/lib/image-upload';
import { getUserUsedAudioBytes } from '@/lib/audio-service';

export const runtime = 'nodejs';

// GET /api/audio/quota — 当前用户的音频配额
//
// 数值口径与 /api/images/quota **逐字一致**（那是对外契约）：MB 两位小数、
// 百分比一位小数；配额为 0 时百分比直接给 100（不除零）。
// 唯一的差别是 usedBytes 取自**音频自己的聚合** —— 这就是「独立 50MB」在接口上的样子。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const limitMb = getQuotaLimitMb(user.role);
  if (limitMb === 0) return apiErr(403, '无权访问');

  const usedBytes = await getUserUsedAudioBytes(user.id);
  const limitBytes = limitMb * 1024 * 1024;
  const remaining = Math.max(0, limitBytes - usedBytes);

  const quota = {
    used_mb: Math.round((usedBytes / (1024 * 1024)) * 100) / 100,
    limit_mb: limitMb,
    remaining_mb: Math.round((remaining / (1024 * 1024)) * 100) / 100,
    usage_percent:
      limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 100,
  };
  return apiOk({ quota });
}
