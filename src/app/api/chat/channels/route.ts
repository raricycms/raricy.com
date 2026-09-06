import { startDirectChannel } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { requireChatUser } from '../_auth';

// POST /api/chat/channels — 发起/复用与某用户的私聊
// body: { user_id: string }
export async function POST(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const body = (await req.json().catch(() => ({}))) as { user_id?: unknown };
  const otherId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  if (!otherId) return apiErr(400, '缺少用户参数');

  const res = await startDirectChannel(user.id, otherId);
  if (res.ok) return apiOk({ channel: res.channel }, '已进入会话');
  if (res.error === 'self') return apiErr(400, '不能和自己私聊');
  if (res.error === 'forbidden') return apiErr(403, res.message);
  return apiErr(404, res.message);
}
