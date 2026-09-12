import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notification-service';
import { getChatUnreadSummary } from '@/lib/chat-service';

// GET /api/notifications/count — base.js 顶栏轮询用（20s 心跳 + 切页即时刷新）。
//
// 返回 { count, chatUnread }，两个字段喂两个不同的顶栏指示器：
//   count      → 铃铛数字：**只数站内通知**，即 /notifications 列表里数得出来的那些；
//   chatUnread → 「聊天」链接右上角的小红点：私聊有未读 / 大区被 @ 我
//                （口径见 chat-service.getChatUnreadSummary）。
//
// 【为什么聊天不算进 count】聊天消息不进通知列表（见 chat-service.sendMessage），
// 早先把「通知未读 + 聊天未读条数」合成一个数字后，铃铛数字永远大于点进去的条目数
// ——点开列表只有 2 条、铃铛却写着 5。故两者彻底分家：铃铛 = 通知列表，聊天未读归
// 「聊天」链接上的红点（不显数字：跨页数一眼看不出是哪个会话来的）。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ code: 200, count: 0, chatUnread: false });

  // 禁言中的用户进不了聊天页（requireChatUser 403），未读自然也不该在红点上吊着。
  const [notificationCount, chat] = await Promise.all([
    getUnreadCount(user.id),
    isCoreUser(user) && !isCurrentlyBanned(user)
      ? getChatUnreadSummary(user.id, user.focusMode)
      : Promise.resolve({ count: 0, dot: false }),
  ]);

  // 私聊条数与大区 @ 红点在顶栏合流成一个红点：这里不需要区分来源。
  return Response.json({ code: 200, count: notificationCount, chatUnread: chat.count > 0 || chat.dot });
}
