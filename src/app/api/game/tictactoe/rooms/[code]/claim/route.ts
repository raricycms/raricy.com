// POST /api/game/tictactoe/rooms/:code/claim — 对手掉线判胜
//
// 无请求体，「我等了多久」由服务端自己算 —— 客户端只负责点按钮。
// 掉线满 DISCONNECT_CLAIM_MS 才判胜（不满 → 409），对手重新连上即撤销资格（→ 409）。
//
// 【为什么不做服务端定时器】定时器要在房间状态机之外再维护一套「到点了判谁赢」，
// 是另一类 bug 的来源。这里改成惰性判定：不变量是「disconnectedAt 为 null 就是在线」，
// 判胜时现算。代价是必须有人点一下按钮，收益是少一整类状态。

import { normalizeRoomCode } from '@/lib/board-shared';
import { apiErr, apiOk } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { claimAbandoned } from '@/lib/tictactoe-room';
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

  const res = claimAbandoned(code, user.id);
  if (!res.ok) return roomErrorResponse(res.error);

  return apiOk({ room: res.value }, '已判胜');
}
