import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getTodayStatus, checkIn } from '@/lib/checkin-service';

// 签到档位：core+（与投喂、点赞同档）。页面挡了 core，接口也必须自检 ——
// 否则未认证账号 curl 得动签到，等于绕过 core 拿鱼干（见 checkin/page.tsx 的说明）。
//
// **发鱼的就是这一个接口**（2026-09 起签到一起步式）：所以这道 403 是钱的门，
// 不是「入场券」的门。别在任何一层漏判。
const CORE_ONLY = '需要核心用户权限';

// GET /api/checkin — 今日签到状态 + 累计天数 + 余额（需登录 + core）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, CORE_ONLY);

  const s = await getTodayStatus(user.id);
  return apiOk({
    checked_in: s.checkedIn,
    total_count: s.totalCount,
    today: s.today,
    reward_fish: s.rewardFish,
    today_fish: s.todayFish,
    dried_fish: s.driedFish,
  });
}

// POST /api/checkin — 签到：建当日记录 + 发 reward_fish 条鱼干 + 写流水（一个事务）。
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, CORE_ONLY);

  try {
    const result = await checkIn(user.id);

    if (result.alreadyChecked) {
      const s = result.status;
      // 已签到返回 400（不是 200）—— 这是本接口既有的形状，站外机器人按
      // already_checked 判终态，别改成 200。附带的状态字段与 GET 同源。
      return apiErr(400, result.message, {
        already_checked: true,
        total_count: s.totalCount,
        reward_fish: s.rewardFish,
        today_fish: s.todayFish,
        dried_fish: s.driedFish,
      });
    }

    return apiOk({
      message: `签到成功！获得 ${result.rewardFish} 条小鱼干`,
      total_count: result.totalCount,
      reward_fish: result.rewardFish,
      today_fish: result.todayFish,
      dried_fish: result.driedFish,
    });
  } catch (e) {
    // 本地写入失败就是真故障 → 500。签到建行与发鱼在同一个事务里（唯一约束冲突已在
    // service 里转成「今天已签到」的正常返回），能走到这里的事务已整体回滚，没有什么
    // 「稍后再试就好」的暂态可言 —— 别把它伪装成可重试的 503 去骗前端。
    // 兜成结构化 JSON，否则 Next 会回裸 500 HTML，前端 res.json() 直接崩。
    console.error('[checkin] 签到异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
