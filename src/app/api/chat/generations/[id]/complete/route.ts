// POST /api/chat/generations/:id/complete — 完成生成并发布正式消息（R2）
//
// 唯一正式发送出口：内部调用 chat/messages 的 sendMessage（不经过 HTTP），
// 继承最终权限、正文长度、回复有效性、配额、软删除、提及与未读规则。
// 重复 complete 返回保存的原 HTTP 状态与结果；completed 必有 message_id。

import type { ChatGenerationCompleteInput } from '@/lib/chat-generation-shared';
import {
  CHAT_GENERATION_ROUTE_MAX_BODY_BYTES,
  chatGenerationAuthFailure,
  completeGeneration,
  readJsonBodyLimited,
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
  const raw = body.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return apiErr(400, '请求参数不合法', { error: 'invalid_request' });
  }
  const payload = raw as Partial<ChatGenerationCompleteInput>;

  const outcome = await completeGeneration({
    authorId: user.id,
    generationId,
    lobbyBlocked: isFocusLobbyBlocked(user),
    lastSeq: payload.last_seq,
  });
  if (!outcome.ok) {
    return apiErr(outcome.status, outcome.message, {
      error: outcome.error,
      ...(outcome.extra ?? {}),
    });
  }
  if (outcome.httpStatus !== 200) {
    // 失败终态的 HTTP 状态与结果在回执里固定：重放时原样返回（429/403/500 等）。
    return apiErr(outcome.httpStatus, outcome.message, { ...outcome.result });
  }
  return apiOk(outcome.result, outcome.message);
}