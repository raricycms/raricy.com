// ─────────────────────────────────────────────────────────────────────────────
// image-service.ts — 图床元信息读取
//
// 本切片做元信息读取 + 供 raw 路由分发字节（storagePathFor 拼磁盘路径）。
// 真正的二进制上传（sharp 压缩 + 落盘）在 image-upload.ts。
// 旧地址 `/image/i/<id>` 由 next.config.mjs 的 rewrites 映射到 raw 路由。
// 软删除：ignore = true 排除。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import { prisma } from './db';
import { extensionForMime, storagePathFor } from './image-upload';

/**
 * 由 MIME 推扩展名，对齐 ImageHosting.ext 属性。
 *
 * 表只有一份（`image-sniff.ts` 的 `EXTENSION_FOR_MIME`）：这里再抄一份的话，
 * 加格式时两处得一起改，漏一处不会报错 —— 卡片上那个后缀会与磁盘文件对不上。
 */
export function extForMime(mimeType: string): string {
  return extensionForMime(mimeType);
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

// ── 管理端（站长）：全站图片列表 + 总用量 ──────────────────────────────────────

const ADMIN_PER_PAGE = 30; // 管理端每页 30 条

export interface AdminImagePage {
  images: ImageMeta[];
  total: number;
  pages: number;
  page: number;
}

/**
 * 全站未软删图片分页列表（最新在前）。
 * search 命中「文件名 contains」或「上传者用户名 contains」
 * （即 filename.contains OR author_id in (username 命中的用户)）。
 */
export async function listAllImages(
  page = 1,
  search: string | null = null,
): Promise<AdminImagePage> {
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

  const [total, images] = await Promise.all([
    prisma.imageHosting.count({ where }),
    prisma.imageHosting.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * ADMIN_PER_PAGE,
      take: ADMIN_PER_PAGE,
      select: META_SELECT,
    }),
  ]);

  const pages = Math.ceil(total / ADMIN_PER_PAGE);
  return { images: images.map(serialize), total, pages, page: safePage };
}

/** 全站已用存储字节数（仅统计未软删），对齐 get_total_storage_bytes。 */
export async function getTotalStorageBytes(): Promise<number> {
  const agg = await prisma.imageHosting.aggregate({
    _sum: { fileSize: true },
    where: { ignore: false },
  });
  return agg._sum.fileSize ?? 0;
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

/**
 * 硬删除：**先删数据库行，再删磁盘文件**（站长专属），对齐 hard_delete_image。
 *
 * 【为什么是这个顺序】两步跨 DB 与文件系统，无法放进一个事务。旧顺序（先 unlink 后
 * delete）一旦删行失败就留下「行在、文件没了」：raw 永久 404、配额继续占用、管理页
 * 仍显示这一行，且没有任何办法修回。反过来先删行：
 *   · 删行失败 → 文件原样保留，整笔可重试，不会出现半删状态；
 *   · 删行成功、文件删不掉 → 只留下一个**孤儿文件**（ID 已不在库里、无人引用，
 *     可按目录人工清理）。本仓没有清道夫，但这是可观察、可人工收拾的一侧。
 *
 * 用 delete 的返回值拿 mimeType，不必先查一次（也少一个「查到时文件还在、删行时
 * 被别人改过」的窗口）。
 */
export async function hardDeleteImage(id: string): Promise<void> {
  const row = await prisma.imageHosting.delete({ where: { id } });
  try {
    await fs.unlink(storagePathFor(row.id, row.mimeType));
  } catch (error) {
    // 文件已不存在（并发重复删的竞态）或磁盘错误，都不改变「行已删掉」这个结论。
    // 绝不能让调用方把一次已完成的硬删当成失败去重试（重试只会拿到 400「不存在」）。
    console.warn(`[image] 硬删已删除行，但磁盘文件删除失败（孤儿文件）id=${row.id}:`, error);
  }
}
