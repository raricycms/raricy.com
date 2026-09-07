import { listChannelsForUser, listMessages, type ChatMessageDTO } from '@/lib/chat-service';
import { apiOk } from '@/lib/format';
import { parsePosInt, requireChatUser } from '../_auth';

// GET /api/chat/poll?channel=<id>&after=<id>
// 聊天页短轮询单端点：一次带回侧栏全部频道（含未读）+ 活动频道的新消息（增量）。
export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const channelId = url.searchParams.get('channel') ?? '';
  const after = parsePosInt(url.searchParams.get('after'));

  // 专注模式：大区在侧栏里以禁用行存在（无预览无未读），活动频道若是大区则拉不到消息
  const channels = await listChannelsForUser(user.id, user.focusMode);

  let messages: ChatMessageDTO[] = [];
  if (channelId && after != null) {
    const res = await listMessages(channelId, user.id, { after }, user.focusMode);
    if (res.ok) messages = res.messages;
  }

  return apiOk({ channels, channel_id: channelId, messages });
}
