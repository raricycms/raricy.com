import { searchChannelMessages } from '@/lib/chat-service';
import { apiErr, apiOk } from '@/lib/format';
import { parsePosInt, requireChatUser } from '../../../_auth';

// GET /api/chat/channels/:id/search?q=&page= — 在当前频道内按正文搜消息
// 返回 { messages, total, page, per_page }；结果按 id 倒序（新的在前）。
const PER_PAGE = 20;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const page = parsePosInt(url.searchParams.get('page')) ?? 1;

  const res = await searchChannelMessages(
    id,
    user.id,
    q,
    PER_PAGE,
    (page - 1) * PER_PAGE,
    user.focusMode
  );
  if (res.ok) {
    return apiOk({ messages: res.messages, total: res.total, page, per_page: PER_PAGE });
  }
  if (res.error === 'empty') return apiOk({ messages: [], total: 0, page, per_page: PER_PAGE });
  if (res.error === 'forbidden') return apiErr(403, res.message);
  return apiErr(404, res.message);
}
