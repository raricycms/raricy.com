import { softDeleteMessage } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { requireChatUser } from '../../_auth';

// DELETE /api/chat/messages/:id — 软删消息（本人 / 管理员）
// body（可选）: { reason?: string }（管理员删他人必填）
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId) || messageId <= 0) return apiErr(400, '无效的消息 id');

  let reason: string | undefined;
  try {
    const body = (await req.json()) as { reason?: unknown } | null;
    if (body && typeof body.reason === 'string') reason = body.reason;
  } catch {
    /* 作者删自己消息时通常不带 body */
  }

  const res = await softDeleteMessage(messageId, { id: user.id, role: user.role }, reason);
  if (res.ok) return apiOk({}, '已删除');
  if (res.error === 'forbidden') return apiErr(403, res.message);
  if (res.error === 'reasonRequired' || res.error === 'reasonTooLong') return apiErr(400, res.message);
  return apiErr(404, res.message);
}
