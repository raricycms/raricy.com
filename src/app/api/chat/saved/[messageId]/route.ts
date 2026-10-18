// DELETE /api/chat/saved/:messageId — 取消保存（软删保存行，幂等）
//
// 刻意不限频：它只改自己名下的一行，而且必须永远能做 —— 额度满了以后连取消都被卡，
// 用户就只能等窗口过去才腾得出名额。

import { apiErr, apiOk } from '@/lib/format';
import { unsaveMessage } from '@/lib/saved-message-service';
import { requireChatUser } from '../../_auth';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ messageId: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { messageId } = await ctx.params;
  const res = await unsaveMessage(user.id, messageId);
  if (!res.ok) return apiErr(400, '请求参数有误');
  return apiOk({ saved: false, count: res.count }, '已取消保存');
}
