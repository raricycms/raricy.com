// ─────────────────────────────────────────────────────────────────────────────
// image-upload.ts — 图床二进制上传（对齐 Flask app/web/image_hosting/service.py）
//
// 负责：磁盘路径解析、文件名净化（XSS/路径穿越防护）、角色配额累计、sharp 压缩、
// 落盘 + 落库。仅 Node 运行时可用（依赖 node:fs / node:crypto / sharp）。
// 软删除：ignore = true 不计入配额、不参与服务。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from './db';
import { nowForDb } from './db-time';

// 允许的 MIME 白名单，对齐 Flask ALLOWED_MIMETYPES
export const ALLOWED_MIMETYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// 单文件上限（对齐 Flask MAX_IMAGE_SIZE 默认 10MB）
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// 角色存储配额（MB），对齐 Flask QUOTA_LIMITS_MB
export const QUOTA_LIMITS_MB: Record<string, number> = {
  core: 50,
  admin: 50,
  owner: 100,
};

const MAX_DIMENSION = 2000; // 超过则等比缩放
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// MIME → 扩展名（磁盘文件名后缀），与 image-service.ts 的 EXT_MAP 保持一致
const EXT_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/** 上传目录：优先环境变量，否则回落到父级 Flask 仓库的 instance/images。 */
export function getUploadFolder(): string {
  return process.env.IMAGE_UPLOAD_FOLDER || path.resolve(process.cwd(), '../instance/images');
}

/** 磁盘上的完整文件路径：<folder>/<id><ext>，对齐 Flask ImageHosting.storage_path。 */
export function storagePathFor(id: string, mimeType: string): string {
  return path.join(getUploadFolder(), id + (EXT_MAP[mimeType] ?? ''));
}

/**
 * 净化文件名，剥离可用于 XSS / 路径穿越的字符（对齐 Flask sanitize_filename）。
 * 保留：Unicode 字母/数字（含 CJK）、下划线、点、连字符、空格。
 */
export function sanitizeFilename(filename: string): string {
  let name = (filename ?? '').replace(/[^\p{L}\p{N}._\- ]/gu, '');
  name = name.replace(/\.{2,}/g, '.'); // 折叠连续点
  name = name.replace(/ {2,}/g, ' '); // 折叠连续空格
  name = name.replace(/^[.\-\s]+/, ''); // 去除前导点/空格/连字符（防隐藏文件）
  name = name.slice(0, 200);
  return name || 'image';
}

/** 角色对应的配额上限（MB）；无权限角色返回 0。 */
export function getQuotaLimitMb(role: string | null | undefined): number {
  return QUOTA_LIMITS_MB[role ?? ''] ?? 0;
}

/** 用户已用存储字节数（仅统计未软删的图片），对齐 get_user_used_bytes。 */
export async function getUserUsedBytes(userId: string): Promise<number> {
  const agg = await prisma.imageHosting.aggregate({
    _sum: { fileSize: true },
    where: { authorId: userId, ignore: false },
  });
  return agg._sum.fileSize ?? 0;
}

/**
 * sharp 压缩：仅处理位图（png/jpeg/webp），保持原格式；svg 与 gif（可能含动画）跳过。
 * 超过 2000px 等比缩小；仅当压缩结果更小才采用，否则原样返回。
 */
export async function compressImage(buffer: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType === 'image/svg+xml' || mimeType === 'image/gif') return buffer;

  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    let pipeline = sharp(buffer, { failOn: 'none' });

    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    if (mimeType === 'image/jpeg') {
      pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
    } else if (mimeType === 'image/png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
    } else if (mimeType === 'image/webp') {
      pipeline = pipeline.webp({ quality: 85 });
    } else {
      return buffer;
    }

    const out = await pipeline.toBuffer();
    return out.length < buffer.length ? out : buffer;
  } catch {
    return buffer; // 压缩失败则回退原始字节，绝不丢图
  }
}

/** 10 位加密安全随机 ID（大小写字母 + 数字），对齐 generate_image_id(secrets)。 */
export function generateImageId(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return out;
}

export interface SavedImage {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
}

/**
 * 压缩 → 生成唯一 ID → 写盘 → 落库，返回最终元信息（fileSize 为压缩后大小）。
 * 调用方负责登录/禁言/MIME/尺寸/配额/限频等前置校验。
 */
export async function saveUpload(input: {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<SavedImage> {
  const filename = sanitizeFilename(input.filename);
  const finalBuffer = await compressImage(input.buffer, input.mimeType);

  // 生成唯一 ID（碰撞极低，最多重试 10 次）
  let id = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateImageId();
    const exists = await prisma.imageHosting.findUnique({
      where: { id: candidate },
      select: { id: true },
    });
    if (!exists) {
      id = candidate;
      break;
    }
  }
  if (!id) throw new Error('无法生成唯一ID，请重试');

  const folder = getUploadFolder();
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(storagePathFor(id, input.mimeType), finalBuffer);

  await prisma.imageHosting.create({
    data: {
      id,
      filename,
      fileSize: finalBuffer.length,
      mimeType: input.mimeType,
      authorId: input.userId,
      createdAt: nowForDb(), // schema 无 @default(now())，显式写入；nowForDb 见 db-time.ts 的时区约定
    },
  });

  return { id, filename, fileSize: finalBuffer.length, mimeType: input.mimeType };
}
