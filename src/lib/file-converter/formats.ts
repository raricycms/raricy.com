// ─────────────────────────────────────────────────────────────────────────────
// file-converter/formats.ts —— 格式词表、限额与通用文案（零依赖）
//
// 【纪律】本文件**零 import**，node 单测与客户端共用。这里只放：
//   · 格式词汇（label / MIME / 扩展名）
//   · plan §7 的资源限额起始值（页面提示与校验读同一份）
//   · 限额相关的纯函数
// 引擎参数构造、嗅探逻辑在各自模块，别往这里塞。
// ─────────────────────────────────────────────────────────────────────────────

import type { ConvertMethod, FileKind } from './types';

/** 输出格式词表（`EdgeDef.to` 的合法键）。 */
export const FORMATS = {
  jpg: { label: 'JPG', mime: 'image/jpeg', ext: 'jpg' },
  png: { label: 'PNG', mime: 'image/png', ext: 'png' },
  webp: { label: 'WebP', mime: 'image/webp', ext: 'webp' },
  avif: { label: 'AVIF', mime: 'image/avif', ext: 'avif' },
  bmp: { label: 'BMP', mime: 'image/bmp', ext: 'bmp' },
  tiff: { label: 'TIFF', mime: 'image/tiff', ext: 'tiff' },
  ico: { label: 'ICO', mime: 'image/x-icon', ext: 'ico' },
  gif: { label: 'GIF', mime: 'image/gif', ext: 'gif' },
  apng: { label: 'APNG', mime: 'image/apng', ext: 'png' },
  mp3: { label: 'MP3', mime: 'audio/mpeg', ext: 'mp3' },
  wav: { label: 'WAV', mime: 'audio/wav', ext: 'wav' },
  flac: { label: 'FLAC', mime: 'audio/flac', ext: 'flac' },
  ogg: { label: 'OGG', mime: 'audio/ogg', ext: 'ogg' },
  m4a: { label: 'M4A', mime: 'audio/mp4', ext: 'm4a' },
  aiff: { label: 'AIFF', mime: 'audio/aiff', ext: 'aiff' },
  mp4: { label: 'MP4', mime: 'video/mp4', ext: 'mp4' },
  webm: { label: 'WebM', mime: 'video/webm', ext: 'webm' },
  mkv: { label: 'MKV', mime: 'video/x-matroska', ext: 'mkv' },
  mov: { label: 'MOV', mime: 'video/quicktime', ext: 'mov' },
  pdf: { label: 'PDF', mime: 'application/pdf', ext: 'pdf' },
  txt: { label: 'TXT', mime: 'text/plain', ext: 'txt' },
  md: { label: 'Markdown', mime: 'text/markdown', ext: 'md' },
  html: { label: 'HTML', mime: 'text/html', ext: 'html' },
  docx: { label: 'DOCX', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  pptx: { label: 'PPTX', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  xlsx: { label: 'XLSX', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  csv: { label: 'CSV', mime: 'text/csv', ext: 'csv' },
  tsv: { label: 'TSV', mime: 'text/tab-separated-values', ext: 'tsv' },
  json: { label: 'JSON', mime: 'application/json', ext: 'json' },
  ndjson: { label: 'NDJSON', mime: 'application/x-ndjson', ext: 'jsonl' },
  yaml: { label: 'YAML', mime: 'application/yaml', ext: 'yaml' },
  xml: { label: 'XML', mime: 'application/xml', ext: 'xml' },
  srt: { label: 'SRT', mime: 'application/x-subrip', ext: 'srt' },
  vtt: { label: 'WebVTT', mime: 'text/vtt', ext: 'vtt' },
  ass: { label: 'ASS', mime: 'text/x-ssa', ext: 'ass' },
  epub: { label: 'EPUB', mime: 'application/epub+zip', ext: 'epub' },
  zip: { label: 'ZIP', mime: 'application/zip', ext: 'zip' },
  gzip: { label: 'GZIP', mime: 'application/gzip', ext: 'gz' },
  tar: { label: 'TAR', mime: 'application/x-tar', ext: 'tar' },
  'tar.gz': { label: 'TAR.GZ', mime: 'application/gzip', ext: 'tar.gz' },
} as const;

export type FormatKey = keyof typeof FORMATS;

// ─── 资源限额（plan §7.1 起始值；其它能力区按同一思路扩展）────────────────────
//
// 这些值是 M0 的初始实验条件，**不是已测得的安全上限**。页面提示与校验读同一份值。
// 下调是安全的；上调要补测量记录。

export const LIMITS = {
  // 图片
  image: {
    maxBytes: 20 * 1024 * 1024,
    maxPixels: 16_000_000,
    maxSide: 8192,
  },
  // 音频
  audio: {
    maxBytes: 20 * 1024 * 1024,
    maxDurationSec: 300,
    maxChannels: 2,
    maxSampleRate: 48_000,
  },
  // 视频（roadmap §6.4：按时长 / 分辨率 / 编码一起限，不只看字节）
  video: {
    maxBytes: 100 * 1024 * 1024,
    maxDurationSec: 120,
    maxWidth: 1920,
    maxHeight: 1080,
  },
  // 文档 / PDF
  document: {
    maxBytes: 50 * 1024 * 1024,
    maxPages: 300,
    maxImagesToPdf: 50,
  },
  // 表格 / 数据
  table: {
    maxBytes: 20 * 1024 * 1024,
    maxRows: 200_000,
  },
  // 文本 / 字幕
  text: {
    maxBytes: 10 * 1024 * 1024,
  },
  // 电子书
  ebook: {
    maxBytes: 50 * 1024 * 1024,
  },
  // 压缩包（roadmap §11.2：限实际解压量、成员数、嵌套深度、压缩比）
  archive: {
    maxBytes: 100 * 1024 * 1024, // 压缩后
    maxMembers: 2000,
    maxTotalUncompressed: 500 * 1024 * 1024,
    maxDepth: 10,
    maxRatio: 100,
  },
  // 队列 / 预算（plan §7.1）
  queue: {
    maxTasks: 10,
    maxHeldInputs: 100 * 1024 * 1024,
    maxOutputEach: 64 * 1024 * 1024,
    maxOutputTotal: 64 * 1024 * 1024,
  },
  // 引擎超时（毫秒）
  timeouts: {
    ffmpegLoadMs: 60_000,
    probeMs: 15_000,
    transcodeAudioMs: 120_000,
    transcodeVideoMs: 600_000,
    ocrPageMs: 120_000,
    /** 单页 PDF 渲染（dpi 最高 300 时可能是几秒级）。 */
    pdfRenderMs: 120_000,
  },
} as const;

/** 可读的体积上限描述（错误信息与页面提示共用）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** MP3 码率档位（plan §3.3）。 */
export const MP3_BITRATES = [128, 192, 256, 320] as const;

/**
 * 六种转换方式的**人话说法**（roadmap §2）。
 *
 * 结果页必须把它显示出来：对用户来说「换封装（不重编码）」与「重新编码」是
 * 完全不同的两件事 —— 前者无损、后者有损，只说「转换完成」等于把最该说清的
 * 那条藏起来。`Record<ConvertMethod, string>` 保证加第七种方式时 tsc 报缺键。
 */
export const METHOD_LABELS: Record<ConvertMethod, string> = {
  remux: '换封装（不重编码）',
  reencode: '重新编码',
  reflow: '重新排版 / 结构转换',
  map: '数据映射',
  extract: '信息提取 / 重建',
  repack: '解包后重新打包',
};

/** 图片质量范围（plan §3.3：50–100 整数滑块，默认 90）。 */
export const IMAGE_QUALITY = { min: 50, max: 100, defaultValue: 90 } as const;

/** 音频采样率白名单（plan §7.1：白名单内且最高 48 kHz）。 */
export const AUDIO_SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const;

/** 文本编码词汇（roadmap §9.1）。decode 端靠浏览器 TextDecoder，encode 端靠 iconv-lite。 */
export const TEXT_ENCODINGS = [
  { key: 'utf-8', label: 'UTF-8' },
  { key: 'utf-16le', label: 'UTF-16 LE' },
  { key: 'utf-16be', label: 'UTF-16 BE' },
  { key: 'gbk', label: 'GBK' },
  { key: 'gb18030', label: 'GB18030' },
  { key: 'big5', label: 'Big5' },
  { key: 'shift_jis', label: 'Shift_JIS' },
  { key: 'euc-jp', label: 'EUC-JP' },
  { key: 'iso-8859-1', label: 'Latin-1' },
] as const;

export type TextEncodingKey = (typeof TEXT_ENCODINGS)[number]['key'];

/** FileKind → 所属能力区（嗅探后给「应去哪个标签页」的提示用）。 */
export const KIND_CATEGORY: Partial<Record<FileKind, string>> = {
  jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
  tiff: 'image', ico: 'image', svg: 'image', heic: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio', aiff: 'audio',
  mp4: 'video', mkv: 'video', webm: 'video', mov: 'video', avi: 'video', flv: 'video', wmv: 'video',
  pdf: 'document', docx: 'document', pptx: 'document', odt: 'document', odp: 'document',
  rtf: 'document', doc: 'document', ppt: 'document', html: 'document', markdown: 'document',
  xlsx: 'table', csv: 'table', tsv: 'table', json: 'table', ndjson: 'table',
  yaml: 'table', xml: 'table', ods: 'table', xls: 'table',
  text: 'text', srt: 'text', vtt: 'text', ass: 'text',
  epub: 'ebook',
  zip: 'archive', gzip: 'archive', xz: 'archive', tar: 'archive', '7z': 'archive', rar: 'archive',
};
