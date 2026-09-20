import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getTodayStatus, checkIn, fortuneLabel } from '@/lib/checkin-service';

// 签到档位：core+（与投喂、点赞同档）。页面挡了 core，接口也必须自检 ——
// 否则未认证账号 curl 得动签到，等于绕过 core 拿鱼干（见 checkin/page.tsx 的说明）。
const CORE_ONLY = '需要核心用户权限';

// GET /api/checkin — 今日签到状态 + 累计天数 + 余额（需登录 + core）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, CORE_ONLY);

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
  if (!isCoreUser(user)) return apiErr(403, CORE_ONLY);

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
    // 本地写入失败就是真故障 → 500。签到只建一行记录（唯一约束冲突已在 service
    // 里转成「今天已签到」的正常返回），能走到这里的事务已整体回滚，没有什么
    // 「稍后再试就好」的暂态可言 —— 别把它伪装成可重试的 503 去骗前端。
    // 兜成结构化 JSON，否则 Next 会回裸 500 HTML，前端 res.json() 直接崩。
    console.error('[checkin] 签到异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
