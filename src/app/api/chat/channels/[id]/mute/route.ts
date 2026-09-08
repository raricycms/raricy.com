import { setChannelMuted } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { requireChatUser } from '../../../_auth';

// POST /api/chat/channels/:id/mute — 会话静音开关
// body: { muted: boolean }；静音只影响通知，未读徽标照常。
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { muted?: unknown };
  const muted = body.muted === true;

  const res = await setChannelMuted(id, user.id, muted);
  if (res.ok) return apiOk({ muted }, muted ? '已静音' : '已取消静音');
  if (res.error === 'forbidden') return apiErr(403, '无权操作该会话');
  return apiErr(404, '频道不存在');
}
