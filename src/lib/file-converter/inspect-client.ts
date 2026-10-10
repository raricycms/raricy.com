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

/** 复核输出字节与声明格式一致（plan §6.4「不能把生成了一段字节当成可用文件」）。 */
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
  return accepted.includes(sniff.kind);
}
