// ─────────────────────────────────────────────────────────────────────────────
// file-converter/inspect.ts —— 内容识别（嗅探）与轻量元信息（零依赖、纯函数）
//
// 【纪律】plan §3.2 / §9.1：**以字节内容为准**，文件名与浏览器声明 MIME 只作提示。
// 本模块只吃 Uint8Array（头若干 KB + 必要时尾部），不 import 任何引擎 ——
// node 单测直接喂字节。ZIP 系容器（docx/xlsx/pptx/epub/odt…）靠自写的中央目录
// 读取区分，不做完整解压。
//
// 动画标记（APNG 的 acTL、WebP 的 ANIM、GIF 多帧）在这里识别 —— plan §3.1 要求
// 「动画文件拒绝进入静态流程」，而这个判断必须发生在任何解码之前。
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchiveMemberInfo, FileKind, InspectInfo, SniffResult } from './types';

const te = new TextDecoder('utf-8', { fatal: false });

function startsWith(b: Uint8Array, off: number, sig: number[]): boolean {
  if (b.length < off + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[off + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function sniffOf(kind: FileKind, mime: string, ext: string, detail?: string): SniffResult {
  return { kind, mime, ext, detail };
}

const UNKNOWN: SniffResult = sniffOf('unknown', 'application/octet-stream', 'bin');

// ─── ZIP 中央目录（区分 docx/xlsx/pptx/epub/odt 与纯 ZIP；同时供成员预览）─────

export interface ZipCentralDirectory {
  members: ArchiveMemberInfo[];
  /** 依据成员名单判出的具体容器。 */
  container: 'docx' | 'xlsx' | 'pptx' | 'epub' | 'odt' | 'ods' | 'odp' | 'zip';
}

/**
 * 从完整字节读 ZIP 中央目录。**不解压任何成员**。需要完整文件字节
 * （EOCD 在尾部）；调用方对小文件直接给全文，大文件先按限额挡。
 * 结构损坏（找不到 EOCD、CD 越界）返回 null —— 调用方按「损坏」处理。
 */
export function readZipCentralDirectory(b: Uint8Array): ZipCentralDirectory | null {
  // EOCD 签名 0x06054b50，从尾部最多回扫 64KiB + 22（注释区上限）
  const minPos = Math.max(0, b.length - 22 - 65536);
  let eocd = -1;
  for (let i = b.length - 22; i >= minPos; i--) {
    if (u32le(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16le(b, eocd + 10);
  const cdSize = u32le(b, eocd + 12);
  const off = u32le(b, eocd + 16);
  if (off + cdSize > b.length) return null;
  const members = parseCdEntries(b.subarray(off, off + cdSize), count);
  if (!members) return null;
  return { members, container: zipContainerOf(members) };
}

/**
 * 只解析中央目录条目本身（大文件用：先读尾部找 EOCD，再按偏移只读 CD 区段，
 * 不必读全文）。`cd` 必须是**从 CD 起点开始**的字节。
 */
export function parseCdEntries(cd: Uint8Array, count: number): ArchiveMemberInfo[] | null {
  const members: ArchiveMemberInfo[] = [];
  let off = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > cd.length || u32le(cd, off) !== 0x02014b50) return null;
    const compressedSize = u32le(cd, off + 20);
    const size = u32le(cd, off + 24);
    const nameLen = u16le(cd, off + 28);
    const extraLen = u16le(cd, off + 30);
    const commentLen = u16le(cd, off + 32);
    const name = te.decode(cd.subarray(off + 46, off + 46 + nameLen));
    const isDir = name.endsWith('/');
    members.push({ path: name, size, compressedSize, isDir });
    off += 46 + nameLen + extraLen + commentLen;
    if (off > cd.length) return null;
  }
  return members;
}

/** 从 EOCD 记录字节里读成员数 / CD 大小 / CD 偏移（大文件定点读取用）。 */
export function parseEocd(tail: Uint8Array): { count: number; cdSize: number; cdOffset: number } | null {
  const minPos = Math.max(0, tail.length - 22 - 65536);
  for (let i = tail.length - 22; i >= minPos; i--) {
    if (u32le(tail, i) === 0x06054b50) {
      return { count: u16le(tail, i + 10), cdSize: u32le(tail, i + 12), cdOffset: u32le(tail, i + 16) };
    }
  }
  return null;
}

/** 依据成员名单判出具体容器（docx / epub…还是纯 zip）。 */
function zipContainerOf(members: ArchiveMemberInfo[]): ZipCentralDirectory['container'] {
  const names = new Set(members.filter((m) => !m.isDir).map((m) => m.path));
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  if (names.has('ppt/presentation.xml')) return 'pptx';
  if (names.has('mimetype') && [...names].some((n) => n.endsWith('.opf'))) return 'epub';
  if (names.has('content.xml') && names.has('styles.xml')) return 'odt';
  return 'zip';
}

// ─── 图片头部解析（尺寸 + 动画标记，纯头部，不解码像素）───────────────────────

interface ImageHeader {
  width?: number;
  height?: number;
  animated?: boolean;
}

function pngHeader(b: Uint8Array): ImageHeader {
  const h: ImageHeader = { width: u32be(b, 16), height: u32be(b, 20) };
  // APNG：找 acTL 块（可出现在 IDAT 前）
  let off = 8;
  while (off + 12 <= b.length) {
    const len = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    if (type === 'acTL') {
      h.animated = true;
      break;
    }
    if (type === 'IDAT') break;
    off += 12 + len;
  }
  return h;
}

function gifHeader(b: Uint8Array): ImageHeader {
  const h: ImageHeader = { width: u16le(b, 6), height: u16le(b, 8), animated: false };
  // 数图像分隔符 0x2C（粗略但够用：两张图以上即动画）
  let frames = 0;
  for (let i = 13; i < b.length; i++) {
    if (b[i] === 0x2c) {
      frames++;
      if (frames > 1) {
        h.animated = true;
        break;
      }
    }
  }
  return h;
}

function jpegHeader(b: Uint8Array): ImageHeader {
  // 扫 SOF0–SOF15（跳过 DHT/DQT/SOS…）
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16be(b, off + 7), height: u16be(b, off + 5) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = u16be(b, off + 2);
    if (len < 2) break;
    off += 2 + len;
  }
  return {};
}

function webpHeader(b: Uint8Array): ImageHeader {
  // RIFF....WEBP + VP8/VP8L/VP8X
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    const flags = b[20];
    const w = 1 + b[24] + (b[25] << 8) + (b[26] << 16);
    const h = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
    return { width: w, height: h, animated: (flags & 0x02) !== 0 };
  }
  if (chunk === 'VP8 ') {
    // 帧头从 20 开始：3 字节帧标记 + 9d 012a + w/h
    if (b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false };
    }
    return {};
  }
  if (chunk === 'VP8L') {
    const bits = u32le(b, 21);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return { width: w, height: h, animated: false };
  }
  return {};
}

function bmpHeader(b: Uint8Array): ImageHeader {
  const dibSize = u32le(b, 14);
  if (dibSize >= 40) return { width: u32le(b, 18), height: Math.abs(u32le(b, 22) | 0) };
  if (dibSize === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
  return {};
}

function tiffHeader(b: Uint8Array): ImageHeader {
  const le = b[0] === 0x49;
  const u16 = le ? u16le : u16be;
  const u32 = le ? u32le : u32be;
  const ifd = u32(b, 4);
  if (ifd + 2 > b.length) return {};
  const count = u16(b, ifd);
  let width: number | undefined;
  let height: number | undefined;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = u16(b, e);
    if (tag !== 256 && tag !== 257) continue;
    // ★ 必须按**字段类型**读值域，不能一律读 4 字节 ★
    // 宽高在基线 TIFF 里多是 SHORT（类型 3，2 字节），且只有 count=1 时才内联在
    // 值域里。一律按 u32 读的话，**大端**文件里那 2 字节落在值域的高位 ——
    // 宽度会被读成 w<<16（小端恰好正确，所以这个错只在一种字节序下现形，
    // 而 utif 写出的正是大端）。类型 4（LONG）才是 4 字节。
    const type = u16(b, e + 2);
    const n = u32(b, e + 4);
    if (n !== 1) continue; // 多值 = 值域是偏移量，不是内联值 —— 宽高不会这么存
    const val = type === 3 ? u16(b, e + 8) : u32(b, e + 8);
    if (tag === 256) width = val;
    else height = val;
  }
  return { width, height };
}

function icoHeader(b: Uint8Array): ImageHeader {
  const count = u16le(b, 4);
  if (count === 0 || count > 64) return {};
  // 第一张的宽高（0 = 256）
  const w = b[6] === 0 ? 256 : b[6];
  const h = b[7] === 0 ? 256 : b[7];
  // ⚠️ ICO 里多于一张图**不是动画**，是同一个图标的多分辨率变体（16/32/48/256px）。
  // 早先这里写的是 `animated: count > 1` —— 那让每一个正常的多尺寸 .ico 都被静态边
  // 当成动图拒掉（静态边的闸是 `info.animated !== true`），而方向恰好反过来：
  // 真正需要「动画闸」的是 GIF / APNG / 动图 WebP。判断依据是**容器语义**，
  // 不是「里面装了几张图」—— 这条错误曾经只在 ico 上显形，所以极易被当成特例豁免掉。
  return { width: w, height: h, animated: false };
}

/** ftyp brands → 容器。HEIC/HEIF/AVIF/MP4/MOV/M4A 都是 ISOBMFF。 */
function ftypSniff(b: Uint8Array): SniffResult {
  const brand = ascii(b, 8, 4);
  if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1') {
    return sniffOf('heic', 'image/heic', 'heic', `品牌 ${brand}`);
  }
  if (brand === 'avif' || brand === 'avis') return sniffOf('avif', 'image/avif', 'avif');
  if (brand === 'M4A ' || brand === 'M4B ') return sniffOf('m4a', 'audio/mp4', 'm4a');
  if (brand === 'qt  ') return sniffOf('mov', 'video/quicktime', 'mov');
  // isom / iso2 / mp41 / mp42 / avc1 / dash…一律按 MP4 容器
  return sniffOf('mp4', 'video/mp4', 'mp4', `品牌 ${brand.trim() || '未知'}`);
}

// ─── 文本类启发式 ────────────────────────────────────────────────────────────

function textSniff(text: string): SniffResult {
  const t = text.replace(/^﻿/, '');
  const head = t.slice(0, 4096);
  const trimmed = head.trimStart();
  if (/^WEBVTT(\s|$)/.test(trimmed)) return sniffOf('vtt', 'text/vtt', 'vtt');
  if (trimmed.startsWith('[Script Info]')) return sniffOf('ass', 'text/x-ssa', 'ass');
  // SRT：序号行 + 时间码行
  if (/^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)) {
    return sniffOf('srt', 'application/x-subrip', 'srt');
  }
  if (/^<!doctype\s+html[\s>]/i.test(trimmed)) return sniffOf('html', 'text/html', 'html');
  if (/^<\?xml[\s?]/i.test(trimmed) || /^<[a-zA-Z][^>]*>/.test(trimmed) && /<\/[a-zA-Z]/.test(head)) {
    if (/<html[\s>]/i.test(head)) return sniffOf('html', 'text/html', 'html');
    return sniffOf('xml', 'application/xml', 'xml');
  }
  if (/^[{[]/.test(trimmed)) {
    // NDJSON：多行且每行都是 JSON
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines.every((l) => /^[{[]/.test(l.trim()))) {
      try {
        for (const l of lines.slice(0, 10)) JSON.parse(l);
        return sniffOf('ndjson', 'application/x-ndjson', 'jsonl');
      } catch {
        /* 落回 json 判定 */
      }
    }
    try {
      JSON.parse(t);
      return sniffOf('json', 'application/json', 'json');
    } catch {
      return sniffOf('json', 'application/json', 'json', '内容似 JSON 但未能完整解析');
    }
  }
  // CSV / TSV：多行、每行分隔符数量一致
  const lines = head.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length >= 2) {
    const tabs = lines.map((l) => (l.match(/\t/g) || []).length);
    const commas = lines.map((l) => (l.match(/,/g) || []).length);
    if (tabs[0] > 0 && tabs.every((n) => n === tabs[0])) return sniffOf('tsv', 'text/tab-separated-values', 'tsv');
    if (commas[0] > 0 && commas.every((n) => n === commas[0])) return sniffOf('csv', 'text/csv', 'csv');
  }
  // Markdown 启发：标题 / 列表 / 链接记号
  if (/^#{1,6}\s/m.test(head) || /^\s*[-*]\s+\[[ x]\]/m.test(head) || /\[[^\]]+\]\([^)]+\)/.test(head)) {
    return sniffOf('markdown', 'text/markdown', 'md');
  }
  if (/^(---|\.\.\.)\s*$/m.test(head) || /^[a-zA-Z_][\w-]*:\s/m.test(head)) {
    return sniffOf('yaml', 'application/yaml', 'yaml', 'YAML 为启发式识别');
  }
  return sniffOf('text', 'text/plain', 'txt');
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * 嗅探一段字节。**head 至少 4KiB**（小文件给全文）。
 * 返回的 kind 是「字节说了什么」，与文件名无关。
 */
export function sniffBytes(head: Uint8Array): SniffResult {
  if (head.length === 0) return UNKNOWN;

  // 位图
  if (startsWith(head, 0, [0xff, 0xd8, 0xff])) return sniffOf('jpeg', 'image/jpeg', 'jpg');
  if (startsWith(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return sniffOf('png', 'image/png', 'png');
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return sniffOf('gif', 'image/gif', 'gif');
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return sniffOf('webp', 'image/webp', 'webp');
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return sniffOf('wav', 'audio/wav', 'wav');
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'AVI ') return sniffOf('avi', 'video/x-msvideo', 'avi');
  if (ascii(head, 0, 2) === 'BM') return sniffOf('bmp', 'image/bmp', 'bmp');
  if (startsWith(head, 0, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return sniffOf('tiff', 'image/tiff', 'tiff');
  }
  if (startsWith(head, 0, [0x00, 0x00, 0x01, 0x00])) return sniffOf('ico', 'image/x-icon', 'ico');
  // ISOBMFF（ftyp）
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') return ftypSniff(head);
  // 音频
  if (ascii(head, 0, 4) === 'fLaC') return sniffOf('flac', 'audio/flac', 'flac');
  if (ascii(head, 0, 4) === 'OggS') return sniffOf('ogg', 'audio/ogg', 'ogg', 'Ogg 容器，编码待探测');
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
    return sniffOf('mp3', 'audio/mpeg', 'mp3');
  }
  if (ascii(head, 0, 4) === 'FORM' && ascii(head, 8, 4) === 'AIFF') return sniffOf('aiff', 'audio/aiff', 'aiff');
  // 视频
  if (startsWith(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return sniffOf('mkv', 'video/x-matroska', 'mkv', 'EBML 容器（MKV / WebM），编码待探测');
  }
  if (ascii(head, 0, 3) === 'FLV') return sniffOf('flv', 'video/x-flv', 'flv');
  if (startsWith(head, 0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) {
    return sniffOf('wmv', 'video/x-ms-asf', 'wmv');
  }
  // 文档
  if (ascii(head, 0, 5) === '%PDF-') return sniffOf('pdf', 'application/pdf', 'pdf');
  // OLE 复合文档（doc/xls/ppt）
  if (startsWith(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return sniffOf('doc', 'application/msword', 'doc', 'OLE 复合文档（doc / xls / ppt），具体类别由引擎区分');
  }
  // 压缩包
  if (startsWith(head, 0, [0x1f, 0x8b])) return sniffOf('gzip', 'application/gzip', 'gz', 'GZIP 流（可能是 TAR.GZ）');
  if (startsWith(head, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return sniffOf('xz', 'application/x-xz', 'xz');
  if (startsWith(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return sniffOf('7z', 'application/x-7z-compressed', '7z');
  if (ascii(head, 0, 7) === 'Rar!\x1a\x07\x00' || ascii(head, 0, 8) === 'Rar!\x1a\x07\x01\x00') {
    return sniffOf('rar', 'application/vnd.rar', 'rar');
  }
  if (startsWith(head, 0, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return sniffOf('zip', 'application/zip', 'zip', 'ZIP 容器（可能是 docx / xlsx / epub…，待读中央目录）');
  }
  // TAR：ustar 魔数在 257 偏移
  if (head.length > 265 && ascii(head, 257, 5) === 'ustar') return sniffOf('tar', 'application/x-tar', 'tar');

  // 文本类：BOM 与可打印性
  if (startsWith(head, 0, [0xef, 0xbb, 0xbf])) return { ...textSniff(te.decode(head)), detail: 'UTF-8 BOM' };
  if (startsWith(head, 0, [0xff, 0xfe]) || startsWith(head, 0, [0xfe, 0xff])) {
    return sniffOf('text', 'text/plain', 'txt', 'UTF-16 BOM');
  }
  // 含 NUL 或大量控制字符 → 不像文本
  let ctrl = 0;
  const sampleLen = Math.min(head.length, 2048);
  for (let i = 0; i < sampleLen; i++) {
    const c = head[i];
    if (c === 0) return UNKNOWN;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) ctrl++;
  }
  if (ctrl / sampleLen > 0.05) return UNKNOWN;
  // 可能有非 UTF-8 字节 —— textSniff 用宽容解码，识别结果里标注
  return textSniff(te.decode(head));
}

/**
 * 图片头部元信息（尺寸 / 动画标记）。非图片 kind 返回 {}。
 * head 需含完整头部（4KiB 一般够；TIFF 的 IFD 可能偏远，拿不到就返回 {}）。
 */
export function imageHeaderInfo(kind: FileKind, head: Uint8Array): ImageHeader {
  switch (kind) {
    case 'png': return pngHeader(head);
    case 'gif': return gifHeader(head);
    case 'jpeg': return jpegHeader(head);
    case 'webp': return webpHeader(head);
    case 'bmp': return bmpHeader(head);
    case 'tiff': return tiffHeader(head);
    case 'ico': return icoHeader(head);
    default: return {};
  }
}

/**
 * 组装 InspectInfo。`full` 是完整文件字节（小文件）或 null（大文件只读了头）。
 * ZIP 系容器在能拿到全文时进一步细分（docx / epub…）。
 */
export function buildInspectInfo(
  name: string,
  size: number,
  head: Uint8Array,
  full: Uint8Array | null
): InspectInfo {
  let sniff = sniffBytes(head);
  const info: InspectInfo = { sniff, name, size };

  if (sniff.kind === 'zip') {
    const bytes = full ?? head;
    const cd = readZipCentralDirectory(bytes);
    if (cd) {
      info.members = cd.members;
      if (cd.container !== 'zip') {
        const mimeMap = {
          docx: FORMATS_DOCX_MIME, xlsx: FORMATS_XLSX_MIME, pptx: FORMATS_PPTX_MIME,
          epub: 'application/epub+zip', odt: 'application/vnd.oasis.opendocument.text',
          ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
        } as const;
        sniff = { kind: cd.container, mime: mimeMap[cd.container as keyof typeof mimeMap] ?? 'application/zip', ext: cd.container, detail: 'ZIP 容器，按成员结构识别' };
        info.sniff = sniff;
      }
    }
  }

  const hdr = imageHeaderInfo(sniff.kind, head);
  if (hdr.width) info.width = hdr.width;
  if (hdr.height) info.height = hdr.height;
  if (hdr.animated !== undefined) info.animated = hdr.animated;

  return info;
}

// 避免循环 import：formats.ts 的 MIME 常量里用到的三个 Office MIME 直接写在这里
const FORMATS_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FORMATS_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FORMATS_PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
