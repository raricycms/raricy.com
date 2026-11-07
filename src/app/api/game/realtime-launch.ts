import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { canPlayRealtime, issueRealtimeTicket } from '@/lib/realtime-ticket-service';
import { realtimeServiceToken } from '@/lib/realtime-auth';
import { realtimeWebSocketUrl } from '@/lib/realtime-url';
import { FOCUS_MODE_BLOCKED_TITLE, isFocusGamesBlocked } from '@/lib/focus-mode';
import type { RealtimeGameId } from '../../../../shared/realtime/protocol';

/**
 * 四个实时游戏 launch 路由共用的守卫链与出票流程：
 * 登录 → 专注模式 → 联机资格 → 服务端配置 → 限频 → 签发票据 → 拼 ws 地址。
 *
 * 这四条路由此前逐行各写一遍同样的 14 行，新增一个闸门要改四处、漏一处就是
 * 「某个游戏能绕过专注模式」。现在闸门只在这里加。各路由只剩「哪个游戏」。
 */
export async function launchRealtimeGame(request: Request, gameId: RealtimeGameId): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isFocusGamesBlocked(user)) return apiErr(403, FOCUS_MODE_BLOCKED_TITLE);
  if (!canPlayRealtime(user)) return apiErr(403, '当前账号暂不可使用联机游戏');
  if (!realtimeServiceToken()) return apiErr(503, '实时服务暂未配置');
  const limit = rateLimit(`realtime:launch:${user.id}`, RULES.realtimeLaunch);
  if (!limit.allowed) return apiErr(429, '连接过于频繁，请稍后重试');
  let wsUrl: string;
  try { wsUrl = realtimeWebSocketUrl(request.url, gameId); }
  catch { return apiErr(503, '实时服务地址配置有误'); }
  const ticket = issueRealtimeTicket(user, gameId);
  if (!ticket) return apiErr(503, '实时服务繁忙，请稍后重试');
  return Response.json({ ...ticket, wsUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
