// GET /api/chat/saved/ids?channel=<id> — 某私聊频道里「我保存过的消息 id」
//
// 只服务聊天页首屏：拉回消息后一次批量取，把每条消息的保存按钮标成「已保存」。
// 大区返回空数组（保存箱只收私聊消息）；非成员 403 —— 不是成员就不该知道
// 「这个频道里我有没有保存过什么」。

import { apiErr, apiOk } from '@/lib/format';
import { listSavedMessageIds } from '@/lib/saved-message-service';
import { requireChatUser } from '../../_auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const channelId = new URL(req.url).searchParams.get('channel') ?? '';
  if (!channelId) return apiErr(400, '缺少频道参数');

  const res = await listSavedMessageIds(user.id, channelId);
  if (!res.ok) {
    return res.reason === 'forbidden'
      ? apiErr(403, '无权查看该会话')
      : apiErr(404, '频道不存在');
  }
  return apiOk({ ids: res.ids });
}
