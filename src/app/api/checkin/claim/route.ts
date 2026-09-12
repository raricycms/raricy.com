import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { claimFortune } from '@/lib/checkin-service';
import { AccountServiceError } from '@/lib/account-client';

// POST /api/checkin/claim — 第二步：翻牌定命（对齐 Flask api_claim_fortune）。
// body: { chosenIndex: 0-4 } —— 用户点选的位置；服务端从签到落库的牌池里
// 取 pool[chosenIndex] 赋值，此刻才发鱼干 + 累加 totalFortune + 远端同步。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  let chosenIndex: number;
  try {
    const body = await req.json();
    if (typeof body !== 'object' || body === null) return apiErr(400, '无效的请求');
    if (body.chosenIndex == null) return apiErr(400, '请选择一个卡牌');

    // 对齐 Flask 路由的 int(chosen_index) 强转：数字或整数字符串皆可。
    // 1.5 / 'abc' / true 这类不能静默取整 —— 翻牌只能一次，误转就是开盲盒。
    const raw = body.chosenIndex;
    if (typeof raw === 'string') {
      if (!/^-?\d+$/.test(raw)) return apiErr(400, '无效的选择');
      chosenIndex = Number.parseInt(raw, 10);
    } else if (typeof raw === 'number' && Number.isInteger(raw)) {
      chosenIndex = raw;
    } else {
      return apiErr(400, '无效的选择');
    }
  } catch {
    // 无 body 或非 JSON
    return apiErr(400, '无效的请求');
  }

  try {
    const result = await claimFortune(user.id, chosenIndex);

    if (!result.ok) return apiErr(400, result.message);

    return apiOk({
      fortune_value: result.fortuneValue,
      pool: result.pool,
      total_fortune: result.totalFortune,
      dried_fish: result.driedFish,
      already_claimed: result.alreadyClaimed,
    });
  } catch (e) {
    // 远端同步失败（fail-closed，本地已复原为待翻牌态）→ 503，用户可重选牌。
    if (e instanceof AccountServiceError) return apiErr(503, '鱼干服务暂不可用，请稍后再试');
    console.error('[checkin] 翻牌异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
