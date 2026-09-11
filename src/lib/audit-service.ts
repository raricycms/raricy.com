// ─────────────────────────────────────────────────────────────────────────────
// audit-service.ts — 管理审计公示 + 申诉（对齐 Flask app/service/audit_log.py）
//
// 纯函数 + 显式参数，与 Flask 解耦风格一致。
//   • listPublicLogs：仅 visibility='public'、近 30 天、最新在前、分页；带管理员/目标
//     用户名与“是否有待处理申诉”标记。extra 是 String? 列存原始 JSON 文本，需 guarded 解析。
//   • createAppeal：镜像 Flask 的校验/频控（accepted 拦截、20/日、同日志同人 pending 唯一）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb, dayStart, todayStr } from './db-time';
import { sendNotification } from './notification-service';
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

export interface LogDetail {
  id: number;
  action: string;
  createdAt: Date | null;
  adminId: string | null;
  adminName: string | null;
  objectType: string | null;
  objectId: string | null;
  targetUserId: string | null;
  targetUserName: string | null;
  reason: string | null;
  appeals: {
    id: number;
    content: string;
    status: string;
    decision: string | null;
    createdAt: Date | null;
    appellantId: string;
    appellantName: string | null;
  }[];
}

/**
 * 单条公示日志 + 其全部申诉（承载 /audit/[id] 详情页）。
 *
 * ⚠️【有意偏离 Flask】Flask 的 get_log 是 get_or_404(log_id)，**不过滤 visibility** ——
 * 于是列表只公示 public，详情页却让任何 core 用户猜个 ID 就能看到内部日志。
 * 这里加上 visibility='public'：/audit 的定位就是「管理员操作日志公示」，
 * 非公示日志不该从公示页读出来。
 *
 * 当前真实库里 1391 条日志全部是 public，所以这个差异在今天是空谈、无行为变化；
 * 加它是为了将来真出现内部日志时不泄露。
 *
 * 不套用列表那 30 天的时间窗：那个窗是「公示只列近期」的展示策略，
 * 对已知 ID 的单条查询没有安全意义，套上反而会让老日志无法申诉。
 *
 * @returns null 表示不存在或不可公示（页面据此 notFound）
 */
export async function getLogDetail(logId: number): Promise<LogDetail | null> {
  const log = await prisma.adminActionLog.findFirst({
    where: { id: logId, visibility: 'public' },
    select: {
      id: true,
      action: true,
      createdAt: true,
      adminId: true,
      objectType: true,
      objectId: true,
      targetUserId: true,
      reason: true,
      admin: { select: { username: true } },
      targetUser: { select: { username: true } },
      appeals: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          content: true,
          status: true,
          decision: true,
          createdAt: true,
          appellantId: true,
          appellant: { select: { username: true } },
        },
      },
    },
  });
  if (!log) return null;

  return {
    id: log.id,
    action: log.action,
    createdAt: log.createdAt,
    adminId: log.adminId,
    adminName: log.admin?.username ?? null,
    objectType: log.objectType,
    objectId: log.objectId,
    targetUserId: log.targetUserId,
    targetUserName: log.targetUser?.username ?? null,
    reason: log.reason,
    appeals: log.appeals.map((a) => ({
      id: a.id,
      content: a.content,
      status: a.status,
      decision: a.decision,
      createdAt: a.createdAt,
      appellantId: a.appellantId,
      appellantName: a.appellant?.username ?? null,
    })),
  };
}

/** 公示日志分页列表（对齐 list_public_logs：public + 近 30 天 + 最新在前）。 */
export async function listPublicLogs(params: ListLogsParams) {
  const page = Math.max(1, params.page ?? 1);
  // 窗口起点与写入 createdAt 同口径（nowForDb，UTC+8 墙上时间贴 Z）——
  // 用真实 Date.now() 会把窗口拉成「30 天 + 8 小时」。同文件当日频控见下方注释。
  const cutoff = new Date(nowForDb().getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

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

// ── 管理端日志检索（运维 CLF 用）────────────────────────────────────────────

export interface ListAdminLogsParams {
  page?: number;
  perPage?: number;
  action?: string | null;
  /** 按执行者用户名模糊筛选。 */
  adminUsername?: string | null;
  /** 按被处理用户用户名模糊筛选。 */
  targetUsername?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  /** 默认 'all' —— 运维要看得见 visibility 非 public 的内部日志。 */
  visibility?: 'all' | 'public' | 'internal';
  since?: Date | null;
  until?: Date | null;
}

/**
 * 管理端审计日志检索。
 *
 * 与 listPublicLogs 的两处**刻意差异**：
 *   1. 不强制 `visibility: 'public'` —— 公示页只该看到公开日志，运维要看到全部
 *   2. 不设 30 天窗口 —— 排查陈年问题要能翻到任意久之前
 *
 * 未变的（也别改）：`extra` 那列是 SQLite 声明为 JSON 的列，Prisma 驱动层拒读，
 * 必须走下面这段 raw + CAST 的绕行。这是本文件最容易悄悄坏掉的地方 ——
 * 直接把 `extra` 加进 select 会在**运行时**抛 "Value JSON not supported"，
 * tsc 与构建都不报。
 */
export async function listAdminLogs(params: ListAdminLogsParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? PER_PAGE));

  const where: Prisma.AdminActionLogWhereInput = {};
  if (params.visibility === 'public') where.visibility = 'public';
  else if (params.visibility === 'internal') where.visibility = { not: 'public' };
  // 'all' / 未指定：不过滤 visibility

  if (params.action) where.action = params.action;
  if (params.objectType) where.objectType = params.objectType;
  if (params.objectId) where.objectId = params.objectId;
  if (params.adminUsername) where.admin = { is: { username: { contains: params.adminUsername } } };
  if (params.targetUsername) {
    where.targetUser = { is: { username: { contains: params.targetUsername } } };
  }
  if (params.since || params.until) {
    where.createdAt = {
      ...(params.since ? { gte: params.since } : {}),
      ...(params.until ? { lte: params.until } : {}),
    };
  }

  const [total, rows] = await Promise.all([
    prisma.adminActionLog.count({ where }),
    prisma.adminActionLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        createdAt: true,
        action: true,
        adminId: true,
        targetUserId: true,
        objectType: true,
        objectId: true,
        reason: true,
        visibility: true,
        admin: { select: { username: true } },
        targetUser: { select: { username: true } },
        // 同 listPublicLogs：**不 select extra**，见上方说明
      },
    }),
  ]);

  const logIds = rows.map((r) => r.id);
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

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { items, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
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
 * 通过则创建 status='pending'，并给所有 owner 发『申诉提交』通知（失败不影响申诉）。
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
    select: { id: true, targetUserId: true },
  });
  if (!log) return { ok: false, message: '日志不存在', appealId: null };

  // ★ 只有被操作的目标用户本人能申诉 ★
  // 日志 id 是公开的（/api/audit 列表里就有），若不校验，任何 core 用户都能替
  // 别人提交申诉；一旦站长通过，等于第三方替他人解除了封禁 / 恢复了已删内容。
  // targetUserId 为 null 的日志（如删栏目）没有「当事人」，一律不可申诉。
  if (log.targetUserId !== params.appellantId) {
    return { ok: false, message: '只能对针对自己的操作记录申诉', appealId: null };
  }

  const acceptedExists = await prisma.adminActionAppeal.findFirst({
    where: { logId: params.logId, status: 'accepted' },
    select: { id: true },
  });
  if (acceptedExists)
    return { ok: false, message: '该操作申诉已被通过，无法再次申诉', appealId: null };

  // 当日频控：一个用户每天最多 20 次（含任意操作）。
  // 窗口起点必须与写入 createdAt 用的时钟同口径 —— createdAt 走 nowForDb()（UTC+8 墙上时间），
  // 若这里用 new Date()+setHours(0,0,0,0)（真实本地午夜），两者差 8h，会把前一天 16:00
  // 之后的申诉误计进今日额度。见 src/lib/db-time.ts。
  const startOfDay = dayStart(todayStr());
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

  const now = nowForDb();
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

  // 通知站长（对齐 Flask create_appeal：给所有 owner 各发一条『申诉提交』）。
  // 与评论/点赞同口径：通知失败不影响申诉本身，吞掉即可 —— 申诉已经落库，
  // 站长在 /audit 列表里照样看得到。
  try {
    const owners = await prisma.user.findMany({
      where: { role: 'owner' },
      select: { id: true },
    });
    await Promise.all(
      owners.map((o) =>
        sendNotification({
          recipientId: o.id,
          action: '申诉提交',
          actorId: params.appellantId,
          objectType: 'admin_action_log',
          objectId: String(params.logId),
          detail: '有新的操作日志申诉等待处理',
        })
      )
    );
  } catch (e) {
    console.warn(`[audit-service] 申诉已提交但通知站长失败（logId=${params.logId}）:`, e);
  }

  return { ok: true, message: '申诉已提交', appealId: appeal.id };
}
