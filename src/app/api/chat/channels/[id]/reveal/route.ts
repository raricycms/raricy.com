// POST /api/chat/channels/:id/reveal — 解除「删除会话」（隐藏）
//
// 与 /hide 对称。隐藏是「暂时从侧栏收起来」，不是删除；从保存箱点一条历史消息时，
// 显式进入意味着用户要看这个会话，所以聊天页在首屏 poll 之前先调一次这里。
// 大区不可隐藏，因此也不可恢复（沿用 hideChannel 的 forbidden 口径）。

import { revealChannel } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { requireChatUser } from '../../../_auth';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const res = await revealChannel(id, user.id);
  if (res.ok) return apiOk({}, '会话已恢复');
  if (res.error === 'forbidden') return apiErr(403, '该会话不能恢复');
  return apiErr(404, '频道不存在');
}
