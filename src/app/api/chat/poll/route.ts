import { listChannelsForUser, listMessages, type ChatMessageDTO } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { parsePosInt, requireChatUser } from '../_auth';

// GET /api/chat/poll?channel=<id>&after=<id>
// 聊天页对账轮询（实时消息已改走 SSE，这里只做兜底与低频对账）。
export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  // 全站最重的接口（一次列表 = 若干次 DB 查询），补一条限频兜住异常客户端。
  // 正常客户端约 1~2 次/分钟，碰不到 120/分钟的额度。
  const limited = rateLimit(`chat:poll:${user.id}`, RULES.chatPoll);
  if (!limited.allowed) return apiErr(429, '请求过于频繁，请稍后再试');

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
