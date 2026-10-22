// ─────────────────────────────────────────────────────────────────────────────
// image-upload.ts — 图床二进制上传
//
// 负责：磁盘路径解析、文件名净化（XSS/路径穿越防护）、角色配额累计、sharp 压缩、
// 落盘 + 落库。仅 Node 运行时可用（依赖 node:fs / node:crypto / sharp）。
// 软删除：ignore = true 不计入配额、不参与服务。
//
// 【内容判定住 image-sniff.ts】`planImageUpload` 是「这串字节该不该收、按什么类型收」
// 的唯一实现（零依赖，浏览器侧上传前校验也用同一份）。本文件只做 Node 侧的动作：
// 配额、压缩、落盘、落库。**落库的 mimeType 永远来自字节**，不信声明 —— 理由与
// 那条 XSS 链路见 image-sniff.ts 头部。
//
// 【两道安全闸门，改之前先看清楚】
//  1. sanitizeFilename —— **白名单**字符集（`\p{L}\p{N}._- `），不是「滤掉危险字符」的
//     黑名单：黑名单永远漏。四步：剥非法字符 → 折叠连续点/空格 → 去前导 `.`/`-`/空格
//     （防隐藏文件与相对路径）→ 截 200 字符。空结果兜底成 'image'，**永不返回空串**
//     （空串会让调用方拼出目录路径）。
//  2. QUOTA_LIMITS_MB —— core 50 / admin 50 / owner 100，沿用既有配额，别改。
//     这三个数字是**有意的**（不是「按角色递增」的直觉值：core 与 admin 同额），
//     改动必须是有意的；`tests/service/image-service.test.ts` 钉着边界（<= 而不是 <）。
//     无权限角色由 getQuotaLimitMb 返回 0 → 路由 403，别绕过它直接索引这个表。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { EXTENSION_FOR_MIME, type ImageMime } from './image-sniff';
import { UploadQuotaError } from './upload-quota';

// 内容判定与 MIME 词汇（零依赖，与浏览器侧同一份）。在这里 re-export，Node 侧的调用方
// 就只需要认识 image-upload 这一个入口 —— 但**实现只有 image-sniff.ts 那一份**。
export {
  BITMAP_IMAGE_MIMES,
  EXTENSION_FOR_MIME,
  UPLOAD_IMAGE_MIMES,
  detectHeifContainer,
  detectImageMime,
  filenameWithMimeExtension,
  normalizeClaimedMime,
  planImageUpload,
} from './image-sniff';
export type {
  HeifContainer,
  ImageMime,
  ImageUploadPlan,
  UploadRejectReason,
} from './image-sniff';

// 白名单的权威是 image-sniff.ts 的 UPLOAD_IMAGE_MIMES（这里 re-export）。**别再留一份
// Set**：路由已改为把 `planImageUpload` 当唯一闸门，多一份常量只会让人以为它还在把关。

// 单文件上限 10MB
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * 单次上传**请求体**上限（一次可以带多个文件），与部署侧的两个闸门同值：
 *   · nginx `client_max_body_size 12m`（docs/deploy.md「修改 schema 后」附近的部署要点）
 *   · next.config.mjs 的 `middlewareClientMaxBodySize: '12mb'`
 * 两个闸门超限的**表现不同，且都不指向根因**：nginx 回 413 + HTML 错误页（客户端解析不出、
 * 只剩兜底文案），Next 的中间件则是**静默截断** body → multipart 解析失败 →
 * 一句「无效的上传请求」。路由用它把这两种情况都变成能行动的错。
 *
 * 浏览器侧另有一道更保守的 11MB 闸门（image-client.ts 的 MAX_UPLOAD_REQUEST_BYTES，
 * 12MB 下留 1MB 给 multipart 每部分的头），两边数值**故意不同**，不是 drift。
 */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

// 角色存储配额（MB），数值见上（core 与 admin 同额是有意的）
export const QUOTA_LIMITS_MB: Record<string, number> = {
  core: 50,
  admin: 50,
  owner: 100,
};

const MAX_DIMENSION = 2000; // 超过则等比缩放
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 磁盘文件名后缀：唯一真相是 image-sniff.ts 的 EXTENSION_FOR_MIME（见 extensionForMime）。

// ── 内容嗅探 ──────────────────────────────────────────────────────────────────
//
// 【为什么必须有】`file.type` 是**浏览器声明**的 MIME，攻击者可任意伪造。
// 不校验内容的话存在这条链路：上传 SVG/HTML 字节但声明 `image/png` →
// raw 路由只看 mimeType，SVG attachment 分支不触发 → 以 `image/png` 内联下发。
// **现在**还有 `nosniff`（raw 路由恒发）兜着，浏览器不会照着字节去嗅探，所以这条
// 链路当下走不通 —— 但两道闸是**各自独立**的：nosniff 管的是「浏览器怎么解释响应」，
// 这里管的是「什么能被存进来、按什么类型存」。闸门不该只有一道，也别因为「nosniff
// 已经挡住了」就把这道删掉（换一条下发路径就可能穿）。
//
// 判定实现住 `image-sniff.ts`（零依赖，浏览器侧上传前校验共用同一份）。这里只做
// re-export，别在 Node 侧另写一套 —— 两边判定不一致的症状是「客户端放行、服务端拒」
// 或反向，都不报错。
//
// 语义（2026-10 起）：**以内容为准，声明只是提示**。位图之间声明的错配（PNG 存成
// .jpg、Windows 给空 type、iOS 把 HEIC 报成 image/jpeg）不再拒 —— 按内容纠正类型。
// 唯一收窄的仍是 SVG：只有「内容与声明都是 SVG」才收。

/** 规范扩展名（含点）；未知 MIME 回空串。 */
export function extensionForMime(mimeType: string | null | undefined): string {
  return mimeType ? (EXTENSION_FOR_MIME[mimeType as ImageMime] ?? '') : '';
}

/** 上传目录：优先环境变量，否则回落到 ./instance/images。 */
export function getUploadFolder(): string {
  return process.env.IMAGE_UPLOAD_FOLDER || path.resolve(process.cwd(), './instance/images');
}

/** 磁盘上的完整文件路径：<folder>/<id><ext>（存量图片文件即按此命名，不可改）。 */
export function storagePathFor(id: string, mimeType: string): string {
  return path.join(getUploadFolder(), id + extensionForMime(mimeType));
}

/**
 * 净化文件名，剥离可用于 XSS / 路径穿越的字符。白名单见下，不要换成黑名单。
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
 * 压缩 → 生成唯一 ID → 写盘 → 落库，返回最终元信息（fileSize 为最终落库字节数）。
 * compress=false 时跳过压缩，原样存储（图床页那个复选框即走这条）。
 * 调用方负责登录/禁言/MIME/尺寸/限频等前置校验。
 * 网络入口必须传 quotaBytes：落库事务再次核验实际用量，不能只信写入前的聚合快照。
 */
export async function saveUpload(input: {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
  compress?: boolean;
  /** 可信内部调用可省略；HTTP 路由按角色计算后必传。 */
  quotaBytes?: number;
}): Promise<SavedImage> {
  const filename = sanitizeFilename(input.filename);
  const finalBuffer =
    input.compress === false ? input.buffer : await compressImage(input.buffer, input.mimeType);

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
  const storagePath = storagePathFor(id, input.mimeType);
  // 独占创建：即使随机 ID 极端碰撞，也不能覆盖已有文件或在回滚时删掉它。
  await fs.writeFile(storagePath, finalBuffer, { flag: 'wx' });

  try {
    await prisma.$transaction(async (tx) => {
      // 首次写取得 SQLite 写锁；并发上传不能共享同一份剩余额度。
      await tx.imageHosting.create({ data: {
        id,
        filename,
        fileSize: finalBuffer.length,
        mimeType: input.mimeType,
        authorId: input.userId,
        createdAt: nowForDb(), // schema 无 @default(now())，显式写入；nowForDb 见 db-time.ts 的时区约定
      } });
      if (input.quotaBytes !== undefined) {
        const used = await tx.imageHosting.aggregate({
          where: { authorId: input.userId, ignore: false }, _sum: { fileSize: true },
        });
        if (!Number.isSafeInteger(input.quotaBytes) || input.quotaBytes < 0 ||
          (used._sum.fileSize ?? 0) > input.quotaBytes) throw new UploadQuotaError();
      }
    });
  } catch (error) {
    // 数据库拒绝的新文件尚未被接受；清理它，避免失败上传累积成磁盘垃圾。
    await fs.unlink(storagePath).catch(() => undefined);
    throw error;
  }

  return { id, filename, fileSize: finalBuffer.length, mimeType: input.mimeType };
}
