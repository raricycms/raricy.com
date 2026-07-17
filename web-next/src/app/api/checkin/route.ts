import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getTodayStatus, doCheckin, fortuneLabel, isInvalidChoice } from '@/lib/checkin-service';

// GET /api/checkin — 今日签到状态 + 累计天数 + 余额（需登录）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const s = await getTodayStatus(user.id);
  return apiOk({
    checked_in: s.checkedIn,
    total_count: s.totalCount,
    today: s.today,
    fortune_value: s.fortuneValue,
    fortune_label: fortuneLabel(s.fortuneValue),
    total_fortune: s.totalFortune,
    dried_fish: s.driedFish,
  });
}

// POST /api/checkin — 执行签到（建记录 + 抽运势 + 发鱼干 + 累加运势，仅本地）
// body 可选 { chosenIndex: 0-4 } 指定翻哪张牌，缺省随机。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  let chosenIndex: number | undefined;
  try {
    const body = await req.json();
    if (body && body.chosenIndex != null) {
      const n = Number.parseInt(String(body.chosenIndex), 10);
      // 解析失败不能静默忽略：那会变成「用户想选某张牌，却拿到随机牌且无法重来」。
      // 传了值就必须是合法数字，否则报错（越界由 doCheckin 统一判定）。
      if (Number.isNaN(n)) return apiErr(400, '无效的选择');
      chosenIndex = n;
    }
  } catch {
    // 无 body 或非 JSON — 未指定，随机翻牌
  }

  const result = await doCheckin(user.id, chosenIndex);

  if (isInvalidChoice(result)) return apiErr(400, result.message);

  if (result.alreadyChecked) {
    return apiErr(400, result.message, {
      already_checked: true,
      total_count: result.status.totalCount,
      fortune_value: result.status.fortuneValue,
      total_fortune: result.status.totalFortune,
      dried_fish: result.status.driedFish,
    });
  }

  return apiOk({
    message: '签到成功！',
    fortune_value: result.fortuneValue,
    fortune_label: fortuneLabel(result.fortuneValue),
    pool: result.pool,
    chosen_index: result.chosenIndex,
    total_fortune: result.totalFortune,
    dried_fish: result.driedFish,
    total_count: result.totalCount,
  });
}
