// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat/channels/:id/typing — 「正在输入」信号
//
// 不落库、不进消息流：只借已有的 SSE 长连接把一次 ephemeral 事件推给同频道的人，
// 客户端 3 秒后自动淡出。发消息仍走 POST /messages，这里只做提示。
//
// 【节流】同一用户对同一频道 3 秒内只广播一次（进程内 Map）。客户端本身也在
// 2 秒节流，这里是服务端兜底 —— 与 chat-bus 同属「单进程」假设，多实例部署时
// 会各推各的（不影响正确性，只是可能重复提示）。
// ─────────────────────────────────────────────────────────────────────────────

import { canAccessChannel } from '@/lib/chat-service';
import { prisma } from '@/lib/db';
import { apiErr, apiOk } from '@/lib/format';
import { publishToAll, publishToUsers } from '@/lib/chat-bus';
import { requireChatUser } from '../../../_auth';
import { CHAT_FOCUS_BLOCKED_TITLE } from '@/lib/chat-shared';

const THROTTLE_MS = 3000;
/** key = `${userId}:${channelId}` → 上次广播时刻（ms） */
const lastSent = new Map<string, number>();

/** 简单的容量兜底：超过 2000 条时清掉 1 分钟前的记录（个人站规模远到不了）。 */
function prune(now: number): void {
  if (lastSent.size <= 2000) return;
  for (const [k, t] of lastSent) {
    if (now - t > 60_000) lastSent.delete(k);
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const access = await canAccessChannel(id, user.id, user.focusMode);
  if (!access.kind) return apiErr(404, '频道不存在');
  if (!access.allowed) {
    return apiErr(
      403,
      user.focusMode && id === 'lobby' ? CHAT_FOCUS_BLOCKED_TITLE : '无权在该会话发言'
    );
  }

  const now = Date.now();
  const key = `${user.id}:${id}`;
  if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) {
    return apiOk({ throttled: true }); // 静默忽略，不算错误
  }
  lastSent.set(key, now);
  prune(now);

  const event = {
    type: 'typing' as const,
    channel_id: id,
    user_id: user.id,
    username: user.username,
  };

  if (access.kind === 'lobby') {
    // 大区：广播给所有在线（专注模式开启者本就看不到大区）
    publishToAll(event, undefined, { skipFocusMode: true });
  } else {
    const members = await prisma.chatMember.findMany({
      where: { channelId: id, NOT: { userId: user.id } },
      select: { userId: true },
    });
    publishToUsers(
      members.map((m) => m.userId),
      event
    );
  }
  return apiOk({});
}
