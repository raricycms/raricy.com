// POST /api/game/tictactoe/rooms/:code/join — 入座 / 转观众
//
// **幂等**：已在座或已在观众席的调用者拿回原身份，服务端不重置任何状态。
// 这条路径正是「刷新页面回到原座」与「断线重连不丢座」走的 —— 见 board-room 的注释。
//
// 两席坐满后自动转观众（观战是白送的：走子本来就是公开信息）。

import { normalizeRoomCode } from '@/lib/board-shared';
import { apiErr, apiOk } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { joinRoom } from '@/lib/tictactoe-room';
import { requireGameUser, roomErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const { code: raw } = await ctx.params;
  const code = normalizeRoomCode(raw);
  if (!code) return apiErr(404, '房间不存在或已过期');

  const limited = rateLimit(`game:tictactoe:room:${user.id}`, RULES.gameRoom);
  if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

  const res = joinRoom(code, { id: user.id, name: user.username });
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value });
}
