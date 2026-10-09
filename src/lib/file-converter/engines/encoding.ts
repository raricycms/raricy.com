// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/encoding.ts —— 文本字符编码的解码 / 编码 / 检测（零 DOM）
//
// 【它是什么】roadmap §9.1 的底座：
//   · decodeText：字节 → 文本。UTF 系走浏览器原生 TextDecoder，其余（GBK /
//     GB18030 / Big5 / Shift_JIS / EUC-JP / Latin-1）走 iconv-lite（**动态 import**，
//     静态引入会把编码表卷进每个页面的主包）。
//   · encodeText：文本 → 字节。UTF-8 走 TextEncoder，UTF-16 LE / BE 手写字（见下），
//     其余走 iconv-lite。
//   · detectEncoding：给「自动检测」一个**带置信度**的答案，而不是假装知道。
//
// 【纪律】
//   · BOM 一律在解码前剥掉，并在返回值里报告 detectedBom —— 调用方据此写 notice。
//   · 不支持的参考：UTF-16**BE** 在 Node 与部分浏览器的 TextDecoder 里并不保证存在，
//     所以这里不赌它存在：把 BE 字节序在**自写的一小段**里换序成 LE 再交给
//     TextDecoder('utf-16le')，代理对（surrogate pair）因此天然正确。
//   · 编码探测是**候选判断**，不是事实。confident=false 时调用方必须提示用户
//     「编码是猜的，乱码请手动选」（roadmap §9.1 明确要求，不把乱码当正确结果）。
//   · 目标编码写不出的字符：iconv-lite 默认替换为 "?"，**不报错**。hasUnrepresentable
//     用「编码后再原路解码回来」比对来发现这种静默替换，供结果页如实标注
//     （roadmap §9.1 X03：不能静默变问号）。
//   · 本文件零运行时依赖（iconv-lite 是**动态** import），node 单测直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { TEXT_ENCODINGS } from '../formats';

/** 编码键（formats.ts 的 TEXT_ENCODINGS 的 key 联合）。 */
export type EncodingKey = (typeof TEXT_ENCODINGS)[number]['key'];

/** 有 BOM 概念的三种编码。 */
export type BomEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface BomInfo {
  encoding: BomEncoding;
  length: number;
}

/** 识别 BOM（只认 UTF-8 / UTF-16 LE / BE；本站不支持 UTF-32）。 */
export function detectBom(bytes: Uint8Array): BomInfo | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    // 注意：FF FE 00 00 是 UTF-32LE 的 BOM。本站不提供 UTF-32，仍按 UTF-16LE 解读
    // （后面跟的 00 00 会被当 U+0000 解出，这是「选了不支持的编码」的可见后果）。
    return { encoding: 'utf-16le', length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', length: 2 };
  }
  return null;
}

/** 把 TEXT_ENCODINGS 的 key 与常见别名归一。 */
export function normalizeEncoding(enc: string): string {
  const e = enc.trim().toLowerCase().replace(/_/g, '-');
  if (e === 'utf8' || e === 'utf-8') return 'utf-8';
  if (e === 'utf16le' || e === 'utf-16le' || e === 'ucs-2') return 'utf-16le';
  if (e === 'utf16be' || e === 'utf-16be') return 'utf-16be';
  return e; // gbk / gb18030 / big5 / shift-jis / euc-jp / iso-8859-1，原样交给 iconv-lite
}

export interface DecodeResult {
  text: string;
  /** 被剥掉的 BOM 是哪种编码；没有 BOM 就是 null。 */
  detectedBom: BomEncoding | null;
  /** 实际用来解码的编码（'auto' 已解析成具体编码）。 */
  encoding: string;
}

/** UTF-16 解码：BE 先在自写的一小段里换成 LE，再交给原生 TextDecoder。 */
function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let body: Uint8Array = bytes;
  if (!littleEndian) {
    const swapped = new Uint8Array(bytes.length);
    const even = bytes.length & ~1;
    for (let i = 0; i < even; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    if (bytes.length & 1) swapped[bytes.length - 1] = bytes[bytes.length - 1];
    body = swapped;
  }
  return new TextDecoder('utf-16le', { fatal: false }).decode(body);
}

/**
 * 解码字节 → 文本。BOM 一律剥掉（不进入文本），并在返回值里报告。
 * `encoding` 传 'auto' 时：有 BOM 就按 BOM，没有就退回 UTF-8（调用方**应当**
 * 先调 detectEncoding 再传具体编码，这里只是兜底）。
 */
export async function decodeText(bytes: Uint8Array, encoding: string): Promise<DecodeResult> {
  const bom = detectBom(bytes);
  const body = bom ? bytes.subarray(bom.length) : bytes;
  const enc = encoding === 'auto' ? (bom ? bom.encoding : 'utf-8') : normalizeEncoding(encoding);

  let text: string;
  if (enc === 'utf-8') {
    text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  } else if (enc === 'utf-16le' || enc === 'utf-16be') {
    text = decodeUtf16(body, enc === 'utf-16le');
  } else {
    const iconv = await import('iconv-lite');
    // iconv-lite 运行时自己会把非 Buffer 转成 Buffer；这里的断言只是让 TS 满意
    // （类型只在编译期使用，client 包里没有 Buffer 值也不会出问题）。
    text = iconv.decode(body as unknown as Buffer, enc);
  }
  return { text, detectedBom: bom ? bom.encoding : null, encoding: enc };
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) {
    // charCodeAt 逐 code unit（代理对的两个 code unit 也各自成对写入），恰好是 UTF-16。
    dv.setUint16(i * 2, text.charCodeAt(i), littleEndian);
  }
  return out;
}

function bomBytesOf(enc: string): Uint8Array<ArrayBuffer> | null {
  if (enc === 'utf-8') return new Uint8Array([0xef, 0xbb, 0xbf]);
  if (enc === 'utf-16le') return new Uint8Array([0xff, 0xfe]);
  if (enc === 'utf-16be') return new Uint8Array([0xfe, 0xff]);
  return null;
}

/** 该编码是否支持 BOM（供调用方决定要不要给「输出带 BOM」提示）。 */
export function encodingSupportsBom(enc: string): boolean {
  const e = normalizeEncoding(enc);
  return e === 'utf-8' || e === 'utf-16le' || e === 'utf-16be';
}

export interface EncodeOptions {
  /** UTF 系才有效；GBK 等没有 BOM 概念，会被忽略。 */
  bom?: boolean;
}

/**
 * 文本 → 字节。返回的视图由**普通 ArrayBuffer** 支撑（TS 5.7 起 `new Blob([u8])`
 * 要求如此），各调用点不必再各自收窄。
 */
export async function encodeText(
  text: string,
  encoding: string,
  opts: EncodeOptions = {}
): Promise<Uint8Array<ArrayBuffer>> {
  const enc = normalizeEncoding(encoding);

  let body: Uint8Array<ArrayBuffer>;
  if (enc === 'utf-8') {
    body = new TextEncoder().encode(text);
  } else if (enc === 'utf-16le') {
    body = encodeUtf16(text, true);
  } else if (enc === 'utf-16be') {
    body = encodeUtf16(text, false);
  } else {
    const iconv = await import('iconv-lite');
    // 复制一份（iconv 返回的是带偏移的 Buffer 视图），确保底层是普通 ArrayBuffer。
    const buf = iconv.encode(text, enc);
    body = new Uint8Array(buf.byteLength);
    body.set(buf);
  }

  if (opts.bom) {
    const bom = bomBytesOf(enc);
    if (bom) {
      const out = new Uint8Array(bom.length + body.length);
      out.set(bom, 0);
      out.set(body, bom.length);
      return out;
    }
    // 非 UTF 目标：BOM 无意义，忽略（调用方负责说明这一项被忽略）。
  }
  return body;
}

export type DetectReason = 'bom' | 'utf-8' | 'heuristic';

export interface DetectResult {
  encoding: string;
  /** false = 靠启发式猜的，调用方**必须**提示用户手动确认可源编码。 */
  confident: boolean;
  reason: DetectReason;
}

/**
 * GBK 双字节分布的合理性打分：高位字节里有多少是「合法 GBK 前导 + 合法后继」的成对。
 * 返回 0..1。GBK 前导 0x81–0xFE；后继 0x40–0x7E 或 0x80–0xFE。
 */
function gbkPlausibility(bytes: Uint8Array): number {
  let high = 0;
  let pairs = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c < 0x80) continue;
    high++;
    const next = bytes[i + 1];
    const isLead = c >= 0x81 && c <= 0xfe;
    const isTrail = next !== undefined && ((next >= 0x40 && next <= 0x7e) || (next >= 0x80 && next <= 0xfe));
    if (isLead && isTrail) {
      pairs++;
      i++;
    }
  }
  if (high === 0) return 0;
  return (pairs * 2) / high;
}

/**
 * 编码探测。顺序：BOM → UTF-8 fatal 试解 → GBK 双字节启发式。
 * 猜不出时**仍然给 gbk 而不是静默当 UTF-8** —— 给一个可被用户改写的候选，
 * 且在 confident=false 时由调用方提示「编码是猜的」。这样即使猜错，用户也能改。
 */
export function detectEncoding(bytes: Uint8Array): DetectResult {
  const bom = detectBom(bytes);
  if (bom) return { encoding: bom.encoding, confident: true, reason: 'bom' };
  if (bytes.length === 0) return { encoding: 'utf-8', confident: true, reason: 'utf-8' };

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf-8', confident: true, reason: 'utf-8' };
  } catch {
    /* 不是合法 UTF-8，继续猜 */
  }

  // 启发式：GBK 双字节布局合理 → 报 GBK；否则报 GB18030（超集，对中文更宽容）。
  // 两者都是**候选**，confident=false，调用方必须提示用户手动确认。
  const score = gbkPlausibility(bytes);
  return { encoding: score >= 0.6 ? 'gbk' : 'gb18030', confident: false, reason: 'heuristic' };
}

/**
 * 目标编码是否写不全这段文本（会被 iconv-lite 静默替换成 "?"）。
 * 判据是「编码后再原路解码回来，与原文不同即视为有损」。UTF 系永不丢失，直接 false。
 */
export async function hasUnrepresentable(text: string, encoding: string): Promise<boolean> {
  const enc = normalizeEncoding(encoding);
  if (enc === 'utf-8' || enc === 'utf-16le' || enc === 'utf-16be') return false;
  const iconv = await import('iconv-lite');
  const encoded = iconv.encode(text, enc);
  const back = iconv.decode(encoded, enc);
  return back !== text;
}
