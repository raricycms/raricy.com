// ─────────────────────────────────────────────────────────────────────────────
// broadcast-service.ts — 管理员群发通知（对齐 Flask admin_send_notification_to_all）
//
// targetGroup：
//   'all'           → 除发送者外的全部用户
//   'authenticated' → core/admin/owner（认证用户）
//   'normal'        → 仅 role='user'
// 复用 notification-service.sendNotification（force:true 绕过接收者通知偏好）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { isOwner, type SafeUser } from './auth';
import { sendNotification } from './notification-service';

export type TargetGroup = 'all' | 'authenticated' | 'normal';

export interface BroadcastParams {
  actor: SafeUser;
  action?: string;
  detail: string;
  targetGroup?: TargetGroup;
  objectType?: string | null;
  objectId?: string | null;
}

export type BroadcastResult =
  | { ok: true; message: string; sentCount: number; failedCount: number }
  | { ok: false; code: number; message: string };

const BATCH = 200; // 分批发送，避免一次性堆太多 promise

export async function broadcast(p: BroadcastParams): Promise<BroadcastResult> {
  // 站长校验放在 service 层而不只在路由里 —— 对齐 Flask 的纵深防御
  // （notifications.py:321 也在服务层判了 is_owner）。群发能一次触达全站，
  // 是本项目影响面最大的操作，值得两道闸。
  if (!isOwner(p.actor)) return { ok: false, code: 403, message: '没有站长权限' };

  const detail = (p.detail ?? '').trim();
  if (!detail) return { ok: false, code: 400, message: '通知内容不能为空' };

  const group: TargetGroup = p.targetGroup ?? 'all';
  const action = (p.action ?? '').trim() || 'admin';

  let roleWhere: { role?: string | { in: string[] } } = {};
  if (group === 'all') roleWhere = {};
  else if (group === 'authenticated') roleWhere = { role: { in: ['core', 'admin', 'owner'] } };
  else if (group === 'normal') roleWhere = { role: 'user' };
  else return { ok: false, code: 400, message: '无效的目标用户组' };

  const recipients = await prisma.user.findMany({
    where: { ...roleWhere, id: { not: p.actor.id } }, // 排除发送者
    select: { id: true },
  });
  if (recipients.length === 0)
    return { ok: false, code: 400, message: '没有符合条件的用户' };

  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < recipients.length; i += BATCH) {
    const slice = recipients.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      slice.map((u) =>
        sendNotification({
          recipientId: u.id,
          action,
          actorId: p.actor.id,
          objectType: p.objectType ?? null,
          objectId: p.objectId ?? null,
          detail,
          force: true,
        })
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) sentCount += 1;
      else failedCount += 1;
    }
  }

  return {
    ok: true,
    message: `成功发送 ${sentCount} 条通知${failedCount ? `，${failedCount} 条失败` : ''}`,
    sentCount,
    failedCount,
  };
}
