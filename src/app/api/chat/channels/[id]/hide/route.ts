import { hideChannel } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { requireChatUser } from '../../../_auth';

// POST /api/chat/channels/:id/hide — 隐藏会话（「删除会话」）
// 记下当前最大消息 id；对方之后再发消息，会话会重新出现在侧栏。
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const res = await hideChannel(id, user.id);
  if (res.ok) return apiOk({}, '会话已删除');
  if (res.error === 'forbidden') return apiErr(403, '该会话不能删除');
  return apiErr(404, '频道不存在');
}
