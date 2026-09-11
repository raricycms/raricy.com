// ─────────────────────────────────────────────────────────────────────────────
// admin-clipboard-service.ts — 云剪贴板的管理端检索与恢复（**含已软删 / 已隐藏**）
//
// 【为什么要单独一套】clipboard-service 的 getClip / listUserClips 都带
// `ignore: false`，也就是说它**恰好看不见要恢复的那些行**。管理端需要另一套读取。
//
// 【列表绝不取正文】ClipText.content 上限 5 万字（CLIP_CONTENT_MAX），一页 20 行
// 就是接近一兆的载荷。列表只给标题 + 元信息，正文走 getClipForAdmin 单条取。
// 那条约束由 tests/service/admin-clipboard-service.test.ts 盯着。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import { isOwner } from './auth';
import { logAdminAction, type AdminResult } from './admin-user-service';
import { deleteClip } from './clipboard-service';

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

/** 管理端操作的执行者。与 comment-service 的 DeleteActor 同形。 */
export interface ClipActor {
  id: string;
  role: string;
}

export interface AdminClipListParams {
  page?: number;
  perPage?: number;
  /** 关键词：匹配标题 / id / 作者用户名 / **正文**（正文走关联表）。 */
  search?: string | null;
  status?: 'all' | 'active' | 'deleted';
  /** 可见性。private = publicity:false（仅作者与站长可见）。 */
  publicity?: 'all' | 'public' | 'private';
}

export async function listAdminClips(params: AdminClipListParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.ClipBoardWhereInput = {};
  if (params.status === 'active') where.ignore = false;
  else if (params.status === 'deleted') where.ignore = true;

  if (params.publicity === 'public') where.publicity = true;
  else if (params.publicity === 'private') where.publicity = false;

  const q = (params.search ?? '').trim();
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { id: q }, // 直接粘一个 8 位短 id
      { author: { is: { username: { contains: q } } } },
      { content: { is: { content: { contains: q } } } },
    ];
  }

  const [total, clips] = await Promise.all([
    prisma.clipBoard.count({ where }),
    prisma.clipBoard.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      // ★ 不取 content —— 见文件头
      select: {
        id: true,
        title: true,
        authorId: true,
        publicity: true,
        ignore: true,
        createdAt: true,
        author: { select: { username: true } },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { clips, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/** 单条剪贴板详情（含正文）。不过滤 ignore —— 要恢复的正是被删的那些。 */
export async function getClipForAdmin(clipId: string) {
  return prisma.clipBoard.findUnique({
    where: { id: clipId },
    select: {
      id: true,
      title: true,
      authorId: true,
      publicity: true,
      ignore: true,
      createdAt: true,
      author: { select: { username: true } },
      content: { select: { content: true, updatedAt: true } },
    },
  });
}

/** 权限与 clipboard-service.deleteClip 一致：作者本人或站长。 */
function canTouch(clipAuthorId: string, actor: ClipActor): boolean {
  return clipAuthorId === actor.id || isOwner(actor);
}

/** 恢复软删的剪贴板。**不过滤 ignore**（这正是它与 getClip 的区别）。 */
export async function restoreClip(
  clipId: string,
  actor: ClipActor,
  reason?: string
): Promise<AdminResult<{ id: string }>> {
  const clip = await prisma.clipBoard.findUnique({
    where: { id: clipId },
    select: { id: true, authorId: true, ignore: true },
  });
  if (!clip) return { ok: false, code: 404, message: '剪贴板不存在' };
  if (!canTouch(clip.authorId, actor)) return { ok: false, code: 403, message: '无权操作该剪贴板' };
  if (!clip.ignore) return { ok: false, code: 400, message: '该剪贴板未被删除' };

  await prisma.clipBoard.update({ where: { id: clipId }, data: { ignore: false } });

  try {
    await logAdminAction({
      action: 'restore_clip',
      adminId: actor.id,
      targetUserId: clip.authorId,
      objectType: 'clipboard',
      objectId: clipId,
      reason: (reason ?? '').trim() || null,
    });
  } catch {
    /* 审计写入失败不影响恢复结果（与软删路径同一口径） */
  }

  return { ok: true, message: '已恢复剪贴板', id: clipId };
}

/**
 * 软删剪贴板。
 *
 * 注意：网页端的 deleteClip **不写审计日志**，所以这是第一条「有审计的剪贴板删除」。
 * 属于新增能力而非对齐 —— 变更本身落库口径与网页完全一致（复用同一个 deleteClip，
 * 权限判断也走它）。
 */
export async function softDeleteClip(
  clipId: string,
  actor: ClipActor,
  reason: string
): Promise<AdminResult<{ id: string }>> {
  // 先取作者（审计日志要用），再走 deleteClip —— 它自带权限判断与
  // 「已删的找不到」语义，不重复实现一份。
  const clip = await prisma.clipBoard.findUnique({
    where: { id: clipId },
    select: { authorId: true },
  });

  const r = await deleteClip(clipId, actor.id, isOwner(actor));
  if (!r.ok) {
    return r.reason === 'not_found'
      ? { ok: false, code: 404, message: '剪贴板不存在或已被删除' }
      : { ok: false, code: 403, message: '无权删除该剪贴板' };
  }

  try {
    await logAdminAction({
      action: 'delete_clip',
      adminId: actor.id,
      targetUserId: clip?.authorId ?? null,
      objectType: 'clipboard',
      objectId: clipId,
      reason: reason.trim() || null,
    });
  } catch {
    /* 审计写入失败不影响删除结果 */
  }

  return { ok: true, message: '已删除剪贴板', id: clipId };
}
