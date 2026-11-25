// POST /api/chat/generations/:id/cancel — 取消生成任务（R2）
//
// active → cancelled；finalizing → 409（发布已取得唯一提交权）；
// 已终态 → 返回已有终态（幂等）；过期回执 → 410 gone。

import {
  CHAT_GENERATION_ROUTE_MAX_BODY_BYTES,
  cancelGeneration,
  chatGenerationAuthFailure,
  readJsonBodyLimited,
  revalidateGenerationAuthor,
} from '@/lib/chat/generations';
import { apiErr, apiOk } from '@/lib/format';
import { isFocusLobbyBlocked } from '@/lib/focus-mode';
import { requireChatUser } from '../../../_auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return chatGenerationAuthFailure(user);

  const { id: generationId } = await ctx.params;
  const body = await readJsonBodyLimited(req, CHAT_GENERATION_ROUTE_MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === 'too_large'
      ? apiErr(413, '请求内容超过限制', { error: 'too_large' })
      : apiErr(400, '请求参数不合法', { error: 'invalid_request' });
  }
  if (
    body.value !== undefined &&
    (body.value === null || typeof body.value !== 'object' || Array.isArray(body.value))
  ) {
    return apiErr(400, '请求参数不合法', { error: 'invalid_request' });
  }

  // 读体窗口的二次鉴权：读体期间会话可能失效 / 被禁言 / 换号，不能用旧快照动任务。
  const currentUser = await revalidateGenerationAuthor(user.id, requireChatUser);
  if (currentUser instanceof Response) return currentUser;

  const outcome = await cancelGeneration({
    authorId: currentUser.id,
    generationId,
    lobbyBlocked: isFocusLobbyBlocked(currentUser),
  });
  if (!outcome.ok) {
    return apiErr(outcome.status, outcome.message, {
      error: outcome.error,
      ...(outcome.extra ?? {}),
    });
  }
  return apiOk(outcome.result, '生成任务已结束');
}