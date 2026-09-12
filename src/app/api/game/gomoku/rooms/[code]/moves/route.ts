// POST /api/game/gomoku/rooms/:code/moves — 走子
// body: { row: number, col: number }
//
// 客户端只报「我点了哪一格」，轮次、合法性、胜负一律由服务端判定 ——
// 这个接口的返回值里带的服务端状态才是权威，客户端的乐观更新只是观感。
//
// 成功即由房间层向全房推一帧 SSE，所以本接口**不需要**自己广播。

import { apiErr, apiOk } from '@/lib/format';
import { playMove } from '@/lib/gomoku-room';
import { normalizeRoomCode } from '@/lib/board-shared';
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

  const body = (await req.json().catch(() => ({}))) as { row?: unknown; col?: unknown };
  const row = typeof body.row === 'number' ? body.row : NaN;
  const col = typeof body.col === 'number' ? body.col : NaN;

  const limited = rateLimit(`game:gomoku:move:${user.id}`, RULES.gameMove);
  if (!limited.allowed) return apiErr(429, '落子太快，请稍后再试');

  // 坐标校验交给 playMove 统一做（它要对规则负责），这里只挡住类型不对的输入。
  const res = playMove(code, user.id, row, col);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value });
}
