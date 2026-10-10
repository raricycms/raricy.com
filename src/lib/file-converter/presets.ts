// ─────────────────────────────────────────────────────────────────────────────
// file-converter/presets.ts —— 用途预设（roadmap §14）与固定配方（§12.4）
//
// 【纪律】纯数据：预设组合**已建设的边**，不是另起转换代码。`edgeId` 必须指向
// 登记册里真实存在的边（单测钉住）；用户改了参数后，结果说明以实际策略为准。
// ─────────────────────────────────────────────────────────────────────────────

import type { CategoryKey } from './types';

export interface PresetDef {
  id: string;
  /** 卡片标题（用途，不是格式名）。 */
  label: string;
  desc: string;
  category: CategoryKey;
  edgeId: string;
  params: Record<string, unknown>;
}

/** §14 的用途预设。 */
export const PRESETS: readonly PresetDef[] = [
  {
    id: 'share-photo',
    label: '手机照片发给别人',
    desc: 'HEIC / AVIF / WebP → JPG，统一宽度、不携带位置元数据',
    category: 'image',
    edgeId: 'image:to-jpg',
    params: { quality: 90, background: '#ffffff', maxWidth: 2560 },
  },
  {
    id: 'keep-alpha',
    label: '保留透明背景',
    desc: '转成 PNG，透明区域原样保留',
    category: 'image',
    edgeId: 'image:to-png',
    params: {},
  },
  {
    id: 'web-small',
    label: '图片放网页',
    desc: '缩放后转 WebP / AVIF，显示实际体积',
    category: 'image',
    edgeId: 'image:to-webp',
    params: { maxWidth: 1280, quality: 82 },
  },
  {
    id: 'voice-compat',
    label: '语音给旧播放器',
    desc: 'OGG / OPUS → MP3，广泛兼容（有损重编码）',
    category: 'audio',
    edgeId: 'audio:to-mp3',
    params: { bitrate: '192' },
  },
  {
    id: 'edit-wav',
    label: '音频交给编辑软件',
    desc: '解码为 16 位 PCM WAV（不提升原音质）',
    category: 'audio',
    edgeId: 'audio:to-wav',
    params: {},
  },
  {
    id: 'video-sound',
    label: '视频只要声音',
    desc: '选音轨 → 能换封装则抽取，否则转码',
    category: 'video',
    edgeId: 'video:extract-audio',
    params: { format: 'mp3' },
  },
  {
    id: 'play-anywhere',
    label: '视频换播放器',
    desc: '探测轨道 → 兼容直接复制进 MP4，不兼容的转码',
    category: 'video',
    edgeId: 'video:remux-to-mp4',
    params: {},
  },
  {
    id: 'motion-gif',
    label: '做短动图',
    desc: '选片段 → 缩放 / 降帧 → GIF / 动画 WebP（没有声音）',
    category: 'video',
    edgeId: 'video:to-gif',
    params: { fps: 10, maxWidth: 480 },
  },
  {
    id: 'photos-pdf',
    label: '多张照片做资料包',
    desc: '按顺序排版成 A4 PDF（图片型，无 OCR）',
    category: 'document',
    edgeId: 'pdf:images-to-pdf',
    params: { pageSize: 'a4' },
  },
  {
    id: 'pdf-pages',
    label: 'PDF 发几页图片',
    desc: '选页码 → 按分辨率导出 PNG / JPG',
    category: 'document',
    edgeId: 'pdf:pdf-to-images',
    params: { format: 'png', dpi: '144' },
  },
  {
    id: 'scan-text',
    label: '扫描资料取文字',
    desc: '分页渲染 → OCR → 可校对 TXT（可能有错字）',
    category: 'document',
    edgeId: 'pdf:scan-to-text',
    params: { lang: 'chi_sim+eng' },
  },
  {
    id: 'data-json',
    label: '表格给程序处理',
    desc: '选工作表 → 列类型映射 → JSON / NDJSON',
    category: 'table',
    edgeId: 'table:to-json',
    params: {},
  },
  {
    id: 'novel-epub',
    label: '小说在阅读器看',
    desc: 'Markdown / DOCX → EPUB（可重排，无固定页码）',
    category: 'ebook',
    edgeId: 'ebook:md-to-epub',
    params: {},
  },
  {
    id: 'old-archive',
    label: '老压缩包换通用格式',
    desc: 'RAR / 7Z → 解包校验 → ZIP',
    category: 'archive',
    edgeId: 'archive:to-zip',
    params: {},
  },
];

/** §12.4 的固定配方 = 预设 + 完成后打包方式。首批固定，不做任意脚本编排。 */
export const RECIPES: readonly (PresetDef & { packaging: 'zip' | 'gzip' })[] = [
  {
    id: 'recipe-heic-share',
    label: '一组 HEIC → JPG → ZIP',
    desc: '统一宽度与背景 → 按原名编号 → 打包',
    category: 'image',
    edgeId: 'image:to-jpg',
    params: { quality: 90, background: '#ffffff', maxWidth: 2560 },
    packaging: 'zip',
  },
  {
    id: 'recipe-video-mp3',
    label: '视频 → MP3',
    desc: '选一条音轨 → 转码 → 下载',
    category: 'video',
    edgeId: 'video:extract-audio',
    params: { format: 'mp3', bitrate: '192' },
    packaging: 'zip',
  },
  {
    id: 'recipe-photos-pdf',
    label: '照片 → A4 PDF',
    desc: '按用户顺序 → 页面尺寸 / 边距 → 单文件',
    category: 'document',
    edgeId: 'pdf:images-to-pdf',
    params: { pageSize: 'a4', margin: 'normal' },
    packaging: 'zip',
  },
  {
    id: 'recipe-scan-txt',
    label: '扫描 PDF → 中文 OCR → TXT',
    desc: '选页码 → 页面图 → OCR → 可校对文本',
    category: 'document',
    edgeId: 'pdf:scan-to-text',
    params: { lang: 'chi_sim+eng' },
    packaging: 'zip',
  },
  {
    id: 'recipe-xlsx-jsonl-gz',
    label: 'XLSX → JSONL → GZIP',
    desc: '选工作表 → 列类型 → 行式 JSON → 压缩',
    category: 'table',
    edgeId: 'table:to-ndjson',
    params: {},
    packaging: 'gzip',
  },
  {
    id: 'recipe-epub-md-zip',
    label: 'EPUB → Markdown 资源包',
    desc: '按章节顺序读取 → Markdown + 图片资源 → ZIP',
    category: 'ebook',
    edgeId: 'ebook:epub-to-md',
    params: {},
    packaging: 'zip',
  },
];
