import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { canPlayRealtime, issueRealtimeTicket } from '@/lib/realtime-ticket-service';
import { realtimeServiceToken } from '@/lib/realtime-auth';
import { realtimeWebSocketUrl } from '@/lib/realtime-url';
import { FOCUS_MODE_BLOCKED_TITLE, isFocusGamesBlocked } from '@/lib/focus-mode';

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isFocusGamesBlocked(user)) return apiErr(403, FOCUS_MODE_BLOCKED_TITLE);
  if (!canPlayRealtime(user)) return apiErr(403, '当前账号暂不可使用联机游戏');
  if (!realtimeServiceToken()) return apiErr(503, '实时服务暂未配置');
  const limit = rateLimit(`realtime:launch:${user.id}`, RULES.realtimeLaunch);
  if (!limit.allowed) return apiErr(429, '连接过于频繁，请稍后重试');
  let wsUrl: string;
  try { wsUrl = realtimeWebSocketUrl(request.url, 'quandi'); }
  catch { return apiErr(503, '实时服务地址配置有误'); }
  const ticket = issueRealtimeTicket(user, 'quandi');
  if (!ticket) return apiErr(503, '实时服务繁忙，请稍后重试');
  return Response.json({ ...ticket, wsUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
