// ─────────────────────────────────────────────────────────────────────────────
// image-service.ts — 图床元信息读取（对齐 Flask app/web/image_hosting/service.py）
//
// 本切片只做“列出/查询元信息”。图片字节由 Flask 提供，经 next.config 的
// `/image/:path*` rewrite 回源；真正的二进制上传（sharp 压缩 + 落盘）不在此实现。
// 软删除：ignore = true 排除。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { prisma } from './db';
import { storagePathFor } from './image-upload';

const EXT_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/** 由 MIME 推扩展名，对齐 ImageHosting.ext 属性。 */
export function extForMime(mimeType: string): string {
  return EXT_MAP[mimeType] ?? '';
}

export interface ImageMeta {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  authorId: string;
  authorName: string | null;
  createdAt: Date | null;
  isPublic: boolean;
  ext: string;
  url: string; // 回源路径，前端可直接用作 <img src>
}

function serialize(img: {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  authorId: string;
  createdAt: Date | null;
  isPublic: boolean | null;
  author?: { username: string } | null;
}): ImageMeta {
  return {
    id: img.id,
    filename: img.filename,
    fileSize: img.fileSize,
    mimeType: img.mimeType,
    authorId: img.authorId,
    authorName: img.author?.username ?? null,
    createdAt: img.createdAt,
    isPublic: img.isPublic ?? true,
    ext: extForMime(img.mimeType),
    url: `/api/images/${img.id}/raw`,
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

/** 列出某用户的全部图片元信息（未软删，最新在前），对齐 get_user_images。 */
export async function listUserImages(userId: string): Promise<ImageMeta[]> {
  const images = await prisma.imageHosting.findMany({
    where: { authorId: userId, ignore: false },
    orderBy: { createdAt: 'desc' },
    select: META_SELECT,
  });
  return images.map(serialize);
}

/** 取单张图片元信息；不存在或已软删返回 null。 */
export async function getImageMeta(id: string): Promise<ImageMeta | null> {
  const img = await prisma.imageHosting.findUnique({
    where: { id },
    select: { ...META_SELECT, ignore: true },
  });
  if (!img || img.ignore) return null;
  return serialize(img);
}

// ── 原生服务 / 删除（Node 运行时）────────────────────────────────────────────

export interface ServeImage {
  id: string;
  filename: string;
  mimeType: string;
  authorId: string;
  isPublic: boolean;
  ignore: boolean;
}

/** 取服务图片字节所需的最小字段；不存在返回 null（ignore/私有由调用方裁决）。 */
export async function getImageForServe(id: string): Promise<ServeImage | null> {
  const img = await prisma.imageHosting.findUnique({
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
  if (!img) return null;
  return {
    id: img.id,
    filename: img.filename,
    mimeType: img.mimeType,
    authorId: img.authorId,
    isPublic: img.isPublic ?? true,
    ignore: img.ignore ?? false,
  };
}

/** 软删除：ignore = true（保留磁盘文件），对齐 soft_delete_image。 */
export async function softDeleteImage(id: string): Promise<void> {
  await prisma.imageHosting.update({ where: { id }, data: { ignore: true } });
}

/** 硬删除：物理删除磁盘文件 + 删除数据库行，对齐 hard_delete_image（站长专属）。 */
export async function hardDeleteImage(id: string): Promise<void> {
  const img = await prisma.imageHosting.findUnique({
    where: { id },
    select: { mimeType: true },
  });
  if (img) {
    try {
      await fs.unlink(storagePathFor(id, img.mimeType));
    } catch {
      // 文件可能已不存在，忽略
    }
  }
  await prisma.imageHosting.delete({ where: { id } });
}
