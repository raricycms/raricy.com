// GET /api/game/gomoku/rooms/:code — 取全量快照
//
// 用于刷新页面 / 断线重连 / 只读观战。不改变任何状态（不会让人入座 ——
// 入座是 POST join 的事）。SSE 一连上也会推一份当前状态，这条是给
// 「还没连上 SSE」和「resync 兜底」用的。

import { apiErr, apiOk } from '@/lib/format';
import { getSnapshot } from '@/lib/gomoku-room';
import { normalizeRoomCode } from '@/lib/gomoku-shared';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { requireGameUser, roomErrorResponse } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const { code: raw } = await ctx.params;
  // 规范化放在查表之前：非法房号与不存在的房号回同一个 404，
  // 免得把「这个房号格式对不对」变成一个可探测的信号。
  const code = normalizeRoomCode(raw);
  if (!code) return apiErr(404, '房间不存在或已过期');

  const limited = rateLimit(`game:gomoku:poll:${user.id}`, RULES.gomokuPoll);
  if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

  const res = getSnapshot(code, user.id);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value });
}
