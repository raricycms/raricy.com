import { requireChatUser } from '../../../_auth';
import { canAccessChannel } from '@/lib/chat-service';
import { prisma } from '@/lib/db';
import { bubbleKeyFor } from '@/lib/bubble-service';
import { apiErr, apiOk } from '@/lib/format';

// 只读取当前可访问频道的作者。分批上限防任意枚举/无限查询；不改消息、读游标或通知。
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const access = await canAccessChannel(id, user.id, user.focusMode);
  if (!access.allowed) return apiErr(access.kind ? 403 : 404, '会话不可访问');
  const ids = [...new Set((new URL(req.url).searchParams.get('users') ?? '').split(',').filter(Boolean))];
  if (ids.length > 100 || ids.some((v) => v.length > 64)) return apiErr(400, '最多查询 100 位消息作者');
  const authors = await prisma.user.findMany({
    where: { id: { in: ids }, chatMessages: { some: { channelId: id } } },
    select: { id: true, equippedBubbleKey: true, equippedBubbleExpiresAt: true },
  });
  return apiOk({ authors: authors.map((a) => ({ id: a.id, bubble_key: bubbleKeyFor(a) })) });
}
