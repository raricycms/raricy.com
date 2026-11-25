// ─────────────────────────────────────────────────────────────────────────────
// clipboard-service.ts — 云剪贴板业务逻辑
//
// 纯函数 + 显式参数，与 blog-service 风格一致。软删除：ClipBoard.ignore = true
// 一律排除。ClipBoard 存元信息（title/publicity），ClipText 存正文，一对一分表。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { generateShortId } from './short-id';
import {
  CONTENT_WRITE_ERROR_CODES,
  parseContentFormat,
} from './content-format';
import type { ContentWriteErrorCode } from './content-format';
import { validateContentForPublish } from './reactive/publish';

// 校验上限：标题/正文的上限住在零依赖的 clipboard-limits.ts（客户端表单也要用），
// 这里转出保持既有 import 不变；只给本服务用的上限留在本文件。
export { CLIP_TITLE_MAX, CLIP_CONTENT_MAX } from './clipboard-limits';
import { CLIP_CONTENT_MAX, CLIP_TITLE_MAX } from './clipboard-limits';
// 每用户剪贴板总数上限：count >= 200 时拒绝，即**最多 200 条**。
// ⚠️ 边界是有意的：写成 `count > 200 才拒绝` 会实际放行到 201 条，
//    与站内文案「一个用户只能发布200篇云剪贴板！」对不上。这里就是真正的 200。
export const CLIP_PER_USER_MAX = 200;

/** 正文写入闸门的失败原因（与 blog-service 同形，但两域各自设防）。 */
export type ClipContentWriteFailure = 'invalid_format' | 'reactive_invalid';

/**
 * 请求里那个**已废弃**的 `format` 值只校验白名单、不参与存储（与博客同口径）：
 * 正文格式由正文自己决定。保留白名单是为了「拼错的值回 400」，不是静默接受。
 */
export type ClipContentWriteGate = { ok: true } | { ok: false; reason: ClipContentWriteFailure };

/** 剪贴板正文写入前的请求侧检查（只看废弃字段合不合法）。 */
export function checkRequestedClipFormat(requested: unknown): ClipContentWriteGate {
  if (requested === undefined) return { ok: true };
  return parseContentFormat(requested) === null
    ? { ok: false, reason: 'invalid_format' }
    : { ok: true };
}

/** 写入闸门失败时的对外文案（route 层直接用它，避免两处措辞漂移）。 */
export function clipContentWriteMessage(reason: ClipContentWriteFailure): string {
  if (reason === 'invalid_format') return '内容格式取值不合法，可选：markdown / reactive';
  return '正文无法编译渲染，已拒绝发布';
}

export function clipContentWriteErrorCode(reason: ClipContentWriteFailure): ContentWriteErrorCode {
  return CONTENT_WRITE_ERROR_CODES[reason];
}

export interface CreateClipInput {
  title: string;
  content: string;
  publicity?: boolean;
}

/** 长度校验失败的原因，与 route 层的 'title too long' / 'content too long' 一一对应。 */
export type ClipLengthReason = 'title_too_long' | 'content_too_long';

export type CreateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' | ClipLengthReason | ClipContentWriteFailure };

/**
 * 标题 / 正文长度校验。
 * 合法返回 null，否则返回失败原因。空标题与超长标题同属 title_too_long 一条分支
 * （len<1 与 len>40 走同一个 'title too long'，前端文案与此一一对应）。
 */
function validateClipLength(title: string, content: string): ClipLengthReason | null {
  if (content.length > CLIP_CONTENT_MAX) return 'content_too_long';
  if (title.length < 1 || title.length > CLIP_TITLE_MAX) return 'title_too_long';
  return null;
}

/**
 * 创建剪贴板。
 * 先校验长度（route 层也校验，但 service 自己必须设防：任何绕过 route 的调用方
 * 都不该能写超长数据）；再按 authorId 统计总数（含软删除 —— 这个上限管的是
 * 「这个人名下有多少行」，不是「有效几条」），超限返回 limit。
 * 最后生成 8 位短 ID，写 ClipBoard + ClipText。
 */
export async function createClip(
  authorId: string,
  input: CreateClipInput
): Promise<CreateClipResult> {
  const lengthErr = validateClipLength(input.title, input.content);
  if (lengthErr) return { ok: false, reason: lengthErr };

  const count = await prisma.clipBoard.count({ where: { authorId } });
  if (count >= CLIP_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  const id = generateShortId(8);
  const now = nowForDb();

  // 保存前保留既有语法检查；数据库仅写原文和必要元数据。
  // 正文里有没有增强语法全由这次编译判定（syntax_version），不再接受调用方声明。
  const validation = await validateContentForPublish({ content: input.content });
  if (!validation.ok) {
    return { ok: false, reason: 'reactive_invalid' };
  }
  const syntaxVersion = validation.syntaxVersion;

  await prisma.$transaction([
    prisma.clipBoard.create({
      data: {
        id,
        title: input.title,
        authorId,
        publicity: input.publicity ?? true,
        ignore: false,
        createdAt: now,
        content: {
          create: {
            content: input.content,
            syntaxVersion,
            updatedAt: now,
          },
        },
      },
    }),
  ]);

  return { ok: true, id };
}

export interface UpdateClipInput {
  title: string;
  content: string;
  publicity: boolean;
}

export type UpdateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'forbidden' | ClipLengthReason | ClipContentWriteFailure };

/**
 * 编辑剪贴板。
 * - 先校验长度（与 route 层同一套规则，service 自己也设防，见 createClip 的说明）。
 * - 再取剪贴板并排除软删除（ignore=true）→ not_found。
 * - 权限=作者本人；非作者 → forbidden（**无站长例外** —— 站长能删任何人的，
 *   但不能替别人改内容）。
 * - 更新 title/publicity，并 upsert 正文（无 ClipText 记录时新建）。
 * - 不改动 ignore，保留软删除语义。
 */
export async function updateClip(
  clipId: string,
  editorId: string,
  input: UpdateClipInput
): Promise<UpdateClipResult> {
  const lengthErr = validateClipLength(input.title, input.content);
  if (lengthErr) return { ok: false, reason: lengthErr };

  const clip = await prisma.clipBoard.findFirst({
    where: { id: clipId, ignore: false },
    // content / syntaxVersion 用来判断要不要重新编译正文（只改标题时不必重编）。
    select: {
      id: true,
      authorId: true,
      content: { select: { content: true, syntaxVersion: true } },
    },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== editorId) return { ok: false, reason: 'forbidden' };

  const oldContent = clip.content?.content ?? '';
  const validation =
    !clip.content || oldContent !== input.content
      ? await validateContentForPublish({ content: input.content })
      : null;
  if (validation && !validation.ok) {
    return { ok: false, reason: 'reactive_invalid' };
  }
  // 正文没变时沿用库里的版本；变了就按本次编译结果重写（可能从增强语法退回纯 Markdown）。
  const syntaxVersion = validation ? validation.syntaxVersion : clip.content?.syntaxVersion ?? null;

  const now = nowForDb();
  await prisma.$transaction([
    prisma.clipBoard.update({
      where: { id: clipId },
      data: {
        title: input.title,
        publicity: input.publicity,
        content: {
          upsert: {
            create: {
              content: input.content,
              syntaxVersion,
              updatedAt: now,
            },
            update: {
              content: input.content,
              syntaxVersion,
              updatedAt: now,
            },
          },
        },
      },
    }),

  ]);

  return { ok: true, id: clipId };
}

export type DeleteClipResult = { ok: true } | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * 软删除剪贴板。
 * - 取剪贴板并排除软删除（ignore=true）→ not_found。
 * - 权限=作者本人或站长（站长可删任何人的 —— 比编辑宽一档，见 updateClip）。
 * - 仅把 ignore 置 true，数据保留，站长可恢复。
 */
export async function deleteClip(
  clipId: string,
  actorId: string,
  actorIsOwner: boolean
): Promise<DeleteClipResult> {
  const clip = await prisma.clipBoard.findFirst({
    where: { id: clipId, ignore: false },
    select: { id: true, authorId: true },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== actorId && !actorIsOwner) return { ok: false, reason: 'forbidden' };

  await prisma.clipBoard.update({
    where: { id: clipId },
    data: { ignore: true },
  });

  return { ok: true };
}

export interface ClipListItem {
  id: string;
  title: string;
  publicity: boolean;
  createdAt: Date | null;
}

/**
 * 列出某用户的剪贴板。
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
