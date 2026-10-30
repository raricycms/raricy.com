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
  DEFAULT_CONTENT_FORMAT,
  parseContentFormat,
  resolveContentWriteFormat,
} from './content-format';
import type { ContentFormat } from './content-format';
import type { ExternalClipData } from './reactive/ref-types';
import { buildReactiveSnapshotForWrite } from './reactive/publish';
import { createHash } from 'node:crypto';

// 校验上限
export const CLIP_TITLE_MAX = 40;
export const CLIP_CONTENT_MAX = 50000;
// 每用户剪贴板总数上限：count >= 200 时拒绝，即**最多 200 条**。
// ⚠️ 边界是有意的：写成 `count > 200 才拒绝` 会实际放行到 201 条，
//    与站内文案「一个用户只能发布200篇云剪贴板！」对不上。这里就是真正的 200。
export const CLIP_PER_USER_MAX = 200;

/** 正文写入闸门的失败原因（与 blog-service 同形，但两域各自设防）。 */
export type ClipContentWriteFailure = 'invalid_format' | 'reactive_invalid';

export type ClipContentWriteGate =
  | { ok: true; format: ContentFormat }
  | { ok: false; reason: ClipContentWriteFailure };

/**
 * 剪贴板正文的**唯一写入闸门**（createClip / updateClip / 两条写接口都调它）。
 *
 * 与博客侧逐条一致（见 blog-service.resolveBlogContentFormat）：省略 = 保留原值
 * （新建默认 markdown）；非法请求值 / 未知存量值 → 拒绝。
 *
 * reactive 能不能发布不在这里判：它要编译并生成同版本快照，见 createClip / updateClip。
 */
export function resolveClipContentFormat(
  requested: unknown,
  stored: unknown = undefined
): ClipContentWriteGate {
  const current =
    stored === undefined ? DEFAULT_CONTENT_FORMAT : parseContentFormat(stored);
  if (current === null) return { ok: false, reason: 'invalid_format' };
  return resolveContentWriteFormat(requested, current);
}

/** 写入闸门失败时的对外文案（route 层直接用它，避免两处措辞漂移）。 */
export function clipContentWriteMessage(reason: ClipContentWriteFailure): string {
  return reason === 'invalid_format'
    ? '内容格式取值不合法，可选：markdown / reactive'
    : 'ReactiveMD 正文无法编译，已拒绝发布';
}

export interface CreateClipInput {
  title: string;
  content: string;
  publicity?: boolean;
  /**
   * 正文格式。`unknown` 而不是 `ContentFormat`：service 自己必须校验任何绕过 route
   * 的调用方（同长度校验的理由）。缺省 = 新建默认 markdown。
   */
  format?: unknown;
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

  // 写入闸门放在查库之前：非法 / reactive 请求连配额都不该消耗。
  const write = resolveClipContentFormat(input.format);
  if (!write.ok) return { ok: false, reason: write.reason };

  const count = await prisma.clipBoard.count({ where: { authorId } });
  if (count >= CLIP_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  const id = generateShortId(8);
  const now = nowForDb();

  // reactive：先编译并生成同版本快照；编不出来就整笔拒绝（不落半篇）。
  const snapshot =
    write.format === 'reactive'
      ? await buildReactiveSnapshotForWrite({ kind: 'clipboard', contentId: id, content: input.content })
      : null;
  if (snapshot && !snapshot.ok) return { ok: false, reason: 'reactive_invalid' };
  const syntaxVersion = snapshot && snapshot.ok ? snapshot.syntaxVersion : null;

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
            format: write.format,
            syntaxVersion,
            updatedAt: now,
          },
        },
      },
    }),
    ...(snapshot && snapshot.ok
      ? [prisma.reactiveSnapshot.create({ data: snapshot.row })]
      : []),
  ]);

  return { ok: true, id };
}

export interface UpdateClipInput {
  title: string;
  content: string;
  publicity: boolean;
  /** 与 CreateClipInput.format 同：unknown 由 service 自己校验；省略 = 保留原格式。 */
  format?: unknown;
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
    // content.format 是写入闸门的当前值；content / syntaxVersion 用来判断要不要
    // 重新生成同版本快照（只改标题时不必重编）。
    select: {
      id: true,
      authorId: true,
      content: { select: { format: true, content: true, syntaxVersion: true } },
    },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== editorId) return { ok: false, reason: 'forbidden' };

  const write = resolveClipContentFormat(input.format, clip.content?.format);
  if (!write.ok) return { ok: false, reason: write.reason };

  const oldContent = clip.content?.content ?? '';
  const oldFormat = clip.content ? parseContentFormat(clip.content.format) : null;
  const snapshot =
    write.format === 'reactive' && (oldFormat !== 'reactive' || oldContent !== input.content)
      ? await buildReactiveSnapshotForWrite({
          kind: 'clipboard',
          contentId: clipId,
          content: input.content,
        })
      : null;
  if (snapshot && !snapshot.ok) return { ok: false, reason: 'reactive_invalid' };
  const syntaxVersion =
    write.format === 'reactive'
      ? snapshot && snapshot.ok
        ? snapshot.syntaxVersion
        : clip.content?.syntaxVersion ?? null
      : null;

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
              format: write.format,
              syntaxVersion,
              updatedAt: now,
            },
            update: {
              content: input.content,
              format: write.format,
              syntaxVersion,
              updatedAt: now,
            },
          },
        },
      },
    }),
    ...(snapshot && snapshot.ok
      ? [
          prisma.reactiveSnapshot.upsert({
            where: {
              uq_reactive_snapshot_version: {
                kind: 'clipboard',
                contentId: clipId,
                contentVersion: snapshot.contentVersion,
              },
            },
            create: snapshot.row,
            update: {
              format: snapshot.row.format,
              scope: snapshot.row.scope,
              syntaxVersion: snapshot.row.syntaxVersion,
              compilerVersion: snapshot.row.compilerVersion,
              adapterVersion: snapshot.row.adapterVersion,
              optionsKey: snapshot.row.optionsKey,
              documentJson: snapshot.row.documentJson,
              hostDataJson: snapshot.row.hostDataJson,
              digest: snapshot.row.digest,
              generatedAt: snapshot.row.generatedAt,
            },
          }),
        ]
      : []),
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
  /**
   * 正文格式。**null = 库里的值不认识**（或正文行缺失）—— 绝不猜成 markdown：
   * 猜错等于把另一种语言的源码交给 Markdown 解析器。读取方必须保留字面量 / 走链接。
   */
  format: ContentFormat | null;
  /** 仅 format='reactive' 时有意义；只用于升级审计，不是渲染开关。 */
  syntaxVersion: string | null;
  /** Shared by API, member embeds and public embeds. */
  version: string;
  /** 逐篇渲染覆盖（NULL / 'legacy' / 'reactive'）；只影响渲染路径，不改变格式。 */
  rendererOverride: string | null;
  createdAt: Date | null;
}

/**
 * 按 id 取剪贴板正文（含可见性判定）。
 * ignore=true（软删除）→ not_found；私有（publicity=false）且非作者 → forbidden。
 */
/**
 * 取剪贴板详情。
 *
 * @param viewerIsOwner 观看者是否为站长。★ 别漏 ★ —— 可见性判定是
 *   「publicity=true 或 本人 或 站长」：站长能看任何人的私有剪贴板
 *   （他本来就有硬删图床、裁决申诉这类权限，看私有内容属于同一档）。
 *   这个例外一度漏掉，站长访问会吃 403，连页面上那个「删除」按钮都够不着
 *   —— 而删除权限是给了他的。
 *   调用方必须显式传，不给默认 true：默认放行的参数一旦漏传就是越权。
 */
export async function getClip(
  id: string,
  viewerId?: string,
  viewerIsOwner = false
): Promise<GetClipResult> {
  const clip = await prisma.clipBoard.findFirst({
    where: { id, ignore: false },
    select: {
      id: true,
      title: true,
      authorId: true,
      publicity: true,
      rendererOverride: true,
      createdAt: true,
      author: { select: { username: true } },
      content: { select: { content: true, format: true, syntaxVersion: true } },
    },
  });

  if (!clip) return { ok: false, reason: 'not_found' };

  const isPublic = clip.publicity ?? true;
  if (!isPublic && clip.authorId !== viewerId && !viewerIsOwner) {
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
      // 未知存量值给 null，不猜 markdown（见 ClipDetail.format 的说明）。
      format: parseContentFormat(clip.content?.format) ?? null,
      syntaxVersion: clip.content?.syntaxVersion ?? null,
      version: createHash('sha256').update(JSON.stringify([
        clip.content?.format ?? null, clip.content?.syntaxVersion ?? null,
        clip.title, clip.content?.content ?? '',
      ])).digest('hex'),
      rendererOverride: clip.rendererOverride ?? null,
      createdAt: clip.createdAt ?? null,
    },
  };
}

/** @deprecated 剪贴板仅供成员读取。旧调用方也不得获得任何对外引用数据。 */
export async function resolvePublicClipRefs(
  _markdown: string
): Promise<Record<string, ExternalClipData>> {
  return {};
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
