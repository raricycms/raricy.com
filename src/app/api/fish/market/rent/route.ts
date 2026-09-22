import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr, ymdhms } from '@/lib/format';
import { rentFrame } from '@/lib/frame-shop-service';
import { BANNED_MESSAGE } from '../_auth';

// node:crypto / prisma 需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/market/rent — 用鱼干租一款头像框。
//
// body: { frame_key: string, days: number }
//
// 【它为什么**不**走 requireMarketActor】本命名空间里其余每一条都走那道三道门
//（会话 / 只读凭据 / 请求体里的 username+password）。这一条只认会话，是刻意的：
//
//   · 第三道门是给**站外脚本**用的。一旦放行，租金与「哪些框在售」就从内部实现
//     变成**对外契约** —— 改价、下架、换天数上限都会破坏兼容，而按本站的纪律，
//     那就得在 `docs/bot/` 里立一份自包含的文档并从此跟着改。
//   · 而机器人租头像框这件事没有真实需求：租期是给人看的，脚本没有头像。
//   · 默认关门（这里是「不开」而不是「忘了开」）：将来真有需求，加门是一次
//     有意识的决定，而不是某次重构顺手把 opts 补上。
//
// 禁言这一道**照旧必须过** —— 会话路径在 _auth.ts 里也是这么判的，同一个页面上
// 不能出现「转账被拦、租框放行」。文案共用同一条常量。
//
// 记账、到期口径、素材缺失拒卖等全在 src/lib/frame-shop-service.ts 的文件头。

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  if (isCurrentlyBanned(user)) return apiErr(403, BANNED_MESSAGE);

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return apiErr(400, '无效的请求');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  try {
    const res = await rentFrame({
      userId: user.id,
      key: body.frame_key,
      days: body.days,
    });
    if (!res.ok) return apiErr(res.code, res.message);

    return apiOk({
      message: `已租用「${res.label}」${res.days} 天，花费 ${res.cost} 条小鱼干`,
      frame_key: res.key,
      label: res.label,
      days: res.days,
      cost: res.cost,
      balance: res.balance,
      // 到期时刻给两种形状：机器读 ISO，人读 UTC+8 口径的展示串。
      // 展示串由服务端算好 —— 客户端一次都不做时间比较（见 frame-refs.ts 头部）。
      expires_at: res.expiresAt.toISOString(),
      expires_at_text: ymdhms(res.expiresAt),
    });
  } catch (e) {
    // 服务层只回业务结果，真故障一律抛到这里（prisma 事务炸了、DB 锁了）。
    console.error('[fish-market] 租用头像框异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
