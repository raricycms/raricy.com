// POST /api/chat/channels/:id/generations — 创建机器人生成任务（R2）
//
// 协议见 docs/archive/chat-reactive-streaming-design.md §5。author 只从会话取，
// 客户端不能指定；generation id 不是授权凭据（所有生产者接口仅任务作者可用）。
// 响应用全站 JSON 信封 {code, message, ...data}，message 固定为提示字符串。

import type { ChatGenerationCreateInput } from '@/lib/chat-generation-shared';
import {
  CHAT_GENERATION_ROUTE_MAX_BODY_BYTES,
  chatGenerationAuthFailure,
  createGeneration,
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

  const { id: channelId } = await ctx.params;
  const body = await readJsonBodyLimited(req, CHAT_GENERATION_ROUTE_MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === 'too_large'
      ? apiErr(413, '请求内容超过限制', { error: 'too_large' })
      : apiErr(400, '请求参数不合法', { error: 'invalid_request' });
  }
  const raw = body.value;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    return apiErr(400, '请求参数不合法', { error: 'invalid_request' });
  }
  const payload = (raw ?? {}) as Partial<ChatGenerationCreateInput>;

  const currentUser = await revalidateGenerationAuthor(user.id, requireChatUser);
  if (currentUser instanceof Response) return currentUser;

  const outcome = await createGeneration({
    authorId: currentUser.id,
    channelId,
    lobbyBlocked: isFocusLobbyBlocked(currentUser),
    clientRequestId: payload.client_request_id,
    replyTo: payload.reply_to,
  });
  if (!outcome.ok) {
    return apiErr(outcome.status, outcome.message, { error: outcome.error });
  }
  return apiOk(outcome.result, '生成任务已创建');
}
