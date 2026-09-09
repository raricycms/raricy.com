import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notification-service';
import { getChatUnreadSummary } from '@/lib/chat-service';

// GET /api/notifications/count — base.js 顶栏徽标轮询用。
//
// 返回 { count, dot }：count = 通知未读 + 聊天未读条数（>0 显示数字）；
// count 为 0 而 dot 为 true → 显示小红点（大区只有 @ 我时才亮，见
// chat-service.getChatUnreadSummary）。聊天消息不进通知列表，未读在这里合流。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ code: 200, count: 0, dot: false });

  // 禁言中的用户进不了聊天页（requireChatUser 403），未读自然也不该在徽标上吊着。
  const [notificationCount, chat] = await Promise.all([
    getUnreadCount(user.id),
    isCoreUser(user) && !isCurrentlyBanned(user)
      ? getChatUnreadSummary(user.id, user.focusMode)
      : Promise.resolve({ count: 0, dot: false }),
  ]);

  return Response.json({ code: 200, count: notificationCount + chat.count, dot: chat.dot });
}
