// POST /api/chat/saved — 保存一条私聊消息（body: { messageId: number }）
//
// 幂等：已经保存过就返回成功，不重复计数。失败一律 400「消息不存在或无权保存」——
// 不区分不存在 / 不是成员 / 是大区消息，否则本接口就成了消息存在性探针。
// 只存指针（saved_chat_messages 一行），正文永远按当前消息行解析。

import { apiErr, apiOk } from '@/lib/format';
import { SAVED_MESSAGE_MAX, saveMessage } from '@/lib/saved-message-service';
import { requireChatUser } from '../_auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const body = (await req.json().catch(() => ({}))) as { messageId?: unknown };
  const res = await saveMessage(user.id, body.messageId);
  if (!res.ok) {
    switch (res.reason) {
      case 'rateLimited':
        return apiErr(429, '操作过于频繁，请稍后再试');
      case 'limit':
        return apiErr(400, `最多保存 ${SAVED_MESSAGE_MAX} 条消息`);
      case 'badinput':
        return apiErr(400, '消息不存在或无权保存');
    }
  }
  return apiOk({ saved: true, count: res.count }, '已保存');
}
