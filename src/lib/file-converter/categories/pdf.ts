// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/pdf.ts —— 文档能力区的 **PDF 半边**（roadmap §7.2 / §7.3）。
//
// 【范围】九条边，全部围绕 PDF：
//   · 导出：PDF → 逐页图片（D08）；PDF → 文字（D10）
//   · 排版：图片 / 照片 → PDF（D09）
//   · 页面操作：合并、拆分、重排旋转（§7.3）
//   · 重建：压缩（栅格化）、扫描件 → 可搜索 PDF（D12）、扫描件 → 文字（D11）
//
// 【引擎】PDF.js（渲染 + getTextContent）与 pdf-lib（结构操作）都在
//   ../engines/pdf.ts，**动态 import**（静态引入会把两个大库卷进主包）。
//   版面几何（页面尺寸 / 边距 / 适配 / 页码编排）是零依赖的 ../engines/pdf-layout.ts。
//   OCR 走 ../engines/ocr.ts（tesseract.js，本文件只调用它冻结的签名）。
//
// 【诚实边界】roadmap §15：notices 如实列出损失。尤其：
//   · 一切「图片型输出」= 文字变像素，不可选不可搜；
//   · 压缩 = 栅格化（重的那一句必写）；
//   · 可搜索 PDF 的文字层是整页一段不可见文字（不可逐字定位），且**当前构建没有可嵌入的
//     中文字体**，含中文的页写不进文字层（如实告知，见 contractRequests）。
//
// 【限额】LIMITS.document：单文件 ≤ 50 MiB、≤ 300 页（打开后判）、图片成 PDF ≤ 50 张。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, formatBytes } from '../formats';
import { sniffBytes } from '../inspect';
import type { OcrLang } from '../engines/ocr';
import type { CategoryDef, ConvertError, ConvertResultData, ParamOption, RunContext } from '../types';
import { convertedName, parsePageRange, sanitizeBase, uniqueOutputName, withTimeout } from '../utils';
import {
  ZIP_PAGE_THRESHOLD,
  estimateRasterBytes,
  orderNotices,
  parsePageOrder,
  shouldZipPages,
  splitRangeLines,
} from '../engines/pdf-layout';
import type { RasterPage } from '../engines/pdf';

// ─── 通用小件 ─────────────────────────────────────────────────────────────────

const MULTI_FILE_HINT = '多文件仅「合并 PDF」与「图片成 PDF」支持';

function unsupported(message: string): ConvertError {
  return { kind: 'unsupported', message };
}

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

function capabilityErr(message: string): ConvertError {
  return { kind: 'capability', message };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

/** 单文件边的多文件守卫（maxFilesPerTask=50 是为合并 / 图片成 PDF 开的）。 */
function assertSingleFile(ctx: RunContext): void {
  if (ctx.files.length !== 1) {
    throw unsupported(`该目标一次只处理一个 PDF 文件（当前选了 ${ctx.files.length} 个）；${MULTI_FILE_HINT}`);
  }
}

function checkInputBytes(file: File): void {
  if (file.size > LIMITS.document.maxBytes) {
    throw oversize(`文件 ${formatBytes(file.size)} 超过 ${formatBytes(LIMITS.document.maxBytes)} 上限`);
  }
}

function checkPageLimit(numPages: number): void {
  if (numPages > LIMITS.document.maxPages) {
    throw oversize(`PDF 共 ${numPages} 页，超过 ${LIMITS.document.maxPages} 页上限`);
  }
}

async function bytesOf(file: File): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer());
}

/** select 参数：白名单内的字符串照用，否则回退。 */
function strParam(params: Record<string, unknown>, key: string, allowed: readonly string[], fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && allowed.includes(v) ? v : fallback;
}

function textParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : '';
}

function numParam(params: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = params[key];
  const n =
    typeof v === 'number' && Number.isFinite(v)
      ? v
      : typeof v === 'string' && v.trim() !== ''
        ? Number(v)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function naturalOrder(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, i) => i + 1);
}

// ─── 导出图片（D08）────────────────────────────────────────────────────────────

type RasterFormat = 'png' | 'jpeg' | 'webp';

const IMG_SPEC: Record<RasterFormat, { mime: string; ext: string; bpp: number; label: string }> = {
  png: { mime: 'image/png', ext: 'png', bpp: 1.5, label: 'PNG' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', bpp: 0.3, label: 'JPG' },
  webp: { mime: 'image/webp', ext: 'webp', bpp: 0.25, label: 'WebP' },
};

const DPI_OPTIONS: ParamOption[] = ['72', '96', '144', '216', '300'].map((d) => ({
  value: d,
  label: `${d} dpi`,
}));

// ─── 图片成 PDF（D09）─────────────────────────────────────────────────────────

const IMAGE_KINDS = ['png', 'jpeg', 'webp'] as const;

/** WebP → PNG（先 canvas 转，再交给 pdf-lib embedPng）。 */
async function webpToPng(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  throwIfAborted(signal);
  const blob = new Blob([bytes], { type: 'image/webp' });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw { kind: 'corrupt', message: 'WebP 图片解码失败，文件可能损坏', detail: e instanceof Error ? e.message : String(e) } satisfies ConvertError;
  }
  const canvas = document.createElement('canvas');
  try {
    throwIfAborted(signal);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const c = canvas.getContext('2d');
    if (!c) throw capabilityErr('无法创建 Canvas 2D 上下文');
    c.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    throwIfAborted(signal);
    if (!png || png.size === 0 || png.type !== 'image/png') {
      throw capabilityErr('WebP 转 PNG 失败（浏览器未能编码）');
    }
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

// ─── OCR 公共件（D11 / D12）───────────────────────────────────────────────────

const OCR_LANGS = ['chi_sim+eng', 'chi_sim', 'eng'] as const;
const OCR_LANG_LABEL: Record<string, string> = {
  'chi_sim+eng': '简体中文 + 英文',
  chi_sim: '简体中文',
  eng: '英文',
};

const OCR_RENDER_DPI = 200;

/** 合并上限（task 规定 ≤ 20；比类别 maxFilesPerTask=50 更严）。 */
const MERGE_MAX_FILES = 20;

async function renderPagesForOcr(
  doc: { numPages: number; renderPage: (n: number, opts: { dpi: number; mime: string; signal?: AbortSignal }) => Promise<{ blob: Blob }> },
  pageNumbers: number[],
  ctx: RunContext
): Promise<Blob[]> {
  const blobs: Blob[] = [];
  for (let i = 0; i < pageNumbers.length; i++) {
    throwIfAborted(ctx.signal);
    const r = await doc.renderPage(pageNumbers[i], { dpi: OCR_RENDER_DPI, mime: 'image/png', signal: ctx.signal });
    blobs.push(r.blob);
    ctx.onProgress((i + 1) / pageNumbers.length, `渲染第 ${pageNumbers[i]} 页`);
  }
  return blobs;
}

async function runOcr(blobs: Blob[], lang: string, ctx: RunContext): Promise<string[]> {
  throwIfAborted(ctx.signal);
  const { ocrImages } = await import('../engines/ocr');
  const budget = LIMITS.timeouts.ocrPageMs * Math.max(1, blobs.length);
  return withTimeout(
    ocrImages(blobs, lang as OcrLang, { signal: ctx.signal, onProgress: (p, m) => ctx.onProgress(p, m) }),
    budget,
    '文字识别超时，请减少页数后重试'
  );
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

export const CATEGORY: CategoryDef = {
  key: 'document',
  label: '文档 / PDF',
  hint: 'PDF 逐页导出图片、图片成 PDF、PDF 抽文字、合并 / 拆分 / 重排旋转 / 压缩、扫描件 OCR。图片型输出与压缩会栅格化，文字不可再选中；结果页如实标注。文件只在本机处理。',
  accept: '.pdf,.jpg,.jpeg,.png,.webp',
  maxFilesPerTask: 50,
  edges: [
    // ── 导出图片 ──────────────────────────────────────────────────────────────
    {
      id: 'pdf:pdf-to-images',
      label: '逐页图片（PNG / JPG / WebP）',
      from: ['pdf'],
      to: 'png',
      method: 'extract',
      notices: ['输出为图片：原 PDF 的文字层不再保留（图里的字不能选中或搜索）'],
      params: [
        {
          key: 'format',
          label: '图片格式',
          type: 'select',
          options: [
            { value: 'png', label: 'PNG（无损，体积大）' },
            { value: 'jpeg', label: 'JPG（有损，体积小）' },
            { value: 'webp', label: 'WebP（体积最小）' },
          ],
          defaultValue: 'png',
        },
        { key: 'dpi', label: '分辨率', type: 'select', options: DPI_OPTIONS, defaultValue: '144', help: '越高越清晰、体积越大' },
        {
          key: 'pages',
          label: '页码',
          type: 'text',
          defaultValue: '',
          help: '留空 = 全部页；可写 1-3,5,8-',
        },
      ],
      requires: ['worker'],
      estimateOutput: (info, params) => {
        const format = strParam(params, 'format', ['png', 'jpeg', 'webp'], 'png') as RasterFormat;
        const dpi = parseInt(strParam(params, 'dpi', ['72', '96', '144', '216', '300'], '144'), 10);
        const pageCount = typeof info.pageCount === 'number' ? info.pageCount : null;
        if (pageCount === null) return null;
        const pagesText = typeof params.pages === 'string' ? params.pages : '';
        const count = pagesText.trim() ? parsePageRange(pagesText, pageCount)?.length ?? null : pageCount;
        if (count === null) return null;
        return estimateRasterBytes({ pageCount: count, dpi, bytesPerPixel: IMG_SPEC[format].bpp });
      },
      run: async (ctx) => {
        assertSingleFile(ctx);
        const file = ctx.file;
        checkInputBytes(file);
        const format = strParam(ctx.params, 'format', ['png', 'jpeg', 'webp'], 'png') as RasterFormat;
        const spec = IMG_SPEC[format];
        const dpi = parseInt(strParam(ctx.params, 'dpi', ['72', '96', '144', '216', '300'], '144'), 10);
        if (format === 'webp' && !ctx.capabilities.webpEncode) {
          throw capabilityErr('当前浏览器不支持编码 WebP，请改用 PNG 或 JPG');
        }
        const pagesText = textParam(ctx.params, 'pages');

        ctx.onPhase('loading-engine');
        const { openPdfDocument } = await import('../engines/pdf');
        const bytes = await bytesOf(file);
        const doc = await openPdfDocument(bytes, ctx.signal);
        try {
          checkPageLimit(doc.numPages);
          const pages = parsePageRange(pagesText, doc.numPages);
          if (!pages) throw unsupported('页码范围语法有误，请用「1-3,5,8-」这样的写法（留空表示全部页）');
          if (pages.length === 0) throw unsupported('选中的页码为空');

          ctx.onPhase('converting');
          const rendered: { blob: Blob; page: number }[] = [];
          for (let i = 0; i < pages.length; i++) {
            throwIfAborted(ctx.signal);
            const r = await doc.renderPage(pages[i], {
              dpi,
              mime: spec.mime,
              quality: format === 'png' ? undefined : 0.92,
              signal: ctx.signal,
            });
            rendered.push({ blob: r.blob, page: pages[i] });
            ctx.onProgress((i + 1) / pages.length, `渲染第 ${pages[i]} 页`);
          }
          throwIfAborted(ctx.signal);
          return await packPageImages(ctx, rendered, spec, dpi);
        } finally {
          await doc.destroy();
        }
      },
      status: 'live',
      group: '导出图片',
    },

    // ── 图片成 PDF ────────────────────────────────────────────────────────────
    {
      id: 'pdf:images-to-pdf',
      label: '多张图片排版成 PDF',
      from: [...IMAGE_KINDS],
      to: 'pdf',
      method: 'reflow',
      notices: [
        '生成的是图片型 PDF：页面里的文字不可选中、不可搜索（未做 OCR）',
        '图片保持原始像素嵌入（不重编码）；WebP 输入会先转为 PNG',
      ],
      params: [
        {
          key: 'pageSize',
          label: '页面尺寸',
          type: 'select',
          options: [
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: 'US Letter' },
            { value: 'original', label: '跟随图片尺寸' },
          ],
          defaultValue: 'a4',
        },
        {
          key: 'margin',
          label: '边距',
          type: 'select',
          options: [
            { value: 'none', label: '无' },
            { value: 'narrow', label: '窄' },
            { value: 'normal', label: '常规' },
          ],
          defaultValue: 'normal',
        },
        {
          key: 'orientation',
          label: '方向',
          type: 'select',
          options: [
            { value: 'auto', label: '自动（跟随图片）' },
            { value: 'portrait', label: '纵向' },
            { value: 'landscape', label: '横向' },
          ],
          defaultValue: 'auto',
          advanced: true,
        },
      ],
      requires: [],
      run: async (ctx) => {
        const files = ctx.files;
        if (files.length < 1) throw unsupported('请至少选择一张图片');
        if (files.length > LIMITS.document.maxImagesToPdf) {
          throw oversize(`一次最多把 ${LIMITS.document.maxImagesToPdf} 张图片合成 PDF（当前 ${files.length} 张）`);
        }
        const pageSize = strParam(ctx.params, 'pageSize', ['a4', 'letter', 'original'], 'a4');
        const margin = strParam(ctx.params, 'margin', ['none', 'narrow', 'normal'], 'normal');
        const orientation = strParam(ctx.params, 'orientation', ['auto', 'portrait', 'landscape'], 'auto');

        ctx.onPhase('loading-engine');
        const { buildPhotoPdf } = await import('../engines/pdf');
        ctx.onPhase('converting');
        const items: { data: Uint8Array<ArrayBuffer>; kind: 'png' | 'jpeg' }[] = [];
        for (let i = 0; i < files.length; i++) {
          throwIfAborted(ctx.signal);
          const f = files[i];
          checkInputBytes(f);
          const bytes = await bytesOf(f);
          const kind = sniffBytes(bytes.subarray(0, Math.min(bytes.length, 4096))).kind;
          if (kind === 'jpeg') items.push({ data: bytes, kind: 'jpeg' });
          else if (kind === 'png') items.push({ data: bytes, kind: 'png' });
          else if (kind === 'webp') items.push({ data: await webpToPng(bytes, ctx.signal), kind: 'png' });
          else throw unsupported(`${f.name} 不是支持的图片（仅 PNG / JPG / WebP）`);
          ctx.onProgress((i + 1) / files.length, `准备第 ${i + 1} 张`);
        }
        throwIfAborted(ctx.signal);
        const pdfBytes = await buildPhotoPdf(items, { pageSize, margin, orientation }, ctx.signal);
        const name = convertedName(ctx.file.name, 'pdf', new Set());
        const pageLabel = pageSize === 'a4' ? 'A4' : pageSize === 'letter' ? 'US Letter' : '图片原尺寸';
        return {
          outputs: [{ blob: new Blob([pdfBytes], { type: FORMATS.pdf.mime }), name, note: `${items.length} 页` }],
          mime: FORMATS.pdf.mime,
          ext: 'pdf',
          inputSize: files.reduce((s, f) => s + f.size, 0),
          outputSize: pdfBytes.byteLength,
          notices: [
            '生成的是图片型 PDF：页面里的文字不可选中、不可搜索（未做 OCR）',
            `页面 ${pageLabel}；图片按选择顺序排列，等比缩放居中`,
            'WebP 输入会先转为 PNG；其余图片保持原始字节嵌入（不重编码）',
          ],
          previewKind: 'none',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '图片成 PDF',
    },

    // ── 文字提取 ──────────────────────────────────────────────────────────────
    {
      id: 'pdf:pdf-to-text',
      label: 'PDF 提取文字（TXT）',
      from: ['pdf'],
      to: 'txt',
      method: 'extract',
      notices: [
        '按文字对象提取：复杂排版 / 多栏的阅读顺序可能与视觉顺序不一致',
        '图片与矢量图形里的字不是文字对象，不会被提取',
      ],
      params: [],
      requires: ['worker'],
      run: async (ctx) => {
        assertSingleFile(ctx);
        checkInputBytes(ctx.file);
        ctx.onPhase('loading-engine');
        const { openPdfDocument } = await import('../engines/pdf');
        const bytes = await bytesOf(ctx.file);
        const doc = await openPdfDocument(bytes, ctx.signal);
        try {
          checkPageLimit(doc.numPages);
          ctx.onPhase('converting');
          const parts: string[] = [];
          for (let i = 1; i <= doc.numPages; i++) {
            throwIfAborted(ctx.signal);
            parts.push((await doc.extractText(i)).trim());
            ctx.onProgress(i / doc.numPages, `提取第 ${i} 页`);
          }
          const text = parts.join('\n\n').trim();
          if (!text) {
            throw unsupported('未提取到任何文字 —— 这可能是扫描件（图像里没有文字对象）；请改用「扫描件取文字（OCR）」');
          }
          const encoded = new TextEncoder().encode(text);
          const name = convertedName(ctx.file.name, 'txt', new Set());
          return {
            outputs: [{ blob: new Blob([encoded], { type: FORMATS.txt.mime }), name }],
            mime: FORMATS.txt.mime,
            ext: 'txt',
            inputSize: ctx.file.size,
            outputSize: encoded.byteLength,
            notices: [
              '按文字对象提取：复杂排版 / 多栏的阅读顺序可能与视觉顺序不一致',
              '图片与矢量图形里的字不是文字对象，不会被提取',
            ],
            previewKind: 'text',
          } satisfies ConvertResultData;
        } finally {
          await doc.destroy();
        }
      },
      status: 'live',
      group: '文字提取',
    },
    {
      id: 'pdf:scan-to-text',
      label: '扫描件取文字（OCR → TXT，需校对）',
      from: ['pdf'],
      to: 'txt',
      method: 'extract',
      notices: ['OCR 可能有错字，请对照原文校对'],
      params: [
        {
          key: 'lang',
          label: '识别语言',
          type: 'select',
          options: OCR_LANGS.map((l) => ({ value: l, label: OCR_LANG_LABEL[l] })),
          defaultValue: 'chi_sim+eng',
        },
        { key: 'pages', label: '页码', type: 'text', defaultValue: '', help: '留空 = 全部页；可写 1-3,5' },
      ],
      requires: ['worker'],
      run: async (ctx) => {
        assertSingleFile(ctx);
        checkInputBytes(ctx.file);
        const lang = strParam(ctx.params, 'lang', OCR_LANGS, 'chi_sim+eng');
        const pagesText = textParam(ctx.params, 'pages');

        ctx.onPhase('loading-engine');
        const { openPdfDocument } = await import('../engines/pdf');
        const bytes = await bytesOf(ctx.file);
        const doc = await openPdfDocument(bytes, ctx.signal);
        try {
          checkPageLimit(doc.numPages);
          const pages = parsePageRange(pagesText, doc.numPages);
          if (!pages) throw unsupported('页码范围语法有误，请用「1-3,5」这样的写法（留空表示全部页）');
          ctx.onPhase('converting');
          const blobs = await renderPagesForOcr(doc, pages, ctx);
          const texts = await runOcr(blobs, lang, ctx);
          throwIfAborted(ctx.signal);
          const body = pages
            .map((p, i) => `—— 第 ${p} 页 ——\n${(texts[i] ?? '').trim()}`)
            .join('\n\n')
            .trim();
          if (!body.replace(/——\s*第\s*\d+\s*页\s*——/g, '').trim()) {
            throw unsupported('OCR 未识别出任何文字，请确认页面清晰度或更换识别语言');
          }
          const encoded = new TextEncoder().encode(body);
          const name = convertedName(ctx.file.name, 'txt', new Set());
          return {
            outputs: [{ blob: new Blob([encoded], { type: FORMATS.txt.mime }), name }],
            mime: FORMATS.txt.mime,
            ext: 'txt',
            inputSize: ctx.file.size,
            outputSize: encoded.byteLength,
            notices: [
              '结果全部来自 OCR（原扫描件没有文字层），可能有错字，请校对',
              '页与页之间以「—— 第 N 页 ——」分隔',
              `识别语言：${OCR_LANG_LABEL[lang]}`,
            ],
            previewKind: 'text',
          } satisfies ConvertResultData;
        } finally {
          await doc.destroy();
        }
      },
      status: 'live',
      group: '文字提取',
    },

    // ── 页面操作 ──────────────────────────────────────────────────────────────
    {
      id: 'pdf:pdf-merge',
      label: '合并 PDF（按选择顺序）',
      from: ['pdf'],
      to: 'pdf',
      method: 'reflow',
      notices: ['按选择顺序拼接各文件的所有页', '原书签、表单、注释与数字签名不保留'],
      params: [],
      requires: [],
      run: async (ctx) => {
        const files = ctx.files;
        if (files.length < 2) throw unsupported('合并至少需要选择两个 PDF 文件');
        if (files.length > MERGE_MAX_FILES) throw oversize(`一次最多合并 ${MERGE_MAX_FILES} 个 PDF（当前 ${files.length} 个）`);
        ctx.onPhase('loading-engine');
        const { mergePdfs } = await import('../engines/pdf');
        const sources: Uint8Array<ArrayBuffer>[] = [];
        for (const f of files) {
          throwIfAborted(ctx.signal);
          checkInputBytes(f);
          const bytes = await bytesOf(f);
          if (sniffBytes(bytes.subarray(0, Math.min(bytes.length, 4096))).kind !== 'pdf') {
            throw unsupported(`${f.name} 不是 PDF 文件`);
          }
          sources.push(bytes);
        }
        ctx.onPhase('converting');
        const { bytes: merged, totalPages } = await mergePdfs(sources, ctx.signal);
        checkPageLimit(totalPages);
        const name = convertedName(ctx.file.name, 'pdf', new Set());
        return {
          outputs: [{ blob: new Blob([merged], { type: FORMATS.pdf.mime }), name, note: `${totalPages} 页` }],
          mime: FORMATS.pdf.mime,
          ext: 'pdf',
          inputSize: files.reduce((s, f) => s + f.size, 0),
          outputSize: merged.byteLength,
          notices: ['按选择顺序拼接各文件的所有页', '原书签、表单、注释与数字签名不保留'],
          previewKind: 'none',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '页面操作',
    },
    {
      id: 'pdf:pdf-split',
      label: '拆分 PDF（每段范围一个文件）',
      from: ['pdf'],
      to: 'pdf',
      method: 'extract',
      notices: ['原 PDF 不变；每段范围导出为一个独立 PDF', '书签、表单、注释与数字签名不保留'],
      params: [
        {
          key: 'ranges',
          label: '拆分范围（每行一段）',
          type: 'text',
          defaultValue: '',
          help: '每行输出一个 PDF，如 1-3 / 5 / 8-',
        },
      ],
      requires: [],
      run: async (ctx) => {
        assertSingleFile(ctx);
        checkInputBytes(ctx.file);
        const lines = splitRangeLines(textParam(ctx.params, 'ranges'));
        if (lines.length === 0) throw unsupported('请填写拆分范围，每行一段（如 1-3）');

        ctx.onPhase('loading-engine');
        const engines = await import('../engines/pdf');
        const bytes = await bytesOf(ctx.file);
        const pageCount = await engines.getPdfPageCount(bytes);
        checkPageLimit(pageCount);
        const groups: number[][] = [];
        for (const line of lines) {
          const g = parsePageRange(line, pageCount);
          if (!g) throw unsupported(`拆分范围「${line}」语法有误，或超出总页数 ${pageCount}`);
          groups.push(g);
        }
        ctx.onPhase('converting');
        const parts = await engines.splitPdfToGroups(bytes, groups, ctx.signal);
        const taken = new Set<string>();
        const outputs = parts.map((b, i) => ({
          blob: new Blob([b], { type: FORMATS.pdf.mime }),
          name: uniqueOutputName(`${sanitizeBase(ctx.file.name)}-part${i + 1}`, 'pdf', taken),
          note: `第 ${i + 1} 段（${groups[i].length} 页）`,
        }));
        return {
          outputs,
          mime: FORMATS.pdf.mime,
          ext: 'pdf',
          inputSize: ctx.file.size,
          outputSize: outputs.reduce((s, o) => s + o.blob.size, 0),
          notices: ['原 PDF 不变；每段范围导出为一个独立 PDF', '书签、表单、注释与数字签名不保留'],
          previewKind: 'none',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '页面操作',
    },
    {
      id: 'pdf:pdf-reorder-rotate',
      label: '重排 / 旋转页面',
      from: ['pdf'],
      to: 'pdf',
      method: 'reflow',
      notices: ['按指定顺序重组页面；未列出的页会被丢弃', '书签、表单、注释与数字签名不保留'],
      params: [
        {
          key: 'order',
          label: '页面顺序',
          type: 'text',
          defaultValue: '',
          help: '逗号分隔，如 3,1,2；留空 = 原顺序',
        },
        {
          key: 'rotate',
          label: '旋转',
          type: 'select',
          options: [
            { value: '0', label: '不旋转' },
            { value: '90', label: '顺时针 90°' },
            { value: '180', label: '180°' },
            { value: '270', label: '顺时针 270°' },
          ],
          defaultValue: '0',
        },
      ],
      requires: [],
      run: async (ctx) => {
        assertSingleFile(ctx);
        checkInputBytes(ctx.file);
        const orderText = textParam(ctx.params, 'order').trim();
        const rotate = parseInt(strParam(ctx.params, 'rotate', ['0', '90', '180', '270'], '0'), 10);

        ctx.onPhase('loading-engine');
        const engines = await import('../engines/pdf');
        const bytes = await bytesOf(ctx.file);
        const pageCount = await engines.getPdfPageCount(bytes);
        checkPageLimit(pageCount);

        let sequence: number[];
        let notices: string[];
        if (!orderText) {
          sequence = naturalOrder(pageCount);
          notices = ['保持原页面顺序'];
        } else {
          const result = parsePageOrder(orderText, pageCount);
          if (!result) throw unsupported('页面顺序写法有误，请用「3,1,2」这样的页码列表（留空表示原顺序）');
          if (result.sequence.length === 0) throw unsupported('没有可用的页码（列出的页码都超出范围）');
          sequence = result.sequence;
          notices = orderNotices(result);
          if (notices.length === 0) notices = ['按指定顺序重组页面'];
        }
        notices.push(rotate ? `所有页面统一旋转 ${rotate}°（覆盖此前的旋转设置）` : '保持原页面旋转');
        notices.push('书签、表单、注释与数字签名不保留');

        ctx.onPhase('converting');
        const out = await engines.reorderAndRotate(bytes, sequence, rotate, ctx.signal);
        const name = convertedName(ctx.file.name, 'pdf', new Set());
        return {
          outputs: [{ blob: new Blob([out], { type: FORMATS.pdf.mime }), name, note: `${sequence.length} 页` }],
          mime: FORMATS.pdf.mime,
          ext: 'pdf',
          inputSize: ctx.file.size,
          outputSize: out.byteLength,
          notices,
          previewKind: 'none',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '页面操作',
    },

    // ── 压缩 / 重建 ───────────────────────────────────────────────────────────
    {
      id: 'pdf:pdf-compress',
      label: '压缩 PDF（栅格化重编码）',
      from: ['pdf'],
      to: 'pdf',
      method: 'reencode',
      notices: [
        '文字层与矢量图形被栅格化，压缩后不可再选中或搜索文字（这是压缩的代价）',
        '页面被重新渲染为 JPEG（有损），放大后会看到模糊',
      ],
      params: [
        {
          key: 'dpi',
          label: '分辨率',
          type: 'select',
          options: [
            { value: '72', label: '72 dpi（最小）' },
            { value: '96', label: '96 dpi（推荐）' },
            { value: '144', label: '144 dpi（较清晰）' },
          ],
          defaultValue: '96',
        },
        { key: 'quality', label: 'JPEG 质量', type: 'range', min: 50, max: 100, step: 1, unit: '%', defaultValue: 75 },
      ],
      requires: ['worker'],
      run: async (ctx) => {
        assertSingleFile(ctx);
        checkInputBytes(ctx.file);
        const dpi = parseInt(strParam(ctx.params, 'dpi', ['72', '96', '144'], '96'), 10);
        const quality = numParam(ctx.params, 'quality', 75, 50, 100);

        ctx.onPhase('loading-engine');
        const { openPdfDocument, buildRasterPdf } = await import('../engines/pdf');
        const bytes = await bytesOf(ctx.file);
        const doc = await openPdfDocument(bytes, ctx.signal);
        try {
          checkPageLimit(doc.numPages);
          ctx.onPhase('converting');
          const pages: RasterPage[] = [];
          for (let i = 1; i <= doc.numPages; i++) {
            throwIfAborted(ctx.signal);
            const size = await doc.pageSizePt(i);
            const r = await doc.renderPage(i, { dpi, mime: 'image/jpeg', quality: quality / 100, signal: ctx.signal });
            pages.push({
              data: new Uint8Array(await r.blob.arrayBuffer()),
              kind: 'jpeg',
              widthPt: size.width,
              heightPt: size.height,
            });
            ctx.onProgress(i / doc.numPages, `重渲染第 ${i} 页`);
          }
          const { bytes: outBytes } = await buildRasterPdf(pages, ctx.signal, (p) => ctx.onProgress(p));
          const notices = [
            '文字层与矢量图形被栅格化，压缩后不可再选中或搜索文字（这是压缩的代价）',
            `按 ${dpi} dpi 重新渲染为 JPEG（质量 ${quality}）`,
            '书签、表单、注释与数字签名不保留',
          ];
          if (outBytes.byteLength >= ctx.file.size) {
            notices.push('压缩后反而更大（原文档已高度压缩，本方式对这类文件无效）');
          }
          const name = convertedName(ctx.file.name, 'pdf', new Set());
          return {
            outputs: [{ blob: new Blob([outBytes], { type: FORMATS.pdf.mime }), name, note: `${pages.length} 页` }],
            mime: FORMATS.pdf.mime,
            ext: 'pdf',
            inputSize: ctx.file.size,
            outputSize: outBytes.byteLength,
            notices,
            previewKind: 'none',
          } satisfies ConvertResultData;
        } finally {
          await doc.destroy();
        }
      },
      status: 'live',
      group: '压缩 / 重建',
    },
    {
      id: 'pdf:pdf-to-searchable',
      label: '扫描件做成可搜索 PDF（OCR 文字层）',
      from: ['pdf'],
      to: 'pdf',
      method: 'reencode',
      notices: ['OCR 可能有错字；文字层是整页一段不可见文字，不能逐字定位'],
      params: [
        {
          key: 'lang',
          label: '识别语言',
          type: 'select',
          options: OCR_LANGS.map((l) => ({ value: l, label: OCR_LANG_LABEL[l] })),
          defaultValue: 'chi_sim+eng',
        },
      ],
      requires: ['worker'],
      run: async (ctx) => {
        assertSingleFile(ctx);
        checkInputBytes(ctx.file);
        const lang = strParam(ctx.params, 'lang', OCR_LANGS, 'chi_sim+eng');

        ctx.onPhase('loading-engine');
        const { openPdfDocument, buildRasterPdf } = await import('../engines/pdf');
        const bytes = await bytesOf(ctx.file);
        const doc = await openPdfDocument(bytes, ctx.signal);
        try {
          checkPageLimit(doc.numPages);
          const allPages = naturalOrder(doc.numPages);
          ctx.onPhase('converting');
          const blobs: Blob[] = [];
          const sizes: { width: number; height: number }[] = [];
          for (let i = 0; i < allPages.length; i++) {
            throwIfAborted(ctx.signal);
            const size = await doc.pageSizePt(allPages[i]);
            const r = await doc.renderPage(allPages[i], { dpi: OCR_RENDER_DPI, mime: 'image/png', signal: ctx.signal });
            blobs.push(r.blob);
            sizes.push(size);
            ctx.onProgress(((i + 1) / allPages.length) * 0.6, `渲染第 ${allPages[i]} 页`);
          }
          const texts = await runOcr(blobs, lang, ctx);
          throwIfAborted(ctx.signal);
          const pages: RasterPage[] = [];
          for (let i = 0; i < blobs.length; i++) {
            pages.push({
              data: new Uint8Array(await blobs[i].arrayBuffer()),
              kind: 'png',
              widthPt: sizes[i].width,
              heightPt: sizes[i].height,
              text: texts[i] ?? '',
            });
          }
          const { bytes: outBytes, pagesSkippedText } = await buildRasterPdf(pages, ctx.signal, (p) =>
            ctx.onProgress(0.6 + p * 0.4)
          );
          const notices = [
            'OCR 可能有错字；本页文字层用于搜索 / 复制，不能逐字定位',
            '文字层是整页一段不可见文字，复制顺序可能与视觉顺序不同',
            '页面被栅格化为图片，原有矢量与文字对象不再保留；签名与原文档身份会改变',
          ];
          if (pagesSkippedText > 0) {
            notices.push(
              `${pagesSkippedText} 页含当前字体无法编码的字符（如中文），这些页未写入文字层（只有图像）`
            );
          }
          const name = convertedName(ctx.file.name, 'pdf', new Set());
          return {
            outputs: [{ blob: new Blob([outBytes], { type: FORMATS.pdf.mime }), name, note: `${pages.length} 页` }],
            mime: FORMATS.pdf.mime,
            ext: 'pdf',
            inputSize: ctx.file.size,
            outputSize: outBytes.byteLength,
            notices,
            previewKind: 'none',
          } satisfies ConvertResultData;
        } finally {
          await doc.destroy();
        }
      },
      status: 'live',
      group: '压缩 / 重建',
    },
  ],
};

// ─── 导出图片的打包（pdf:pdf-to-images 用；抽到外面只为读起来短一截）──────────

async function packPageImages(
  ctx: RunContext,
  rendered: { blob: Blob; page: number }[],
  spec: { mime: string; ext: string; label: string },
  dpi: number
): Promise<ConvertResultData> {
  const file = ctx.file;
  const base = sanitizeBase(file.name);
  const commonNotice = '输出为图片：原 PDF 的文字层不再保留（图里的字不能选中或搜索）';
  const dpiNotice = `按 ${dpi} dpi 渲染`;
  if (shouldZipPages(rendered.length)) {
    const { zipSync } = await import('fflate');
    const members: Record<string, Uint8Array> = {};
    for (const { blob, page } of rendered) {
      members[`${base}-p${pad3(page)}.${spec.ext}`] = new Uint8Array(await blob.arrayBuffer());
    }
    const zipped = zipSync(members, { level: 0 }) as Uint8Array<ArrayBuffer>;
    const name = convertedName(file.name, 'zip', new Set());
    return {
      outputs: [{ blob: new Blob([zipped], { type: FORMATS.zip.mime }), name, note: `共 ${rendered.length} 页` }],
      mime: FORMATS.zip.mime,
      ext: 'zip',
      inputSize: file.size,
      outputSize: zipped.byteLength,
      notices: [commonNotice, dpiNotice, `页数超过 ${ZIP_PAGE_THRESHOLD}，已打包为一个 ZIP（仅存储，不二次压缩）`],
      previewKind: 'none',
    };
  }
  const taken = new Set<string>();
  const outputs = rendered.map(({ blob, page }) => ({
    blob,
    name: uniqueOutputName(`${base}-p${pad3(page)}`, spec.ext, taken),
    note: `第 ${page} 页`,
  }));
  return {
    outputs,
    mime: spec.mime,
    ext: spec.ext,
    inputSize: file.size,
    outputSize: outputs.reduce((s, o) => s + o.blob.size, 0),
    notices: [commonNotice, dpiNotice, `共导出 ${rendered.length} 页 ${spec.label} 图片`],
    previewKind: 'image',
  };
}
