// POST /api/game/tictactoe/rooms/:code/moves — 落子
// body: { row: number, col: number }（0..2）
//
// 客户端只报「我点了哪一格」，轮次、合法性、胜负一律由服务端判定 ——
// 这个接口的返回值里带的服务端状态才是权威，客户端的乐观更新只是观感。
//
// 坐标用 row/col 而不是 0..8 的一维编号：房间层对所有棋类都按二维坐标调用，
// 换成一维就要在游戏与房间之间多一层换算 —— 而那层换算正是「点这儿落在隔壁」
// 的经典来源（五子棋在画布坐标上已经踩过一次）。
//
// 成功即由房间层向全房推一帧 SSE，所以本接口**不需要**自己广播。

import { normalizeRoomCode } from '@/lib/board-shared';
import { apiErr, apiOk } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { playMove } from '@/lib/tictactoe-room';
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

  const limited = rateLimit(`game:tictactoe:move:${user.id}`, RULES.gameMove);
  if (!limited.allowed) return apiErr(429, '落子太快，请稍后再试');

  // 坐标校验交给 playMove 统一做（它要对规则负责），这里只挡住类型不对的输入。
  const res = playMove(code, user.id, row, col);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value });
}
