import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiErr, apiOk, ymdhms } from '@/lib/format';
import { rentBubble } from '@/lib/bubble-shop-service';
import { RENT_UNITS } from '@/lib/shop-refs';
import { BANNED_MESSAGE } from '../_auth';

export const runtime = 'nodejs';
// 与租框同档，只认会话；价格/单位由服务端定义，调用方只指定商品和数量。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  if (isCurrentlyBanned(user)) return apiErr(403, BANNED_MESSAGE);
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiErr(400, '请求体格式错误');
  const data = body as Record<string, unknown>;
  try {
    const result = await rentBubble({ userId: user.id, key: data.bubble_key, count: data.count });
    if (!result.ok) return apiErr(result.code, result.message);
    return apiOk({
      message: `已租用「${result.label}」${result.count} ${RENT_UNITS[result.unit].noun}，花费 ${result.cost} 条小鱼干`,
      bubble_key: result.key, count: result.count, unit: result.unit, cost: result.cost,
      balance: result.balance, expires_at: result.expiresAt.toISOString(), expires_at_text: ymdhms(result.expiresAt),
    });
  } catch (e) {
    console.error('[bubble-rent] 租赁失败:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
