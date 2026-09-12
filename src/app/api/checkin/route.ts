import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getTodayStatus, checkIn, fortuneLabel } from '@/lib/checkin-service';
import { AccountServiceError } from '@/lib/account-client';

// GET /api/checkin — 今日签到状态 + 累计天数 + 余额（需登录）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const s = await getTodayStatus(user.id);
  return apiOk({
    checked_in: s.checkedIn,
    fortune_pending: s.fortunePending,
    total_count: s.totalCount,
    today: s.today,
    fortune_value: s.fortuneValue,
    fortune_label: fortuneLabel(s.fortuneValue),
    total_fortune: s.totalFortune,
    dried_fish: s.driedFish,
  });
}

// POST /api/checkin — 第一步：签到（建记录 + 洗牌落库，不发鱼/不抽运势）。
// 第二步「翻牌定命」走 POST /api/checkin/claim（见 claim/route.ts）。
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  try {
    const result = await checkIn(user.id);

    if (result.alreadyChecked) {
      const s = result.status;
      return apiErr(400, result.message, {
        already_checked: true,
        fortune_pending: s.fortunePending,
        total_count: s.totalCount,
        fortune_value: s.fortuneValue,
        total_fortune: s.totalFortune,
        dried_fish: s.driedFish,
      });
    }

    return apiOk({
      message: '签到成功！',
      total_count: result.totalCount,
      fortune_pending: true,
      show_fortune: true,
    });
  } catch (e) {
    // 生产漏配置守卫会抛 AccountServiceError(503) —— 兜成结构化 JSON，
    // 否则 Next 会回裸 500 HTML，前端 res.json() 直接崩。
    if (e instanceof AccountServiceError) return apiErr(503, '账户服务暂不可用，请稍后再试');
    console.error('[checkin] 签到异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
