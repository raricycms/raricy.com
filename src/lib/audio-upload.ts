// ─────────────────────────────────────────────────────────────────────────────
// audio-upload.ts — 音频床二进制上传
//
// 与 image-upload.ts 同构，但有三处**不是照抄**的，改之前先看清楚：
//
//  1. **没有压缩**。图床便宜全靠 sharp；音频要压得动就得引 ffmpeg（本站第一个
//     非 npm 的二进制依赖），刻意不引。代价是配额耐用度低得多 —— 见下面的数字。
//     所以音频**不碰 sharp**，落盘的就是用户传上来的字节。
//
//  2. **多了一层 MIME 别名归一化**（normalizeAudioMime）。图床没这个问题：`.png`
//     到哪都报 `image/png`。音频不是 —— `.m4a` 在三种平台上被报成 `audio/mp4` /
//     `audio/x-m4a` / `audio/m4a`，Windows 上还可能是**空串**。不归一化的话，
//     「内容与声明相符」这条闸门会把格式完全正确的文件判死。
//     ⚠️ 归一化**只用来补浏览器没给的那格**：权威始终是字节，
//     归一化后的声明仍要与 detectAudioMime 的结果严格相等。
//
//  3. **格式白名单只有三种**：MP3 / M4A(AAC in MP4) / OGG。刻意不收 WAV 与 FLAC ——
//     WAV 一分钟就是 10.3MB，正好顶满单文件上限，收进来等于给用户一个「传什么都失败」
//     的入口。
//
// 【配额的账】单文件 10MB × 总额 50MB ⇒ 一个 core 用户最多存 **5 个满额文件**。
// 这是所选数字的机械后果，不是 bug。也正因如此，音频在正文里的展开预算
// （audio-refs.ts 的 MAX_AUDIO_REFS）刻意远小于图片的 50。
//
// 仅 Node 运行时可用（依赖 node:fs / node:crypto）。
// 软删除：ignore = true 不计入配额、不参与服务（与图床同一套字段语义）。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
// 文件名净化与 10 位 id 生成器与图床**共用同一份实现**：两处若各写一份，
// 迟早有一处先被加固、另一处留洞（sanitizeFilename 那道白名单是安全边界，不是工具函数）。
import { generateImageId, sanitizeFilename } from './image-upload';

/**
 * 允许的 MIME 白名单（以下三项，扩大即放宽入站格式）。
 * ⚠️ 这三个值是**规范形**，别名由 normalizeAudioMime 折过来。
 */
export const ALLOWED_AUDIO_MIMETYPES = new Set<string>([
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
]);

/** 单文件上限 10MB（与图床同值 —— 部署侧两道 12MB 闸门因此不用改）。 */
export const MAX_AUDIO_SIZE = 10 * 1024 * 1024;

/**
 * 规范 MIME → **面向用户**的格式名（错误文案与文档用）。
 *
 * 【为什么不用 `mime.split('/')[1].toUpperCase()`】那会把 `audio/mpeg` 说成
 * 「MPEG」、`audio/mp4` 说成「MP4」—— 用户认的是 **MP3** 与 **M4A**，
 * 而这两个词恰恰是容器/编码名里看不出来的。错误文案是给人看的，
 * 得用他们找得到文件的那个名字。
 *
 * 键就是白名单本身，所以加了新格式而忘了配名字时，文案里会直接出现
 * `undefined`（而不是安静地漏掉一项）。
 */
const FORMAT_LABEL: Record<string, string> = {
  'audio/mpeg': 'MP3',
  'audio/mp4': 'M4A',
  'audio/ogg': 'OGG',
};

/** 白名单的展示文案，如 `MP3、M4A、OGG`。错误文案与文档同源，避免两处漂。 */
export function allowedAudioFormatLabel(): string {
  return [...ALLOWED_AUDIO_MIMETYPES].map((m) => FORMAT_LABEL[m]).join('、');
}

/** MIME → 扩展名（磁盘文件名后缀）。 */
const EXT_MAP: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
};

/** 规范化 MIME → 磁盘扩展名；认不出返回空串。 */
export function audioExtForMime(mimeType: string): string {
  return EXT_MAP[mimeType] ?? '';
}

// ── 内容嗅探（magic bytes）────────────────────────────────────────────────────
//
// 【为什么必须有】`file.type` 是**浏览器声明**的 MIME，攻击者可任意伪造。
// 图床被这条链路咬过：上传 SVG/HTML 字节但声明 `image/png` → raw 路由只看 mimeType
// → 以 image/png 内联下发 → 浏览器嗅探成 SVG/HTML → **同源存储型 XSS**。
// 音频没有那条 XSS 路径（这三种格式都不是可执行文档），但**闸门本身照旧要有**：
// 它挡的是「拿音频床当任意文件床用」，那会让整块盘的占用与展示都对不上账。
//
// 判定方式（纯字节比对，无第三方依赖）。

const OGG_MAGIC = 'OggS';

/**
 * 首个 Ogg 页里出现的编解码器标识。**这一层是刻意加的**：
 * Ogg 是个**容器**，能装 Theora 视频。只认 `OggS` 的话，一个 .ogv 视频会被
 * 当成音频收进来。Vorbis / Opus / FLAC 三种音频编解码器的魔数都在首个 packet 里，
 * 位置靠前，扫前 256 字节足够。
 */
const OGG_AUDIO_CODECS = ['vorbis', 'OpusHead', 'fLaC'];

/**
 * MP4 的 `ftyp` brand 白名单。
 *
 * ⚠️ **已知的松处**：`isom` / `mp42` 这类通用 brand 既可能装纯音频，也可能装视频。
 * 要真正分辨得走 box 树去读 `hdlr` 的 handler type（`soun` vs `vide`），那是另一个量级的
 * 解析器。这里接受这个松度，理由是代价有界：`<audio>` 不会渲染视频轨，配额又只有
 * 50MB，拿它当视频床既不省事也不划算。真要收紧，就从这里下手。
 */
const MP4_AUDIO_BRANDS = new Set([
  'M4A ',
  'M4B ',
  'M4P ',
  'mp41',
  'mp42',
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
]);

/** 判定字节是否为 MP3：`ID3` 标签头，或一个像样的 MPEG 帧同步。 */
function looksLikeMp3(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  // ID3v2 标签头
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;

  // MPEG 帧同步：11 位全 1，随后 version/layer 不能是保留值、bitrate 不能是 0/15。
  // 只判 `b0 === 0xFF && (b1 & 0xE0) === 0xE0` 太松 —— 任意一段 0xFF 打头的二进制
  // 都能凑上。这里把同一帧头里其余几个字段也核一遍（纯位运算，仍是 O(1)）。
  const b0 = buffer[0];
  const b1 = buffer[1];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03; // 1 = 保留
  if (version === 1) return false;
  const layer = (b1 >> 1) & 0x03; // 0 = 保留
  if (layer === 0) return false;
  const bitrateIndex = (buffer[2] >> 4) & 0x0f; // 0 = free, 15 = 坏值
  if (bitrateIndex === 0 || bitrateIndex === 15) return false;
  return true;
}

/** 判定字节是否为音频 MP4：偏移 4..8 是 `ftyp`，且 brand 在白名单里。 */
function looksLikeMp4Audio(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  return MP4_AUDIO_BRANDS.has(buffer.subarray(8, 12).toString('latin1'));
}

/** 判定字节是否为音频 Ogg：`OggS` 开头，且首个页里认得出音频编解码器。 */
function looksLikeOggAudio(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (buffer.subarray(0, 4).toString('latin1') !== OGG_MAGIC) return false;
  const head = buffer.subarray(0, 256).toString('latin1');
  return OGG_AUDIO_CODECS.some((c) => head.includes(c));
}

/**
 * 由**文件内容**识别真实音频类型；无法识别返回 null。
 * 只读文件头，无第三方依赖。
 */
export function detectAudioMime(buffer: Buffer): string | null {
  if (looksLikeMp3(buffer)) return 'audio/mpeg';
  if (looksLikeMp4Audio(buffer)) return 'audio/mp4';
  if (looksLikeOggAudio(buffer)) return 'audio/ogg';
  return null;
}

// ── 声明侧的归一化 ───────────────────────────────────────────────────────────

/** 别名 → 规范形。键一律小写。 */
const MIME_ALIASES: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-mpeg-3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/mp4a-latm': 'audio/mp4',
  'audio/ogg': 'audio/ogg',
  'audio/opus': 'audio/ogg',
  'audio/vorbis': 'audio/ogg',
  'application/ogg': 'audio/ogg',
};

/** 扩展名 → 规范形（只在浏览器**没给** type 时兜底）。 */
const EXT_TO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
};

/**
 * 把浏览器/调用方给的类型折成规范形；给不出就按扩展名兜底；都不行返回 null。
 *
 * 【为什么不直接 `file.type.toLowerCase()`】见文件头第 2 条 —— `.m4a` 的声明值
 * 在三种平台上都不一样，还有整个是空串的情况。**扩展名兜底不等于放水**：
 * 之后仍要与 detectAudioMime 的字节判定**严格相等**，扩展名只用来补那一格，
 * 补错了照样拒。所以一个叫 `x.mp3` 的 PNG 依然进不来。
 *
 * ⚠️ 刻意**不认 `.mp4`**：那是视频容器的通用扩展名，认了就等于给「传视频」
 * 开一条明路，而品牌白名单（MP4_AUDIO_BRANDS）本来就分辨不了。
 */
export function normalizeAudioMime(
  claimed: string | null | undefined,
  filename?: string | null
): string | null {
  // 去掉 `; codecs=...` 之类的参数，再小写
  const bare = (claimed ?? '').split(';')[0].trim().toLowerCase();
  const byAlias = MIME_ALIASES[bare];
  if (byAlias) return byAlias;

  const ext = path.extname(filename ?? '').toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * 校验「文件内容是否真是所声明的格式」，**返回规范 MIME**（不通过返回 null）。
 *
 * 【为什么返回 MIME 而不是 boolean（图床那边是 boolean）】raw 路由的 `Content-Type`
 * 必须在**上传那一刻**就定下来并落库 —— 落库的必须是这个**认过的**值，
 * 而不是浏览器当初声明的那个别名。否则一个 `audio/x-m4a` 会一路传到最后，
 * 落进 `Content-Type` 里成了没人保证过的字符串。
 */
export function verifyAudioMime(
  buffer: Buffer,
  claimed: string | null | undefined,
  filename?: string | null
): string | null {
  const canonical = normalizeAudioMime(claimed, filename);
  if (!canonical || !ALLOWED_AUDIO_MIMETYPES.has(canonical)) return null;
  const detected = detectAudioMime(buffer);
  return detected === canonical ? canonical : null;
}

// ── 磁盘 ─────────────────────────────────────────────────────────────────────

/** 上传目录：优先环境变量，否则回落到 ./instance/audio。 */
export function getAudioUploadFolder(): string {
  return (
    process.env.AUDIO_UPLOAD_FOLDER || path.resolve(process.cwd(), './instance/audio')
  );
}

/** 磁盘上的完整文件路径：<folder>/<id><ext>。 */
export function audioStoragePathFor(id: string, mimeType: string): string {
  return path.join(getAudioUploadFolder(), id + EXT_MAP[mimeType]);
}

// ── 写路径 ───────────────────────────────────────────────────────────────────

export interface SavedAudio {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
}

/**
 * 生成唯一 ID → 写盘 → 落库，返回最终元信息。
 *
 * 与图床的 saveUpload 同构，只是**没有压缩**那一步、且碰撞检查打在不同的表上。
 * 调用方负责登录/禁言/MIME/大小/配额/限频等一切前置校验。
 *
 * `mimeType` 必须是 verifyAudioMime 认过的**规范值** —— 本函数不再复核，
 * 它同时是磁盘扩展名（EXT_MAP）与落库值的来源，传错会导致落盘后缀与
 * `Content-Type` 对不上。
 */
export async function saveAudioUpload(input: {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<SavedAudio> {
  const filename = sanitizeFilename(input.filename);

  // 生成唯一 ID（碰撞极低，最多重试 10 次）
  let id = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateImageId();
    const exists = await prisma.audioHosting.findUnique({
      where: { id: candidate },
      select: { id: true },
    });
    if (!exists) {
      id = candidate;
      break;
    }
  }
  if (!id) throw new Error('无法生成唯一ID，请重试');

  const folder = getAudioUploadFolder();
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(audioStoragePathFor(id, input.mimeType), input.buffer);

  await prisma.audioHosting.create({
    data: {
      id,
      filename,
      fileSize: input.buffer.length,
      mimeType: input.mimeType,
      authorId: input.userId,
      createdAt: nowForDb(), // schema 无 @default(now())，显式写入；nowForDb 见 db-time.ts 的时区约定
    },
  });

  return { id, filename, fileSize: input.buffer.length, mimeType: input.mimeType };
}
