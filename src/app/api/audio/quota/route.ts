import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getQuotaLimitMb } from '@/lib/image-upload';
import { getUserUsedAudioBytes } from '@/lib/audio-service';
import { quotaView } from '@/lib/upload-quota';

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

  // 数值口径与 /api/images/quota 共用 upload-quota.ts 的 quotaView（逐字一致，对外契约）。
  const quota = quotaView(usedBytes, limitMb);
  return apiOk({ quota });
}
