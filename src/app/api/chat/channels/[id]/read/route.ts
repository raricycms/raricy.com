import { markChannelRead } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { isFocusLobbyBlocked } from '@/lib/focus-mode';
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

  // 返回**实际生效的游标**（只增不减），不是请求里的 message_id：重放 / 乱序到达的
  // 较小 id 不会把游标写回去，响应里的数字也不会因此变小。字段名保持 `message_id`
  // （docs/bot/chat-bot.md §7.6：0 = 没生效，非 0 = 推进成功；该节已写明响应是
  // 实际生效的游标、不是请求值回显 —— 传了别的频道的 id 时本来就回落成频道最大 id）。
  // 本仓消费者核对：ChatApp 的 markRead 不读响应体（`await api(...)` 无赋值）；
  // e2e / route 用例只看 status 与 message_id 是否为 0（chat-unread-mark.spec.ts、
  // chat-mention-notify.spec.ts 只断 status；chat-auth.test.ts 只断言档位拒绝）。
  const cursor = await markChannelRead(id, user.id, messageId, isFocusLobbyBlocked(user));
  return apiOk({ message_id: cursor }, '已读');
}
