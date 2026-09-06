import { markChannelRead } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { requireChatUser } from '../../../_auth';

// POST /api/chat/channels/:id/read — 推进读游标 + 清该会话的通知
// body（可选）: { message_id?: number }（缺省 = 频道当前最大 id）
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { message_id?: unknown };
  const messageId =
    typeof body.message_id === 'number' && Number.isInteger(body.message_id) && body.message_id > 0
      ? body.message_id
      : undefined;

  const upTo = await markChannelRead(id, user.id, messageId);
  return apiOk({ message_id: upTo }, '已读');
}
