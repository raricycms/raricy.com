// ─────────────────────────────────────────────────────────────────────────────
// notification-service.ts — 通知业务逻辑（对齐 Flask app/service/notifications.py）
//
// 与 Flask 解耦风格一致：纯函数 + 显式参数。
//   • 列表：recipientId = 当前用户，timestamp 倒序，20/页，带 actor.username。
//   • 未读数 / 标记单条已读 / 全部已读。
//   • sendNotification 尊重接收者的 notify_* 偏好（除非 force）——
//     Flask 侧偏好判定散落在各调用点（如 like_service 的 author.notify_like），
//     这里统一收敛进 helper，action→pref 映射同 Flask 语义。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';

const DEFAULT_PER_PAGE = 20;

type NotifyPrefKey = 'notifyLike' | 'notifyEdit' | 'notifyDelete' | 'notifyAdmin';

/**
 * 将 action 映射到用户通知偏好字段（对齐 Flask：like→notifyLike, edit→notifyEdit,
 * delete→notifyDelete, admin→notifyAdmin）。兼容英文关键字与 Flask 侧的中文 action。
 * 返回 null 表示该 action 不受偏好约束，无条件发送。
 */
export function prefForAction(action: string): NotifyPrefKey | null {
  const a = action.toLowerCase();
  if (a.includes('like') || action.includes('点赞')) return 'notifyLike';
  if (a.includes('edit') || action.includes('编辑')) return 'notifyEdit';
  if (a.includes('delete') || action.includes('删除')) return 'notifyDelete';
  if (
    a.includes('admin') ||
    action.includes('管理') ||
    action.includes('公告') ||
    action.includes('禁言') ||
    action.includes('通知')
  ) {
    return 'notifyAdmin';
  }
  return null;
}

export interface SendNotificationInput {
  recipientId: string;
  action: string;
  actorId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  detail?: string | null;
  force?: boolean;
}

/**
 * 发送通知。接收者不存在返回 null；被偏好拦截（非 force）返回 null；否则返回创建的记录。
 * id 用 crypto.randomUUID()，timestamp 用 new Date()（对齐模型 default）。
 */
export async function sendNotification(input: SendNotificationInput) {
  const {
    recipientId,
    action,
    actorId = null,
    objectType = null,
    objectId = null,
    detail = null,
    force = false,
  } = input;

  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { notifyLike: true, notifyEdit: true, notifyDelete: true, notifyAdmin: true },
  });
  if (!recipient) return null;

  if (!force) {
    const prefKey = prefForAction(action);
    // 偏好字段可空，缺省视为开启（对齐 Flask getattr(..., True)）
    if (prefKey && recipient[prefKey] === false) return null;
  }

  return prisma.notification.create({
    data: {
      id: crypto.randomUUID(),
      timestamp: nowForDb(),
      action,
      recipientId,
      actorId,
      objectType,
      objectId,
      detail,
      read: false,
    },
  });
}

export interface ListParams {
  page?: number;
  perPage?: number;
  unreadOnly?: boolean;
}

/** 当前用户的通知列表，倒序分页，携带 actor 用户名。 */
export async function listNotifications(userId: string, params: ListParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where = {
    recipientId: userId,
    ...(params.unreadOnly ? { read: false } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        timestamp: true,
        action: true,
        recipientId: true,
        actorId: true,
        objectType: true,
        objectId: true,
        detail: true,
        read: true,
        actor: { select: { id: true, username: true } },
      },
    }),
  ]);

  const notifications = rows.map((n) => ({
    id: n.id,
    timestamp: n.timestamp ? n.timestamp.toISOString() : null,
    action: n.action,
    recipientId: n.recipientId,
    actor: n.actor
      ? { id: n.actor.id, username: n.actor.username }
      : { id: null, username: 'system' },
    object: { type: n.objectType, id: n.objectId },
    detail: n.detail,
    read: n.read,
  }));

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { notifications, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

export type NotificationDTO = Awaited<ReturnType<typeof listNotifications>>['notifications'][number];

/** 未读通知数量。 */
export async function getUnreadCount(userId: string) {
  return prisma.notification.count({ where: { recipientId: userId, read: false } });
}

/** 标记单条为已读（限本人）。返回是否命中。 */
export async function markRead(notificationId: string, userId: string) {
  const res = await prisma.notification.updateMany({
    where: { id: notificationId, recipientId: userId },
    data: { read: true },
  });
  return res.count > 0;
}

/** 标记全部未读为已读，返回标记数量。 */
export async function markAllRead(userId: string) {
  const res = await prisma.notification.updateMany({
    where: { recipientId: userId, read: false },
    data: { read: true },
  });
  return res.count;
}
