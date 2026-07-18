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

// ── 内容嗅探（magic bytes）────────────────────────────────────────────────────
//
// 【为什么必须有】`file.type` 是**浏览器声明**的 MIME，攻击者可任意伪造。
// 不校验内容的话存在这条链路：上传 SVG/HTML 字节但声明 `image/png` →
// raw 路由只看 mimeType，SVG attachment 分支不触发 → 以 `image/png` 内联下发 →
// 浏览器 MIME 嗅探把它当 SVG/HTML 渲染 → **同源存储型 XSS**。
// （nosniff 是第二道闸，但闸门不该只有一道；且 nosniff 挡不住直接声明 image/svg+xml
// 却塞 HTML 的变体。）
//
// 对齐 Flask verify_image_mime（app/web/image_hosting/service.py）：
//   · 位图：PIL 解出真实 format → 与声明的 MIME 比对，不符/解不开 → 拒绝
//   · SVG：PIL 开不了 XML，改为文本前缀检查
//   · 差异：Flask 无 Pillow 时 `return True`（信任浏览器）——这里不留这个后门，
//     纯字节比对无依赖，恒定生效。
//   · 差异：Flask 的 SVG 分支是 `'<svg' in text[:1024]`（**子串**匹配），
//     `<html><svg>` 这种也会放行。这里收紧为「跳过 BOM/prolog/注释/DOCTYPE 后
//     必须以 <svg 开头」——真实 SVG 一定有 <svg 根元素，不会误伤。

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * 判定字节是否为 SVG：跳过 BOM、空白、XML prolog(`<?...?>`)、注释(`<!--...-->`)、
 * DOCTYPE（含内部子集 `[...]`），随后必须紧跟 `<svg` 且后随空白/`>`/`/`
 * （避免 `<svgfoo>` 这类误判）。只看前 4KB，足够覆盖任何合法 SVG 的头部。
 */
function looksLikeSvg(buffer: Buffer): boolean {
  let text = buffer.subarray(0, 4096).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM

  // 反复剥离头部噪声，直到遇到真正的元素
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, '');
    text = text.replace(/^<\?[\s\S]*?\?>/, ''); // <?xml ... ?> / <?xml-stylesheet ... ?>
    text = text.replace(/^<!--[\s\S]*?-->/, ''); // 注释
    text = text.replace(/^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?[^>]*>/i, ''); // DOCTYPE（含内部子集）
    if (text === before) break;
  }

  return /^<svg[\s/>]/i.test(text);
}

/**
 * 由**文件内容**识别真实图片类型；无法识别（含被截断的头部）返回 null。
 * 只读文件头，无第三方依赖。
 */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buffer.subarray(0, 3).equals(JPEG_SIG)) return 'image/jpeg';

  const head6 = buffer.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';

  // WebP：RIFF<4字节长度>WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (looksLikeSvg(buffer)) return 'image/svg+xml';

  return null;
}

/**
 * 校验「文件内容是否真是所声明的格式」。声明不在白名单、内容识别不出、
 * 或内容与声明不符 → false（对齐 Flask verify_image_mime 的拒绝语义）。
 */
export function verifyImageMime(buffer: Buffer, claimedMime: string): boolean {
  if (!ALLOWED_MIMETYPES.has(claimedMime)) return false;
  return detectImageMime(buffer) === claimedMime;
}

/** 上传目录：优先环境变量，否则回落到 ./instance/images。 */
export function getUploadFolder(): string {
  return process.env.IMAGE_UPLOAD_FOLDER || path.resolve(process.cwd(), './instance/images');
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

/**
 * 角色对应的配额上限（MB）；无权限角色返回 0。
 *
 * 【为什么用 Object.hasOwn 而不是直接索引】对象字面量带 Object.prototype，
 * `QUOTA_LIMITS_MB['constructor']` 会拿到**函数**而非 undefined，`?? 0` 兜不住 →
 * 路由的 `if (limitMb === 0) return 403` 判不出来，`limitBytes = fn * 1024*1024 = NaN`，
 * 而 `used + size > NaN` 恒为 false → **配额闸门全开**。
 * role 虽来自 DB（攻击者注入不进来），但这道防线不该靠「数据一定干净」来维持。
 */
export function getQuotaLimitMb(role: string | null | undefined): number {
  const key = role ?? '';
  if (!Object.hasOwn(QUOTA_LIMITS_MB, key)) return 0;
  const v = QUOTA_LIMITS_MB[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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
