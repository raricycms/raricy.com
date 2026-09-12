// POST /api/game/tictactoe/rooms/:code/moves — 走子
// body: { path: [[row, col]] }
//
// 客户端只报「我走了哪条路径」，轮次、合法性、胜负一律由服务端判定 ——
// 这个接口的返回值里带的服务端状态才是权威，客户端的乐观更新只是观感。
//
// 成功即由房间层向全房推一帧 SSE，所以本接口**不需要**自己广播。

import { apiErr, apiOk } from '@/lib/format';
import { playMove } from '@/lib/tictactoe-room';
import { normalizeRoomCode, type MoveInput } from '@/lib/board-shared';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { requireGameUser, roomErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const { code: raw } = await ctx.params;
  const code = normalizeRoomCode(raw);
  if (!code) return apiErr(404, '房间不存在或已过期');

  const body = (await req.json().catch(() => ({}))) as MoveInput;

  const limited = rateLimit(`game:tictactoe:move:${user.id}`, RULES.gameMove);
  if (!limited.allowed) return apiErr(429, '落子太快，请稍后再试');

  // 棋路的形状校验交给房间层统一做（它要对所有棋负责），这里只挡住解析不出 JSON 的输入。
  const res = playMove(code, user.id, body);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value });
}
