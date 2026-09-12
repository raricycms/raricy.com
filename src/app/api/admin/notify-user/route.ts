// POST /api/admin/notify-user { recipientId, action, detail, objectType?, objectId? }
//   管理员向单个用户发送通知（对齐 Flask auth.send_notification_to_user →
//   app/service/notifications.admin_send_notification_to_user）。
//   权限对齐 Flask send_notification_to_user 的 @owner_required：仅站长可定向发通知。
//   偏好：显式 prefKey:'notifyAdmin'（见下方调用处注释）。原先是 force:true 完全绕过偏好
//   （忠实复刻 Flask 的「偏好开关是摆设」），现改为受「管理员通知」开关管辖 —— 这是刻意的
//   行为改进：定向通知本就属管理类，理应尊重用户关掉的管理员通知开关。
import { getCurrentUser, isOwner } from '@/lib/auth';
import { sendNotification } from '@/lib/notification-service';
import { prisma } from '@/lib/db';
import { apiOk, apiErr } from '@/lib/format';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return apiErr(403, '没有站长权限');

  const body = (await req.json().catch(() => null)) as {
    recipientId?: unknown;
    action?: unknown;
    detail?: unknown;
    objectType?: unknown;
    objectId?: unknown;
  } | null;

  const recipientId = body && typeof body.recipientId === 'string' ? body.recipientId.trim() : '';
  const action = body && typeof body.action === 'string' ? body.action.trim() : '';
  const detail = body && typeof body.detail === 'string' ? body.detail.trim() : '';

  // 对齐 Flask required_fields = ['recipient_id', 'action', 'detail']
  if (!recipientId || !action || !detail) return apiErr(400, '缺少必要参数');

  const objectType = body && typeof body.objectType === 'string' && body.objectType ? body.objectType : null;
  const objectId = body && typeof body.objectId === 'string' && body.objectId ? body.objectId : null;

  // 对齐 Flask：先校验接收者存在
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { username: true },
  });
  if (!recipient) return apiErr(400, '接收者不存在');

  const notification = await sendNotification({
    recipientId,
    action,
    actorId: user!.id,
    objectType,
    objectId,
    detail,
    // action 是管理员自由输入的（AdminUserActions.tsx 的下拉可选「维护通知」「活动通知」等，
    // 也可能带上「删除」二字），查表必然猜不准 —— 这里显式声明：管理员定向通知一律
    // 归 notifyAdmin，由「管理员通知」开关管辖，不再靠 action 猜。
    prefKey: 'notifyAdmin',
  });

  if (notification) {
    return apiOk({ notification_id: notification.id }, `通知已发送给 ${recipient.username}`);
  }
  return apiErr(400, '发送失败');
}
