// ─────────────────────────────────────────────────────────────────────────────
// notification-service.ts — 通知业务逻辑（对齐 Flask app/service/notifications.py）
//
// 与 Flask 解耦风格一致：纯函数 + 显式参数。
//   • 列表：recipientId = 当前用户，timestamp 倒序，20/页，带 actor.username。
//   • 未读数 / 标记单条已读 / 全部已读 / 批量已读 / 批量删除。
//   • sendNotification 尊重接收者的 notify_* 偏好（除非 force）——
//     Flask 侧 send_notification 收了 force 参数却从头到尾没查过偏好（已核实
//     app/service/notifications.py），即原站的偏好开关是摆设；判定只散落在少数
//     调用点（如 like_service 的 author.notify_like）。TS 侧真的实现了检查，
//     属**有意的行为改进**（真实库 465 个用户无一关过开关，影响面为零）。
//     映射靠 ACTION_PREF_MAP 精确查表，不做子串嗅探；自由文本调用方显式传 prefKey。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';

const DEFAULT_PER_PAGE = 20;

export type NotifyPrefKey = 'notifyLike' | 'notifyEdit' | 'notifyDelete' | 'notifyAdmin';

/**
 * action 字符串 → 通知偏好字段的**精确映射表**。
 *
 * 【为什么是精确表而不是子串嗅探】旧实现按「like → edit → delete → admin」的顺序
 * 找第一个命中的子串，而 /api/admin/notify-user 与 broadcast 的 action 是管理员
 * **自由输入**的：只要正文里带了「删除」二字，`prefForAction('管理员删除通知')`
 * 就会归到 notifyDelete —— 用户开着「管理员通知」，这条管理员通知却被 delete
 * 偏好吞掉。自由文本 × 子串优先级 = 串扰，只能靠精确表根治。
 *
 * 偏好字段的语义以模型注释为准（app/models/user.py:23-26），四个开关都很窄：
 *   notify_like「文章被点赞通知」/ notify_edit「文章被编辑通知」
 *   notify_delete「文章被删除通知」/ notify_admin「管理员通知」
 * key 取自真实库中实际存在的 action，外加代码里在用但库中暂无的两个（文章编辑、图片删除）。
 */
const ACTION_PREF_MAP: Readonly<Record<string, NotifyPrefKey>> = {
  // ── notify_like ──
  文章点赞: 'notifyLike',
  // ── notify_edit ──
  文章编辑: 'notifyEdit',
  // ── notify_delete ──
  文章删除: 'notifyDelete',
  // 图片删除严格说不是「文章」被删，但四个开关里没有更贴的；站长违规删图的调用点
  // （api/images/admin/[id]）本就传 force:true，落在哪个键上实际不影响送达。
  图片删除: 'notifyDelete',
  // ── notify_admin ──「管理员通知」，含管理动作与站务播报
  禁言通知: 'notifyAdmin',
  解除禁言: 'notifyAdmin',
  系统公告: 'notifyAdmin',
  功能更新: 'notifyAdmin',
  申诉提交: 'notifyAdmin',
  // 下面两条是本次补映射的重点：原先不含任何关键字 → 旧实现返回 null → 关了
  // notifyAdmin 也照发。两者都是「管理类通知」（前者发给管理员，后者是管理决定的回执）。
  申诉结果: 'notifyAdmin',
  栏目发文提醒: 'notifyAdmin',
};

/**
 * 将 action 映射到用户通知偏好字段。**未在表中的 action 返回 null**。
 *
 * 返回 null = 不受偏好拦截、照常发送，这是**有意为之**而非兜底遗漏：
 *   • 评论回复 / 文章评论 —— Flask 与本项目都没有 notify_comment 开关，评论通知一律发；
 *   • 文章投喂 —— 同样无对应开关；
 *   • 管理员自由输入的 action（如「维护通知」「活动通知」）—— 猜不准就不猜，
 *     宁可发出去，也不要被错误归类的偏好静默吞掉。需要受管的调用方应显式传 prefKey。
 *
 * 用 Object.hasOwn 而非直接下标：action 是自由文本，`ACTION_PREF_MAP['constructor']`
 * 会顺着原型链摸到 Object.prototype.constructor（一个函数，truthy），
 * 让 prefForAction 返回个非法值。只认自有属性。
 */
export function prefForAction(action: string): NotifyPrefKey | null {
  return Object.hasOwn(ACTION_PREF_MAP, action) ? ACTION_PREF_MAP[action] : null;
}

export interface SendNotificationInput {
  recipientId: string;
  action: string;
  actorId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  detail?: string | null;
  force?: boolean;
  /**
   * 显式指定本条通知受哪个偏好开关管辖，**优先于 ACTION_PREF_MAP 的查表结果**。
   * 用于 action 是自由文本、查表必然猜不准的调用点（如管理员定向通知一律 notifyAdmin）。
   * 传 null = 显式声明「不受任何偏好拦截」。不传 = 按 action 查表。
   */
  prefKey?: NotifyPrefKey | null;
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
    // 调用方显式传了 prefKey（含 null）就以它为准，不再靠 action 猜。
    const prefKey = input.prefKey !== undefined ? input.prefKey : prefForAction(action);
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

/**
 * 批量标记为已读（限本人），返回命中条数。
 * 对齐 Flask batch_mark_notifications_read：过滤条件只有 id IN (...) + recipient_id，
 * **不带 read=False**，所以已读的条目也会被计入 count（命中即算，非「本次真正翻转的条数」）。
 * recipientId 是越权防线：别人的通知 id 混进来只会匹配不到，不会被改。
 */
export async function batchMarkRead(notificationIds: string[], userId: string) {
  if (!notificationIds.length) return 0;
  const res = await prisma.notification.updateMany({
    where: { id: { in: notificationIds }, recipientId: userId },
    data: { read: true },
  });
  return res.count;
}

/**
 * 批量删除（限本人），返回删除条数。硬删除，对齐 Flask batch_delete_notifications。
 * 同上：recipientId 过滤挡住越权删除别人通知。
 */
export async function batchDelete(notificationIds: string[], userId: string) {
  if (!notificationIds.length) return 0;
  const res = await prisma.notification.deleteMany({
    where: { id: { in: notificationIds }, recipientId: userId },
  });
  return res.count;
}
