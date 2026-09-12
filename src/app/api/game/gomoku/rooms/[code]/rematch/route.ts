// POST /api/game/gomoku/rooms/:code/rematch — 投票「再来一局」
//
// 无请求体。双方各点一次即重开（同色不换先）。一票时对局仍是终局状态，
// 客户端据 room.view.rematchVotes 显示「已申请，等对手」。

import { apiErr, apiOk } from '@/lib/format';
import { requestRematch } from '@/lib/gomoku-room';
import { normalizeRoomCode } from '@/lib/board-shared';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { requireGameUser, roomErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const { code: raw } = await ctx.params;
  const code = normalizeRoomCode(raw);
  if (!code) return apiErr(404, '房间不存在或已过期');

  const limited = rateLimit(`game:gomoku:move:${user.id}`, RULES.gameMove);
  if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

  const res = requestRematch(code, user.id);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value }, '已申请再来一局');
}
