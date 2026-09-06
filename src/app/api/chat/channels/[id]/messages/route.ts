import { listMessages, sendMessage } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { parsePosInt, requireChatUser } from '../../../_auth';

// GET /api/chat/channels/:id/messages[?after=&before=&limit=]
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const after = parsePosInt(url.searchParams.get('after'));
  const before = parsePosInt(url.searchParams.get('before'));
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? parsePosInt(limitRaw) : null;

  const res = await listMessages(id, user.id, { after, before, limit });
  if (res.ok) return apiOk({ messages: res.messages });
  if (res.error === 'forbidden') return apiErr(403, res.message);
  return apiErr(404, res.message);
}

// POST /api/chat/channels/:id/messages — 发送文本 / 带图消息
// body: { content?: string, image_id?: string, reply_to?: number }
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    content?: unknown;
    image_id?: unknown;
    reply_to?: unknown;
  };

  const content = typeof body.content === 'string' ? body.content : '';
  const imageId = typeof body.image_id === 'string' && body.image_id ? body.image_id : null;
  const replyTo = typeof body.reply_to === 'number' && Number.isInteger(body.reply_to) ? body.reply_to : null;

  const res = await sendMessage({ channelId: id, authorId: user.id, content, imageId, replyTo });
  if (res.ok) return apiOk({ message: res.message }, '发送成功');

  switch (res.error) {
    case 'rateLimited':
      return apiErr(429, res.message);
    case 'forbidden':
      return apiErr(403, res.message);
    case 'notFound':
      return apiErr(404, res.message);
    default:
      return apiErr(400, res.message);
  }
}
