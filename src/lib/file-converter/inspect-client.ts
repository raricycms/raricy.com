// ─────────────────────────────────────────────────────────────────────────────
// file-converter/inspect-client.ts —— inspect.ts 的 File 包装（仅客户端）
//
// 读头 64KiB 嗅探；ZIP 系容器需要中央目录（在文件尾部）—— 小文件读全文，
// 大文件定点读尾部 EOCD + CD 区段，不为识别把 100MB 包整个读进内存。
// ─────────────────────────────────────────────────────────────────────────────

import { buildInspectInfo, parseCdEntries, parseEocd, readZipCentralDirectory, sniffBytes } from './inspect';
import type { ArchiveMemberInfo, InspectInfo } from './types';

const HEAD_BYTES = 64 * 1024;
const FULL_READ_MAX = 32 * 1024 * 1024;
const TAIL_READ = 256 * 1024;

export async function inspectFileClient(file: File): Promise<InspectInfo> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const full = file.size <= FULL_READ_MAX ? new Uint8Array(await file.arrayBuffer()) : null;
  const info = buildInspectInfo(file.name, file.size, head, full);

  // 大 ZIP：buildInspectInfo 只拿到头部，补一次定点 CD 读取
  if (info.sniff.kind === 'zip' && !full && !info.members) {
    const members = await readCdTargeted(file);
    if (members) info.members = members;
  }
  return info;
}

async function readCdTargeted(file: File): Promise<ArchiveMemberInfo[] | null> {
  try {
    const tailSize = Math.min(TAIL_READ, file.size);
    const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
    const eocd = parseEocd(tail);
    if (!eocd || eocd.cdOffset + eocd.cdSize > file.size) return null;
    const cd = new Uint8Array(await file.slice(eocd.cdOffset, eocd.cdOffset + eocd.cdSize).arrayBuffer());
    return parseCdEntries(cd, eocd.count);
  } catch {
    return null;
  }
}

/**
 * 像「无 BOM 的 UTF-16 文本」吗？R3-502。
 *
 * `sniffBytes` 的通用规则是「含 NUL → unknown」（对二进制是对的），而无 BOM 的
 * UTF-16 文本每隔一字节就是 0x00，于是被整类判成 unknown；`text:convert-encoding`
 * 在默认（不勾 BOM）下选 UTF-16 目标时，输出复核必然判「格式不符」→ 任务失败。
 * 这里只做**输出复核**用的窄放宽：采样里一半位置几乎全是 NUL，就认作 UTF-16 文本。
 */
function looksLikeUtf16Text(head: Uint8Array): boolean {
  const sampleLen = Math.min(head.length, 2048);
  if (sampleLen < 4) return false;
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (head[i] !== 0) continue;
    if (i % 2 === 0) zeroEven += 1;
    else zeroOdd += 1;
  }
  const half = Math.floor(sampleLen / 2);
  // UTF-16LE：奇数位多为 0；UTF-16BE：偶数位多为 0。留 20% 余量给非 ASCII 文本。
  return half > 0 && (zeroEven >= half * 0.8 || zeroOdd >= half * 0.8);
}

/** 复核输出字节与声明格式一致（format-converter-implementation §6.4「不能把生成了一段字节当成可用文件」）。 */
export async function verifyOutputBytes(blob: Blob, expectExt: string): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const sniff = sniffBytes(head);
  const map: Record<string, string[]> = {
    jpg: ['jpeg'], png: ['png'], webp: ['webp'], avif: ['avif'], gif: ['gif'], bmp: ['bmp'],
    tiff: ['tiff'], ico: ['ico'], mp3: ['mp3'], wav: ['wav'], flac: ['flac'], ogg: ['ogg'],
    m4a: ['m4a', 'mp4'], aiff: ['aiff'], mp4: ['mp4'], webm: ['webm', 'mkv'], mkv: ['mkv', 'webm'],
    mov: ['mov', 'mp4'], pdf: ['pdf'], zip: ['zip', 'docx', 'xlsx', 'pptx', 'epub'],
    gz: ['gzip'], tar: ['tar'], 'tar.gz': ['gzip'],
    docx: ['docx', 'zip'], xlsx: ['xlsx', 'zip'], pptx: ['pptx', 'zip'], epub: ['epub', 'zip'],
    txt: ['text', 'csv', 'tsv', 'json', 'ndjson', 'xml', 'yaml', 'srt', 'vtt', 'ass', 'markdown', 'html'],
    md: ['markdown', 'text'], html: ['html', 'xml', 'text'],
    csv: ['csv', 'text'], tsv: ['tsv', 'text'], json: ['json'], jsonl: ['ndjson', 'json'],
    yaml: ['yaml', 'text'], xml: ['xml'],
    srt: ['srt', 'text'], vtt: ['vtt'], ass: ['ass'],
  };
  const accepted = map[expectExt];
  if (!accepted) return blob.size > 0;
  if (accepted.includes(sniff.kind)) return true;
  // 文本类输出的窄放宽（R3-502）：无 BOM 的 UTF-16 被嗅探判成 unknown，但字节形态
  // 明确是 UTF-16 文本时应当接受。`text:convert-encoding` 保留**源文件扩展名**
  // （.json/.csv 换编码输出的 ext 仍按源名），所以按「文本类扩展名」判断而不是只看
  // accepted 里有没有 'text'；二进制输出（图片/音视频/压缩包）不在这个集合里。
  if (
    sniff.kind === 'unknown' &&
    looksLikeUtf16Text(head) &&
    (accepted.includes('text') || TEXT_OUTPUT_EXTS.has(expectExt))
  ) {
    return true;
  }
  return false;
}

/** 字符编码转换会保留源扩展名的文本类格式（与 cats/text.ts 的 accept 对齐）。 */
const TEXT_OUTPUT_EXTS = new Set([
  'txt',
  'md',
  'html',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'xml',
  'srt',
  'vtt',
  'ass',
]);
