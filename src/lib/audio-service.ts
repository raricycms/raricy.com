// ─────────────────────────────────────────────────────────────────────────────
// audio-service.ts — 音频床元信息读取 / 删除 / 配额
//
// 与 image-service.ts 逐函数同构。二进制上传在 audio-upload.ts。
// 软删除：ignore = true 排除（磁盘文件保留 —— 与图床同一条口径，永不物理删除）。
//
// 【与图床**刻意**的一处不同】getTotalAudioBytes / getUserUsedAudioBytes 打的是
// **audio_hosting 自己的聚合**。这就是「音频独立 50MB」的落地点：额度仍复用
// image-upload.ts 的 QUOTA_LIMITS_MB（不另立一份数字表，避免第二份配额权威），
// 但**用量各算各的** —— 传满 50MB 音频不会挤掉图片的空间，反之亦然。
//
// 【为什么没有 image_id 那样的附件列】讨论 / 评论的图片附件走的是 ChatMessage.imageId
// 这类外键列，与托管域是两回事。音频**不开附件链路** —— 它只经 `[@音频/<ID>]` 进正文。
// 将来若真要做「语音条」那种一等公民附件，那是另一个决定，别顺手照抄 image_id。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { prisma } from './db';
import { audioExtForMime, audioStoragePathFor } from './audio-upload';

export interface AudioMeta {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  authorId: string;
  authorName: string | null;
  createdAt: Date | null;
  isPublic: boolean;
  ext: string;
  url: string; // 回源路径，前端可直接用作 <audio src>
}

function serialize(a: {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  authorId: string;
  createdAt: Date | null;
  isPublic: boolean | null;
  author?: { username: string } | null;
}): AudioMeta {
  return {
    id: a.id,
    filename: a.filename,
    fileSize: a.fileSize,
    mimeType: a.mimeType,
    authorId: a.authorId,
    authorName: a.author?.username ?? null,
    createdAt: a.createdAt,
    isPublic: a.isPublic ?? true,
    ext: audioExtForMime(a.mimeType),
    url: `/api/audio/${a.id}/raw`,
  };
}

const META_SELECT = {
  id: true,
  filename: true,
  fileSize: true,
  mimeType: true,
  authorId: true,
  createdAt: true,
  isPublic: true,
  author: { select: { username: true } },
} as const;

/** 列出某用户的全部音频元信息（未软删，最新在前）。 */
export async function listUserAudio(userId: string): Promise<AudioMeta[]> {
  const rows = await prisma.audioHosting.findMany({
    where: { authorId: userId, ignore: false },
    orderBy: { createdAt: 'desc' },
    select: META_SELECT,
  });
  return rows.map(serialize);
}

// ── 管理端（站长）：全站列表 + 总用量 ─────────────────────────────────────────

const ADMIN_PER_PAGE = 30; // 与图床管理端同值

export interface AdminAudioPage {
  audio: AudioMeta[];
  total: number;
  pages: number;
  page: number;
}

/**
 * 全站未软删音频分页列表（最新在前）。
 * search 命中「文件名 contains」或「上传者用户名 contains」。
 *
 * 与图床那边同一条已知偏差：LIKE 的 `%` / `_` 未转义（见 image-service.ts 的说明）。
 */
export async function listAllAudio(
  page = 1,
  search: string | null = null,
): Promise<AdminAudioPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const where = {
    ignore: false,
    ...(search
      ? {
          OR: [
            { filename: { contains: search } },
            { author: { username: { contains: search } } },
          ],
        }
      : {}),
  } as const;

  const [total, rows] = await Promise.all([
    prisma.audioHosting.count({ where }),
    prisma.audioHosting.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * ADMIN_PER_PAGE,
      take: ADMIN_PER_PAGE,
      select: META_SELECT,
    }),
  ]);

  const pages = Math.ceil(total / ADMIN_PER_PAGE);
  return { audio: rows.map(serialize), total, pages, page: safePage };
}

/** 全站已用音频存储字节数（仅统计未软删）。 */
export async function getTotalAudioBytes(): Promise<number> {
  const agg = await prisma.audioHosting.aggregate({
    _sum: { fileSize: true },
    where: { ignore: false },
  });
  return agg._sum.fileSize ?? 0;
}

/**
 * 某用户已用音频存储字节数（仅统计未软删）。
 *
 * ★ 这就是「音频独立配额」的那一行 ★ —— 图床的对应函数
 * （image-upload.ts 的 getUserUsedBytes）打的是 image_hosting，两者互不影响。
 * 软删即释放额度（与图床一致）。
 */
export async function getUserUsedAudioBytes(userId: string): Promise<number> {
  const agg = await prisma.audioHosting.aggregate({
    _sum: { fileSize: true },
    where: { authorId: userId, ignore: false },
  });
  return agg._sum.fileSize ?? 0;
}

/** 取单条音频元信息；不存在或已软删返回 null。 */
export async function getAudioMeta(id: string): Promise<AudioMeta | null> {
  const row = await prisma.audioHosting.findUnique({
    where: { id },
    select: { ...META_SELECT, ignore: true },
  });
  if (!row || row.ignore) return null;
  return serialize(row);
}

// ── 原生服务 / 删除（Node 运行时）────────────────────────────────────────────

export interface ServeAudio {
  id: string;
  filename: string;
  mimeType: string;
  authorId: string;
  isPublic: boolean;
  ignore: boolean;
}

/** 取服务音频字节所需的最小字段；不存在返回 null（ignore/私有由调用方裁决）。 */
export async function getAudioForServe(id: string): Promise<ServeAudio | null> {
  const row = await prisma.audioHosting.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      authorId: true,
      isPublic: true,
      ignore: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    authorId: row.authorId,
    isPublic: row.isPublic ?? true,
    ignore: row.ignore ?? false,
  };
}

/** 软删除：ignore = true（保留磁盘文件）。 */
export async function softDeleteAudio(id: string): Promise<void> {
  await prisma.audioHosting.update({ where: { id }, data: { ignore: true } });
}

/**
 * 硬删除：物理删除磁盘文件 + 删除数据库行（**站长专属**）。
 *
 * ⚠️ 与图床的一处结构性差别：ImageHosting 有 `chatMessages` 反向关系，
 * 所以那边硬删会被外键拦住（FK RESTRICT，只能走站长那条路）。
 * **音频没有任何外键指向它**，硬删因此是真的能删干净 —— 现状没问题，
 * 但**哪天给音频加了附件列（比如 ChatMessage.audioId），这条推理会反转**，
 * 那时必须回头确认这里不会静默删掉别人的引用。
 */
export async function hardDeleteAudio(id: string): Promise<void> {
  const row = await prisma.audioHosting.findUnique({
    where: { id },
    select: { mimeType: true },
  });
  if (row) {
    try {
      await fs.unlink(audioStoragePathFor(id, row.mimeType));
    } catch {
      // 文件可能已不存在，忽略
    }
  }
  await prisma.audioHosting.delete({ where: { id } });
}
