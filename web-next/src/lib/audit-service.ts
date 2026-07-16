// ─────────────────────────────────────────────────────────────────────────────
// audit-service.ts — 管理审计公示 + 申诉（对齐 Flask app/service/audit_log.py）
//
// 纯函数 + 显式参数，与 Flask 解耦风格一致。
//   • listPublicLogs：仅 visibility='public'、近 30 天、最新在前、分页；带管理员/目标
//     用户名与“是否有待处理申诉”标记。extra 是 String? 列存原始 JSON 文本，需 guarded 解析。
//   • createAppeal：镜像 Flask 的校验/频控（accepted 拦截、20/日、同日志同人 pending 唯一）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';

const PER_PAGE = 20;
const WINDOW_DAYS = 30; // 对齐 Flask：仅公示近 30 天
const APPEAL_MAX_LEN = 2000;
const APPEAL_DAILY_LIMIT = 20;

/** guarded JSON.parse：extra 是可空的原始 JSON 文本列，解析失败一律回退为 {}。 */
export function parseExtra(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface ListLogsParams {
  page?: number;
  action?: string | null;
}

/** 公示日志分页列表（对齐 list_public_logs：public + 近 30 天 + 最新在前）。 */
export async function listPublicLogs(params: ListLogsParams) {
  const page = Math.max(1, params.page ?? 1);
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const where: Prisma.AdminActionLogWhereInput = {
    visibility: 'public',
    createdAt: { gte: cutoff },
  };
  if (params.action) where.action = params.action;

  const [total, rows] = await Promise.all([
    prisma.adminActionLog.count({ where }),
    prisma.adminActionLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
      select: {
        id: true,
        createdAt: true,
        action: true,
        adminId: true,
        targetUserId: true,
        objectType: true,
        objectId: true,
        reason: true,
        // 注意：不在此 select `extra`。该列在 SQLite 里声明类型是 JSON，
        // Prisma 的 SQLite 连接器在驱动层拒绝读取（"Value JSON not supported"），
        // 即使 schema 里映射成 String 也一样。改为下方用 raw + CAST(extra AS TEXT) 单独取。
        visibility: true,
        admin: { select: { username: true } },
        targetUser: { select: { username: true } },
      },
    }),
  ]);

  // 待处理申诉标记：一次查询，映射 logId -> true（对齐 Flask has_pending）
  const logIds = rows.map((r) => r.id);

  // 单独取 extra（用 CAST 绕过 JSON 列的驱动层转换问题）；生产库同样适用
  const extraMap = new Map<number, string | null>();
  if (logIds.length) {
    const idList = logIds.filter((n) => Number.isInteger(n)).join(',');
    const extraRows = (await prisma.$queryRawUnsafe(
      `SELECT id, CAST(extra AS TEXT) AS extra FROM admin_action_logs WHERE id IN (${idList})`
    )) as Array<{ id: number; extra: string | null }>;
    for (const er of extraRows) extraMap.set(Number(er.id), er.extra);
  }
  const pending = logIds.length
    ? await prisma.adminActionAppeal.findMany({
        where: { logId: { in: logIds }, status: 'pending' },
        select: { logId: true },
      })
    : [];
  const hasPending = new Set(pending.map((p) => p.logId));

  const items = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    action: r.action,
    admin: { id: r.adminId, username: r.admin?.username ?? null },
    targetUser: r.targetUserId
      ? { id: r.targetUserId, username: r.targetUser?.username ?? null }
      : null,
    object: r.objectType || r.objectId ? { type: r.objectType, id: r.objectId } : null,
    reason: r.reason,
    extra: parseExtra(extraMap.get(r.id)),
    visibility: r.visibility,
    hasPendingAppeal: hasPending.has(r.id),
  }));

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  return { items, total, page, perPage: PER_PAGE, pages, hasPrev: page > 1, hasNext: page < pages };
}

export type AppealResult =
  | { ok: true; message: string; appealId: number }
  | { ok: false; message: string; appealId: null };

/**
 * 提交申诉（对齐 create_appeal）：
 *   1. 内容非空、≤2000 字
 *   2. 该日志已有 accepted 申诉 → 拒绝
 *   3. 当日申诉数 ≥ 20 → 拒绝
 *   4. 同日志 + 同申诉人已存在 pending → 拒绝
 * 通过则创建 status='pending'。
 */
export async function createAppeal(params: {
  logId: number;
  appellantId: string;
  content: string;
}): Promise<AppealResult> {
  const content = (params.content || '').trim();
  if (!content) return { ok: false, message: '申诉内容不能为空', appealId: null };
  if (content.length > APPEAL_MAX_LEN)
    return { ok: false, message: '申诉内容过长（最多2000字）', appealId: null };

  // 日志必须存在
  const log = await prisma.adminActionLog.findUnique({
    where: { id: params.logId },
    select: { id: true },
  });
  if (!log) return { ok: false, message: '日志不存在', appealId: null };

  const acceptedExists = await prisma.adminActionAppeal.findFirst({
    where: { logId: params.logId, status: 'accepted' },
    select: { id: true },
  });
  if (acceptedExists)
    return { ok: false, message: '该操作申诉已被通过，无法再次申诉', appealId: null };

  // 当日频控：一个用户每天最多 20 次（含任意操作）
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await prisma.adminActionAppeal.count({
    where: { appellantId: params.appellantId, createdAt: { gte: startOfDay } },
  });
  if (todayCount >= APPEAL_DAILY_LIMIT)
    return { ok: false, message: '今日申诉次数已达上限（20次）', appealId: null };

  const existsPending = await prisma.adminActionAppeal.findFirst({
    where: { logId: params.logId, appellantId: params.appellantId, status: 'pending' },
    select: { id: true },
  });
  if (existsPending)
    return { ok: false, message: '该日志已存在你提交的待处理申诉', appealId: null };

  const now = new Date();
  const appeal = await prisma.adminActionAppeal.create({
    data: {
      logId: params.logId,
      appellantId: params.appellantId,
      content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });

  // 注：Flask 侧此处会给站长发通知；迁移期通知发送仍走 Flask，故此处从略。
  return { ok: true, message: '申诉已提交', appealId: appeal.id };
}
