// POST /api/game/gomoku/rooms — 建房
//
// 建房者执黑（先手），房间进入 waiting 等对手。房号就是邀请凭证 ——
// 把 /game/gomoku?mode=online&room=<code> 发给朋友即可，不需要额外的邀请接口。
//
// 房间活在进程内存里（见 gomoku-room.ts 文件头），所以这里有两道界：
// 限频挡脚本，MAX_ROOMS 挡内存无界增长。

import { apiErr, apiOk } from '@/lib/format';
import { createRoom } from '@/lib/gomoku-room';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { requireGameUser, roomErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const limited = rateLimit(`game:gomoku:room:${user.id}`, RULES.gomokuRoom);
  if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

  const res = createRoom({ id: user.id, name: user.username });
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value }, '房间已创建');
}
