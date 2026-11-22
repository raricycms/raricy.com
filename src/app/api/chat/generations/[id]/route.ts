// GET /api/chat/generations/:id — 查询自己生成任务的状态（R2）
//
// 仅任务作者可查；终态且回执仍在时返回 200，用 status / error 描述结果。
// 生成事件不占消息游标，这里也不推进任何已读。

import {
  chatGenerationAuthFailure,
  getGeneration,
} from '@/lib/chat/generations';
import { apiErr, apiOk } from '@/lib/format';
import { isFocusLobbyBlocked } from '@/lib/focus-mode';
import { requireChatUser } from '../../_auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return chatGenerationAuthFailure(user);

  const { id: generationId } = await ctx.params;
  const outcome = await getGeneration({
    authorId: user.id,
    generationId,
    lobbyBlocked: isFocusLobbyBlocked(user),
  });
  if (!outcome.ok) {
    return apiErr(outcome.status, outcome.message, { error: outcome.error });
  }
  return apiOk(outcome.result);
}