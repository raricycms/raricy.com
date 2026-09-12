// POST /api/game/tictactoe/rooms/:code/resign — 认输
//
// 无请求体。对局进行中才可用（等对手时认输 → 409，终局后 → 409）。
// 井字棋一局只有 9 手，认输用得少，但「对手跑了/我不想下了」需要一个出口。

import { normalizeRoomCode } from '@/lib/board-shared';
import { apiErr, apiOk } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { resign } from '@/lib/tictactoe-room';
import { requireGameUser, roomErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const { code: raw } = await ctx.params;
  const code = normalizeRoomCode(raw);
  if (!code) return apiErr(404, '房间不存在或已过期');

  const limited = rateLimit(`game:tictactoe:move:${user.id}`, RULES.gameMove);
  if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

  const res = resign(code, user.id);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value }, '已认输');
}
