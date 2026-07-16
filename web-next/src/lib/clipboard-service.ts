// ─────────────────────────────────────────────────────────────────────────────
// clipboard-service.ts — 云剪贴板业务逻辑
//   （对齐 Flask app/web/clipboard/service.py:ClipService）
//
// 纯函数 + 显式参数，与 blog-service 风格一致。软删除：ClipBoard.ignore = true
// 一律排除。ClipBoard 存元信息（title/publicity），ClipText 存正文，一对一分表。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { generateShortId } from './short-id';

// 校验上限，对齐 Flask validator()
export const CLIP_TITLE_MAX = 40;
export const CLIP_CONTENT_MAX = 50000;
// 每用户剪贴板总数上限，对齐 Flask（count > 200 才拒绝，即最多 201 条）
export const CLIP_PER_USER_MAX = 200;

export interface CreateClipInput {
  title: string;
  content: string;
  publicity?: boolean;
}

export type CreateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' };

/**
 * 创建剪贴板（对齐 ClipService.create_clipboard）。
 * 先按 authorId 统计总数（含软删除，与 Flask 一致）；超限返回 limit。
 * 生成 8 位短 ID，写 ClipBoard + ClipText。
 */
export async function createClip(
  authorId: string,
  input: CreateClipInput
): Promise<CreateClipResult> {
  const count = await prisma.clipBoard.count({ where: { authorId } });
  if (count > CLIP_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  const id = generateShortId(8);
  const now = nowForDb();

  await prisma.clipBoard.create({
    data: {
      id,
      title: input.title,
      authorId,
      publicity: input.publicity ?? true,
      ignore: false,
      createdAt: now,
      content: {
        create: { content: input.content, updatedAt: now },
      },
    },
  });

  return { ok: true, id };
}

export interface UpdateClipInput {
  title: string;
  content: string;
  publicity: boolean;
}

export type UpdateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * 编辑剪贴板（对齐 Flask edit 路由 + ClipService.update_clipboard）。
 * - 先取剪贴板并排除软删除（ignore=true）→ not_found（对齐 get_clipboard 的 ignore 检查）。
 * - 权限=作者本人；非作者 → forbidden（对齐 Flask edit：仅作者，无 owner 例外）。
 * - 更新 title/publicity，并 upsert 正文（无 ClipText 记录时新建，对齐 update_clipboard）。
 * - 不改动 ignore，保留软删除语义。
 */
export async function updateClip(
  clipId: string,
  editorId: string,
  input: UpdateClipInput
): Promise<UpdateClipResult> {
  const clip = await prisma.clipBoard.findFirst({
    where: { id: clipId, ignore: false },
    select: { id: true, authorId: true },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== editorId) return { ok: false, reason: 'forbidden' };

  const now = nowForDb();
  await prisma.clipBoard.update({
    where: { id: clipId },
    data: {
      title: input.title,
      publicity: input.publicity,
      content: {
        upsert: {
          create: { content: input.content, updatedAt: now },
          update: { content: input.content, updatedAt: now },
        },
      },
    },
  });

  return { ok: true, id: clipId };
}

export type GetClipResult =
  | { ok: true; clip: ClipDetail }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export interface ClipDetail {
  id: string;
  title: string;
  authorId: string;
  authorName: string | null;
  publicity: boolean;
  content: string;
  createdAt: Date | null;
}

/**
 * 按 id 取剪贴板正文（对齐 ClipService.get_clipboard_with_content + detail 路由的权限）。
 * ignore=true（软删除）→ not_found；私有（publicity=false）且非作者 → forbidden。
 */
export async function getClip(id: string, viewerId?: string): Promise<GetClipResult> {
  const clip = await prisma.clipBoard.findFirst({
    where: { id, ignore: false },
    select: {
      id: true,
      title: true,
      authorId: true,
      publicity: true,
      createdAt: true,
      author: { select: { username: true } },
      content: { select: { content: true } },
    },
  });

  if (!clip) return { ok: false, reason: 'not_found' };

  const isPublic = clip.publicity ?? true;
  if (!isPublic && clip.authorId !== viewerId) {
    return { ok: false, reason: 'forbidden' };
  }

  return {
    ok: true,
    clip: {
      id: clip.id,
      title: clip.title,
      authorId: clip.authorId,
      authorName: clip.author?.username ?? null,
      publicity: isPublic,
      content: clip.content?.content ?? '',
      createdAt: clip.createdAt ?? null,
    },
  };
}

export interface ClipListItem {
  id: string;
  title: string;
  publicity: boolean;
  createdAt: Date | null;
}

/**
 * 列出某用户的剪贴板（对齐 ClipService.get_clipboard_byuserid）。
 * 排除软删除，按 createdAt 倒序。
 */
export async function listUserClips(userId: string): Promise<ClipListItem[]> {
  const rows = await prisma.clipBoard.findMany({
    where: { authorId: userId, ignore: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, publicity: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publicity: r.publicity ?? true,
    createdAt: r.createdAt ?? null,
  }));
}
