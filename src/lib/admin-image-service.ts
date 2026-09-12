// ─────────────────────────────────────────────────────────────────────────────
// admin-image-service.ts — 图床的管理端检索与恢复
//
// 【为什么不用现成的 listAllImages】它写死了 `ignore: false` —— 恰好看不见要恢复
// 的那些行。与剪贴板同一个道理。
//
// 【恢复前先看文件还在不在】软删只翻 ignore 标志位，**不删磁盘文件**。但运维可能手工
// 清理过 instance/images/，或者数据是从别处还原的。此时恢复出来的是一条指向不存在
// 文件的记录 —— 页面上是坏图。所以 getImageForAdmin 带一个 fileExists，
// 让确认屏能在动手之前把这件事摆出来。
//
// 【不提供物理删除】CLAUDE.md：永不物理删除（站长手动例外）。恢复已经覆盖了可逆的
// 那一半；加一个不可逆的 CLI flag 是纯粹的脚枪，收益为零。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import { isOwner } from './auth';
import { logAdminAction, type AdminResult } from './admin-user-service';
import { storagePathFor } from './image-upload';

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

export interface ImageActor {
  id: string;
  role: string;
}

export interface AdminImageListParams {
  page?: number;
  perPage?: number;
  /** 关键词：文件名 / 10 位短 id / 作者用户名。 */
  search?: string | null;
  status?: 'all' | 'active' | 'deleted';
}

export async function listAdminImages(params: AdminImageListParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.ImageHostingWhereInput = {};
  if (params.status === 'active') where.ignore = false;
  else if (params.status === 'deleted') where.ignore = true;

  const q = (params.search ?? '').trim();
  if (q) {
    where.OR = [
      { filename: { contains: q } },
      { id: q }, // 直接粘一个 10 位短 id
      { author: { is: { username: { contains: q } } } },
    ];
  }

  const [total, images] = await Promise.all([
    prisma.imageHosting.count({ where }),
    prisma.imageHosting.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        filename: true,
        fileSize: true,
        mimeType: true,
        authorId: true,
        isPublic: true,
        ignore: true,
        createdAt: true,
        author: { select: { username: true } },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { images, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/** 单条图床记录详情。fileExists 用来在恢复前发现「记录还在、文件没了」。 */
export async function getImageForAdmin(id: string) {
  const image = await prisma.imageHosting.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      fileSize: true,
      mimeType: true,
      authorId: true,
      isPublic: true,
      ignore: true,
      createdAt: true,
      author: { select: { username: true } },
    },
  });
  if (!image) return null;

  let fileExists = false;
  try {
    fileExists = fs.existsSync(storagePathFor(image.id, image.mimeType));
  } catch {
    /* 路径拼接异常一律当作「文件不在」，不要因此让整个命令崩掉 */
  }

  return { ...image, fileExists };
}

/** 权限与软删路径一致：作者本人或站长。 */
function canTouch(imageAuthorId: string, actor: ImageActor): boolean {
  return imageAuthorId === actor.id || isOwner(actor);
}

/** 恢复软删的图床记录（只翻 ignore，不碰磁盘文件）。 */
export async function restoreImage(
  id: string,
  actor: ImageActor,
  reason?: string
): Promise<AdminResult<{ id: string; fileExists: boolean }>> {
  const image = await prisma.imageHosting.findUnique({
    where: { id },
    select: { id: true, authorId: true, ignore: true, mimeType: true },
  });
  if (!image) return { ok: false, code: 404, message: '图片不存在' };
  if (!canTouch(image.authorId, actor)) return { ok: false, code: 403, message: '无权操作该图片' };
  if (!image.ignore) return { ok: false, code: 400, message: '该图片未被删除' };

  await prisma.imageHosting.update({ where: { id }, data: { ignore: false } });

  try {
    await logAdminAction({
      action: 'restore_image',
      adminId: actor.id,
      targetUserId: image.authorId,
      objectType: 'image',
      objectId: id,
      reason: (reason ?? '').trim() || null,
    });
  } catch {
    /* 审计写入失败不影响恢复结果 */
  }

  let fileExists = false;
  try {
    fileExists = fs.existsSync(storagePathFor(image.id, image.mimeType));
  } catch {
    /* 同上 */
  }

  return { ok: true, message: '已恢复图片', id, fileExists };
}
