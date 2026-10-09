// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/pdf.ts —— PDF 处理引擎（**浏览器专用**）。
//
// 【它是什么】两条引擎的封装：
//   · PDF.js（pdfjs-dist）：把页面渲染成像素、抽取文字对象（D08 / D10 / D11 / D12）；
//   · pdf-lib：合并 / 拆分 / 重排旋转 / 图片成 PDF / 回写不可见文字层
//     （D08 / D09 / D12）。
//   纯几何（页面尺寸 / 边距 / 适配 / 页码编排）在 pdf-layout.ts，本文件只「拿去画」。
//
// 【纪律】
//   · 重依赖（pdfjs-dist / pdf-lib）一律函数体内 `await import(...)` —— 静态引入会把
//     两个大库卷进每个页面的主包。
//   · 用户文件字节绝不出站：本文件**没有任何网络请求**。pdfjs 的 worker 从同源
//     /static/converter/pdfjs/ 加载；不设 cMapUrl / standardFontDataUrl（没有对应资产，
//     设了反而会去取一个不存在的路径）。
//   · 资源必须释放：page.cleanup()、doc.destroy()、canvas 用完置宽高 0。
//   · 渲染用 dpi 换算：scale = dpi / 72（pdf-lib 与 PDF 坐标都是 pt，1pt = 1/72in）。
//
// 【诚实边界】`pdf:pdf-to-searchable` 的不可见文字层用 pdf-lib 的标准字体（Helvetica /
//   WinAnsi 编码）书写 —— 它**写不了中文等非 Latin 字符**。遇到写不进的页，该页退回
//   「只有图像、没有文字层」，并由调用方如实告知（见 contractRequests：需要内嵌 CID 字体
//   + fontkit 才能覆盖中文）。这不是 bug，是本构建下没有可嵌入的中文字体资产。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from '../formats';
import type { ConvertError } from '../types';
import { classifyError, withTimeout } from '../utils';
import { fitContain, marginPoints, resolvePageBox, type PageBox } from './pdf-layout';

const PDFJS_WORKER_SRC = '/static/converter/pdfjs/pdf.worker.min.mjs';

/** 单页渲染超时（渲染是本地 CPU，正常几百毫秒；给宽裕值免得大图误杀）。 */
const RENDER_TIMEOUT_MS = LIMITS.timeouts.pdfRenderMs;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

function cancelled(): ConvertError {
  return { kind: 'cancelled', message: '已取消' };
}

function corrupt(message: string, detail?: string): ConvertError {
  return { kind: 'corrupt', message, detail };
}

function capability(message: string, detail?: string): ConvertError {
  return { kind: 'capability', message, detail };
}

function cleanupCanvas(canvas: HTMLCanvasElement): void {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* 某些实现会拒绝置零，忽略 */
  }
}

// ─── PDF.js：渲染与文字抽取 ────────────────────────────────────────────────────

type PdfJsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/** 加载 PDF.js 并指向同源 worker（只做一次）。 */
async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import('pdfjs-dist');
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
      return mod;
    })().catch((e) => {
      pdfjsPromise = null;
      throw { kind: 'engine-load', message: 'PDF 渲染组件加载失败，请刷新重试', detail: String(e) } satisfies ConvertError;
    });
  }
  return pdfjsPromise;
}

export interface RenderedPage {
  blob: Blob;
  width: number;
  height: number;
}

export interface RenderOptions {
  dpi: number;
  mime: string;
  quality?: number;
  signal?: AbortSignal;
}

/** 一个已打开的 PDF：调用方驱动逐页循环，结束时**必须** destroy()。 */
export interface PdfDocHandle {
  numPages: number;
  /** 页面在 72 dpi 下的可见尺寸（pt，已含旋转）。 */
  pageSizePt(pageNumber: number): Promise<PageBox>;
  renderPage(pageNumber: number, opts: RenderOptions): Promise<RenderedPage>;
  /** 抽取该页的文字对象（无文字层返回空串）。 */
  extractText(pageNumber: number): Promise<string>;
  destroy(): Promise<void>;
}

/** 打开 PDF（内部把字节拷一份 —— pdfjs 会把 buffer transfer 给 worker，原数组会被 neuter）。 */
export async function openPdfDocument(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfDocHandle> {
  throwIfAborted(signal);
  const pdfjs = await loadPdfJs();
  throwIfAborted(signal);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    // 不设 cMapUrl / standardFontDataUrl：/static/converter/ 下没有这些资产，
    // 设了反而会去取一个 404 的路径（离线 / 内网必须可跑）。
    verbosity: 0,
  });
  let doc: import('pdfjs-dist').PDFDocumentProxy;
  try {
    doc = await withTimeout(loadingTask.promise, LIMITS.timeouts.probeMs, '打开 PDF 超时');
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    throw classifyError(e, 'PDF 无法打开：文件可能损坏、已加密，或不是标准 PDF');
  }
  throwIfAborted(signal);

  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    try {
      await doc.destroy();
    } catch {
      /* 已释放 */
    }
    try {
      await loadingTask.destroy();
    } catch {
      /* 已释放 */
    }
  };

  return {
    numPages: doc.numPages,
    async pageSizePt(pageNumber) {
      const page = await doc.getPage(pageNumber);
      try {
        const vp = page.getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      } finally {
        page.cleanup();
      }
    },
    async renderPage(pageNumber, opts) {
      throwIfAborted(opts.signal);
      const page = await doc.getPage(pageNumber);
      const canvas = document.createElement('canvas');
      try {
        const scale = opts.dpi / 72;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const c2d = canvas.getContext('2d');
        if (!c2d) throw capability('无法创建 Canvas 2D 上下文');
        // JPEG / WebP 无透明通道：先铺白底，否则透明区会被压成黑色。
        c2d.fillStyle = '#ffffff';
        c2d.fillRect(0, 0, canvas.width, canvas.height);
        const task = page.render({ canvasContext: c2d, viewport });
        const onAbort = () => {
          try {
            task.cancel();
          } catch {
            /* 已结束 */
          }
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await withTimeout(task.promise, RENDER_TIMEOUT_MS, '渲染页面超时');
        } catch (e) {
          if (opts.signal?.aborted) throw cancelled();
          throw classifyError(e, 'PDF 页面渲染失败');
        } finally {
          opts.signal?.removeEventListener('abort', onAbort);
        }
        throwIfAborted(opts.signal);
        const blob = await canvasToBlob(canvas, opts.mime, opts.quality, opts.signal);
        return { blob, width: canvas.width, height: canvas.height };
      } finally {
        cleanupCanvas(canvas);
        page.cleanup();
      }
    },
    async extractText(pageNumber) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        return joinTextItems(content.items as unknown as PdfTextItemLike[]);
      } finally {
        page.cleanup();
      }
    },
    destroy,
  };
}

/** canvas.toBlob 包装：核对返回类型（浏览器对不支持的编码会**静默回退 PNG**）。 */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number | undefined,
  signal?: AbortSignal
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (signal?.aborted) {
          reject(cancelled());
          return;
        }
        if (!blob || blob.size === 0) {
          reject(capability('浏览器未能编码该页图片'));
          return;
        }
        if (blob.type !== mime) {
          reject(capability('当前浏览器不支持编码为该图片格式', `请求 ${mime}，实际 ${blob.type || '未知'}`));
          return;
        }
        resolve(blob);
      },
      mime,
      quality
    );
  });
}

interface PdfTextItemLike {
  str?: string;
  dir?: string;
  width?: number;
  height?: number;
  transform?: number[];
  hasEOL?: boolean;
}

/** 把文字对象拼成可读文本：靠 x 间距补空格、靠 y 跳变 / hasEOL 补换行。 */
function joinTextItems(items: PdfTextItemLike[]): string {
  let out = '';
  let prevEndX = 0;
  let prevY = 0;
  let started = false;
  for (const it of items) {
    if (typeof it.str !== 'string') continue; // 标记内容，跳过
    if (it.str.length === 0) {
      if (it.hasEOL) out += '\n';
      continue;
    }
    const tr = it.transform ?? [1, 0, 0, it.height ?? 10, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const h = Math.abs(it.height ?? tr[3] ?? 10) || 10;
    if (started && !out.endsWith('\n')) {
      if (Math.abs(y - prevY) > h * 0.5) out += '\n';
      else if (x - prevEndX > h * 0.25) out += ' ';
    }
    out += it.str;
    prevEndX = x + (it.width ?? 0);
    prevY = y;
    started = true;
    if (it.hasEOL) out += '\n';
  }
  return out;
}

// ─── pdf-lib：结构操作 ─────────────────────────────────────────────────────────

type PdfLib = typeof import('pdf-lib');
type PdfDoc = Awaited<ReturnType<PdfLib['PDFDocument']['load']>>;

let pdfLibPromise: Promise<PdfLib> | null = null;

async function loadPdfLib(): Promise<PdfLib> {
  if (!pdfLibPromise) {
    pdfLibPromise = (async () => await import('pdf-lib'))().catch((e) => {
      pdfLibPromise = null;
      throw { kind: 'engine-load', message: 'PDF 组件加载失败，请刷新重试', detail: String(e) } satisfies ConvertError;
    });
  }
  return pdfLibPromise;
}

/** 打开一个 PDF 供 pdf-lib 处理；加密文件给明确文案，不静默产出坏结果。 */
async function loadPdfDoc(PDFDocument: PdfLib['PDFDocument'], bytes: Uint8Array): Promise<PdfDoc> {
  try {
    return await PDFDocument.load(bytes);
  } catch (e) {
    if ((e as { name?: string })?.name === 'EncryptedPDFError') {
      throw { kind: 'unsupported', message: '该 PDF 已加密（受密码保护），暂不支持处理' } satisfies ConvertError;
    }
    throw classifyError(e, 'PDF 无法打开：文件可能损坏，或不是标准 PDF');
  }
}

/** pdf-lib 的 save() 返回的视图收窄成 ArrayBuffer 支撑（TS 5.7 的 Blob 只收这个）。 */
function asBytes(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return u as Uint8Array<ArrayBuffer>;
}

export interface MergeResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** 合并后的总页数（调用方据此判文档页数上限）。 */
  totalPages: number;
}

/** 按顺序合并多个 PDF，并回报总页数。 */
export async function mergePdfs(sources: Uint8Array[], signal?: AbortSignal): Promise<MergeResult> {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  let totalPages = 0;
  for (const src of sources) {
    throwIfAborted(signal);
    const doc = await loadPdfDoc(PDFDocument, src);
    totalPages += doc.getPageCount();
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return { bytes: asBytes(await out.save()), totalPages };
}

/** 只读地取一个 PDF 的页数（pdf-lib 打开一次，为页码解析 / 上限判断提供 max）。 */
export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await loadPdfLib();
  const doc = await loadPdfDoc(PDFDocument, bytes);
  return doc.getPageCount();
}

/** 每个范围段导出成一个 PDF（页码 1 起）。 */
export async function splitPdfToGroups(
  bytes: Uint8Array,
  groups: number[][],
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>[]> {
  const { PDFDocument } = await loadPdfLib();
  const src = await loadPdfDoc(PDFDocument, bytes);
  const results: Uint8Array<ArrayBuffer>[] = [];
  for (const group of groups) {
    throwIfAborted(signal);
    const dst = await PDFDocument.create();
    const pages = await dst.copyPages(src, group.map((n) => n - 1));
    for (const p of pages) dst.addPage(p);
    results.push(asBytes(await dst.save()));
  }
  return results;
}

/** 按 sequence（1 起，可重复）重排页面，并统一设定旋转角（0 表示保持原样）。 */
export async function reorderAndRotate(
  bytes: Uint8Array,
  sequence: number[],
  rotationDeg: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const { PDFDocument, degrees } = await loadPdfLib();
  const src = await loadPdfDoc(PDFDocument, bytes);
  const dst = await PDFDocument.create();
  for (const pageNumber of sequence) {
    throwIfAborted(signal);
    // 逐页拷贝：同一页可被重复引用（copyPages 在同一批里给重复索引行为不稳）。
    const [p] = await dst.copyPages(src, [pageNumber - 1]);
    if (rotationDeg) p.setRotation(degrees(rotationDeg));
    dst.addPage(p);
  }
  return asBytes(await dst.save());
}

export interface PhotoInput {
  /** 已就绪的图片字节（PNG 或 JPEG —— WebP 由调用方先转 PNG）。 */
  data: Uint8Array<ArrayBuffer>;
  kind: 'png' | 'jpeg';
}

export interface PhotoPdfOptions {
  pageSize: string;
  margin: string;
  orientation: string;
}

/** 按用户顺序把照片排版成 PDF（标准纸或原图尺寸；图片原字节嵌入，不重编码）。 */
export async function buildPhotoPdf(
  items: PhotoInput[],
  opts: PhotoPdfOptions,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  const margin = marginPoints(opts.margin);
  for (const it of items) {
    throwIfAborted(signal);
    let img;
    try {
      img = it.kind === 'png' ? await out.embedPng(it.data) : await out.embedJpg(it.data);
    } catch (e) {
      throw classifyError(e, '图片无法嵌入 PDF，文件可能损坏');
    }
    const box = resolvePageBox({
      pageSize: opts.pageSize,
      orientation: opts.orientation,
      imageWidth: img.width,
      imageHeight: img.height,
    });
    const page = out.addPage([box.width, box.height]);
    const innerW = Math.max(1, box.width - margin * 2);
    const innerH = Math.max(1, box.height - margin * 2);
    const place = fitContain(img.width, img.height, innerW, innerH);
    page.drawImage(img, {
      x: margin + place.x,
      y: margin + place.y,
      width: place.width,
      height: place.height,
    });
  }
  return asBytes(await out.save());
}

export interface RasterPage {
  data: Uint8Array<ArrayBuffer>;
  kind: 'png' | 'jpeg';
  /** 页面尺寸（pt）—— 与原页一致，外观才算「同一页」。 */
  widthPt: number;
  heightPt: number;
  /** 可选：写入整页的**不可见**文字层（可搜索 PDF 用）。 */
  text?: string;
}

export interface RasterPdfResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** 成功写入文字层的页数。 */
  pagesWithText: number;
  /** 有文字、但当前字体无法编码（如中文）而放弃文字层的页数。 */
  pagesSkippedText: number;
}

/** 逐页图片各占一页的 PDF（压缩 / 可搜索 PDF 用）。 */
export async function buildRasterPdf(
  pages: RasterPage[],
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<RasterPdfResult> {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const out = await PDFDocument.create();
  // 纯图片输出（压缩）不需要字体；只有要写文字层时才嵌入。
  // 标准字体只覆盖 WinAnsi（拉丁）；中文字符会在 drawText 时抛错 → 见文件头「诚实边界」。
  const needsFont = pages.some((p) => p.text && p.text.trim().length > 0);
  const font = needsFont ? await out.embedFont(StandardFonts.Helvetica) : null;
  let pagesWithText = 0;
  let pagesSkippedText = 0;
  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(signal);
    const pg = pages[i];
    let img;
    try {
      img = pg.kind === 'png' ? await out.embedPng(pg.data) : await out.embedJpg(pg.data);
    } catch (e) {
      throw classifyError(e, '页面图片无法嵌入 PDF');
    }
    const page = out.addPage([pg.widthPt, pg.heightPt]);
    page.drawImage(img, { x: 0, y: 0, width: pg.widthPt, height: pg.heightPt });
    if (font && pg.text && pg.text.trim()) {
      if (drawInvisibleText(page, pg.text, font, pg.widthPt, pg.heightPt)) pagesWithText++;
      else pagesSkippedText++;
    }
    onProgress?.((i + 1) / pages.length);
  }
  return { bytes: asBytes(await out.save()), pagesWithText, pagesSkippedText };
}

type PdfLibFont = Awaited<ReturnType<PdfLib['PDFDocument']['prototype']['embedFont']>>;

/** 把一段文字按行铺成不可见（opacity 0）的文字层。写不进（编码失败）返回 false。 */
function drawInvisibleText(
  page: import('pdf-lib').PDFPage,
  text: string,
  font: PdfLibFont,
  pageW: number,
  pageH: number
): boolean {
  const size = 6;
  const lineGap = 2;
  const lines = wrapText(text, 110);
  const maxLines = Math.max(1, Math.floor((pageH - 12) / (size + lineGap)));
  try {
    let y = pageH - 8;
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      if (!lines[i]) {
        y -= size + lineGap;
        continue;
      }
      page.drawText(lines[i], { x: 4, y, size, font, opacity: 0 });
      y -= size + lineGap;
    }
    return true;
  } catch {
    // WinAnsi 无法编码该页文字（中文等）→ 该页不写文字层。
    return false;
  }
}

/** 简易按词 / 按长度折行（中文无空格，会在编码失败时整页放弃，不影响正确性）。 */
function wrapText(text: string, maxChars: number): string[] {
  // 去掉 OCR 可能带出的控制字符（Tab 等）——它们会让 WinAnsi 编码抛错、整页白写。
  const clean = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\r\n?/g, '\n');
  const out: string[] = [];
  for (const para of clean.split('\n')) {
    if (para.length <= maxChars) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line.length + word.length > maxChars && line.length > 0) {
        out.push(line);
        line = word.replace(/^\s+/, '');
      } else {
        line += word;
      }
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [''];
}
