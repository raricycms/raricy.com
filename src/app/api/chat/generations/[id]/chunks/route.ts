// POST /api/chat/generations/:id/chunks — 提交生成片段（R2）
//
// 请求体 { seq, delta }（8 KiB HTTP body 上限）。读完整 JSON **之前**按累计字节
// 截断，不信任 Content-Length。旧序号同内容重放返回原确认；异内容/跳号 409。

import type { ChatGenerationChunkInput } from '@/lib/chat-generation-shared';
import {
  CHAT_GENERATION_ROUTE_MAX_BODY_BYTES,
  appendGenerationChunk,
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
  const raw = body.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return apiErr(400, '请求参数不合法', { error: 'invalid_request' });
  }
  const payload = raw as Partial<ChatGenerationChunkInput>;

  // 读体窗口的二次鉴权：读体期间会话可能失效 / 被禁言 / 换号，不能用旧快照写任务。
  const currentUser = await revalidateGenerationAuthor(user.id, requireChatUser);
  if (currentUser instanceof Response) return currentUser;

  const outcome = await appendGenerationChunk({
    authorId: currentUser.id,
    generationId,
    lobbyBlocked: isFocusLobbyBlocked(currentUser),
    seq: payload.seq,
    delta: payload.delta,
  });
  if (!outcome.ok) {
    return apiErr(outcome.status, outcome.message, {
      error: outcome.error,
      ...(outcome.extra ?? {}),
    });
  }
  return apiOk(outcome.result);
}