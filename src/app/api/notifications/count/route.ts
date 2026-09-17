import { getCurrentUser } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notification-service';
import { getChatDotFor } from '@/lib/chat-service';

// GET /api/notifications/count — 顶栏两个指示器的**兜底快照**。
//
// 【角色】实时值走 SSE（/api/notifications/stream，见 topbar-bus.ts），本接口是它的
// 兜底与首屏：base.js 在流没连上时按 20s 轮询、连上后降到 60s，外加切页 / 回到前台 /
// 收到 {refresh:true} 时的即时重拉。**它不能被删掉** —— SSE 存在「连着但收不到」的
// 半死状态（反代掐连接、NAT 超时），那种时候只有它能纠正数字。
//
// 返回 { count, chatUnread }，两个字段喂两个不同的顶栏指示器：
//   count      → 铃铛数字：**只数站内通知**，即 /notifications 列表里数得出来的那些；
//   chatUnread → 「讨论」链接右上角的小红点：私聊有未读 / 大区被 @ 我
//                （口径见 chat-service.getChatUnreadSummary / getChatDotFor）。
//
// 【为什么讨论不算进 count】讨论消息不进通知列表（见 chat-service.sendMessage），
// 早先把「通知未读 + 讨论未读条数」合成一个数字后，铃铛数字永远大于点进去的条目数
// ——点开列表只有 2 条、铃铛却写着 5。故两者彻底分家：铃铛 = 通知列表，讨论未读归
// 「讨论」链接上的红点（不显数字：跨页数一眼看不出是哪个会话来的）。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ code: 200, count: 0, chatUnread: false });

  // 两个指示器各算各的。红点的闸门（core+ / 未禁言 / 专注模式 / 静音 / 隐藏）收在
  // getChatDotFor 里，与 SSE 推送路径共用同一份 —— 别把闸门搬回这里，那会变成两份。
  const [count, chatUnread] = await Promise.all([
    getUnreadCount(user.id),
    getChatDotFor(user.id),
  ]);

  return Response.json({ code: 200, count, chatUnread });
}
