// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/office.ts —— Office / 标记文档能力区（roadmap §7.1）。
//
// 【范围】DOCX ↔ Markdown / HTML / TXT（重排版），DOCX → EPUB（借 ebook 引擎），
//   PDF → 图片型 DOCX / PPTX（逐页渲染成图后嵌入）。引擎在 engines/office.ts。
//
// 【为什么标签页 key 是 'document'】UI 上「文档 / PDF」是一个标签页，由 pdf.ts 与
//   本模块的边合并（categories/index.ts 的 mergeDocument）。所以本模块 key='document'，
//   而边 id 用 `office:` 前缀避免与 pdf 区的 `pdf:` 冲突。
//
// 【诚实说明（roadmap §7.1 / §7.3 / §15）】
//   · 只做内容结构转换，不承诺像素级版式：字体、页边距、页眉页脚、域、浮动对象不保留。
//   · PDF → DOCX / PPTX 是**图片型重建**：外观保留，但页面里的文字不可选、不可编辑。
//   · 真正的 DOCX → PDF 需要 LibreOffice 这类原生排版引擎，属服务端方向，故为 planned。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, formatBytes } from '../formats';
import type { CategoryDef, ConvertError, ConvertResultData, EdgeDef, ParamSpec, RunContext } from '../types';
import { convertedName } from '../utils';
import {
  buildDocxFromBlocks,
  buildDocxFromPageImages,
  docxToHtml,
  docxToText,
  htmlToBlocks,
  htmlToMarkdown,
  mammothMessagesToNotices,
  textToBlocks,
  type OfficeBlock,
  type PageImage,
} from '../engines/office';

const PDF_WORKER = '/static/converter/pdfjs/pdf.worker.min.mjs';
// PDF 页面图渲染分辨率。144 上下是「放大看得清 + 体积可接受」的折中。
const PDF_RENDER_DPI = 144;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

function checkDocumentSize(ctx: RunContext): void {
  if (ctx.file.size > LIMITS.document.maxBytes) {
    throw oversize(`文件 ${formatBytes(ctx.file.size)} 超过 ${formatBytes(LIMITS.document.maxBytes)} 文档上限`);
  }
}

async function readBytes(ctx: RunContext): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await ctx.file.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

function textParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** 块级模型里出现过的「有损失」结构 → notices。 */
function blockLossNotices(blocks: OfficeBlock[]): string[] {
  const out: string[] = [];
  if (blocks.some((b) => b.kind === 'table')) out.push('表格降级为文本行（保留单元格分隔，表内样式与合并格丢失）');
  if (blocks.some((b) => b.kind === 'quote')) out.push('引用块按缩进段落保留，原引用样式不保留');
  if (blocks.some((b) => b.kind === 'listItem' && b.ordered)) out.push('有序列表用「序号. 」文本保留（不生成 Word 自动编号）');
  return out;
}

// ─── 读 DOCX（mammoth）────────────────────────────────────────────────────────

async function runDocxTo(
  ctx: RunContext,
  mode: 'md' | 'html' | 'txt'
): Promise<ConvertResultData> {
  checkDocumentSize(ctx);
  throwIfAborted(ctx.signal);
  const bytes = await readBytes(ctx);
  ctx.onPhase('converting');
  throwIfAborted(ctx.signal);

  let content: string;
  let messages: { type: 'warning' | 'error'; message: string }[];
  let ext: string;
  let mime: string;
  const notices: string[] = [];

  if (mode === 'txt') {
    const r = await docxToText(bytes);
    content = r.text;
    messages = r.messages;
    ext = FORMATS.txt.ext;
    mime = FORMATS.txt.mime;
    notices.push('只保留文字，版式、图片、表格结构丢失');
  } else if (mode === 'md') {
    const r = await docxToHtml(bytes);
    messages = r.messages;
    content = htmlToMarkdown(r.html);
    ext = FORMATS.md.ext;
    mime = FORMATS.md.mime;
    notices.push('按语义映射为 Markdown，不是原样导出');
    notices.push('复杂版式、样式表、字体、页眉页脚不保留');
    notices.push('图片不导出（只保留文字）；表格降级为管道表文本');
  } else {
    const r = await docxToHtml(bytes);
    messages = r.messages;
    content = r.html;
    ext = FORMATS.html.ext;
    mime = FORMATS.html.mime;
    notices.push('按语义映射为 HTML，不是原样导出');
    notices.push('复杂版式、样式表、字体、页眉页脚不保留');
    notices.push('图片内嵌为 data: URL（体积会明显增大）');
  }
  throwIfAborted(ctx.signal);
  notices.push(...mammothMessagesToNotices(messages));

  if (content.trim() === '') {
    throw { kind: 'unsupported', message: '文档里没有可提取的内容（可能是空文档或只有图片）' } satisfies ConvertError;
  }

  const out = new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
  const name = convertedName(ctx.file.name, ext, new Set());
  return {
    outputs: [{ blob: new Blob([out], { type: mime }), name }],
    mime,
    ext,
    inputSize: ctx.file.size,
    outputSize: out.byteLength,
    notices,
    previewKind: 'text',
  };
}

// ─── 写 DOCX（docx 包）────────────────────────────────────────────────────────

async function runToDocx(ctx: RunContext, source: 'md' | 'html' | 'txt'): Promise<ConvertResultData> {
  checkDocumentSize(ctx);
  throwIfAborted(ctx.signal);
  const text = await ctx.file.text();
  throwIfAborted(ctx.signal);
  ctx.onPhase('converting');

  let blocks: OfficeBlock[];
  if (source === 'md') {
    const { marked } = await import('marked');
    const html = String(await marked.parse(text));
    blocks = htmlToBlocks(html);
  } else if (source === 'html') {
    blocks = htmlToBlocks(text);
  } else {
    blocks = textToBlocks(text);
  }
  throwIfAborted(ctx.signal);

  const bytes = await buildDocxFromBlocks(blocks, { title: ctx.file.name });
  throwIfAborted(ctx.signal);
  const name = convertedName(ctx.file.name, FORMATS.docx.ext, new Set());
  return {
    outputs: [{ blob: new Blob([bytes]), name }],
    mime: FORMATS.docx.mime,
    ext: FORMATS.docx.ext,
    inputSize: ctx.file.size,
    outputSize: bytes.byteLength,
    notices: [
      '重新排版为 Word 文档（DOCX），只保留内容结构',
      '字体、颜色、页边距、页眉页脚等版式不生成',
      source === 'md' ? 'Markdown 语法按常用子集解析' : '只保留基本结构（标题 / 段落 / 强调 / 列表 / 引用 / 代码 / 链接）',
      '图片不嵌入（img 标签会被丢弃，替换为占位文字）',
      ...blockLossNotices(blocks),
    ],
    previewKind: 'none',
  };
}

// ─── DOCX → EPUB（借 ebook 引擎的 epubFromHtml）───────────────────────────────

async function runDocxToEpub(ctx: RunContext): Promise<ConvertResultData> {
  checkDocumentSize(ctx);
  throwIfAborted(ctx.signal);
  const bytes = await readBytes(ctx);
  ctx.onPhase('converting');
  throwIfAborted(ctx.signal);

  const { html, messages } = await docxToHtml(bytes);
  throwIfAborted(ctx.signal);
  const title = textParam(ctx.params, 'title') || ctx.file.name.replace(/\.[^.]+$/, '');
  const author = textParam(ctx.params, 'author') || undefined;
  // epubFromHtml 借自 ebook 引擎（静态 import 会把它的加载路径卷进主包；动态引入）。
  const { epubFromHtml } = await import('../engines/ebook');
  const epub = await epubFromHtml(html, { title, author });
  throwIfAborted(ctx.signal);

  const name = convertedName(ctx.file.name, FORMATS.epub.ext, new Set());
  return {
    outputs: [{ blob: new Blob([epub]), name }],
    mime: FORMATS.epub.mime,
    ext: FORMATS.epub.ext,
    inputSize: ctx.file.size,
    outputSize: epub.byteLength,
    notices: [
      '重排为可重排电子书（EPUB 3），无固定页码',
      '只保留基本排版标签（段落 / 标题 / 列表 / 强调 / 代码）',
      '图片仅接受内嵌 data: URL，其余已剥离',
      ...mammothMessagesToNotices(messages),
    ],
    previewKind: 'none',
  };
}

// ─── PDF 页面 → 图片（pdfjs 逐页渲染，需 DOM canvas）───────────────────────────

async function renderPdfPages(ctx: RunContext): Promise<PageImage[]> {
  checkDocumentSize(ctx);
  throwIfAborted(ctx.signal);
  const bytes = await readBytes(ctx);
  ctx.onPhase('loading-engine');
  // pdfjs 一律动态 import（静态引入会把渲染器卷进主包）。
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  ctx.onPhase('probing');

  // 复制一份给 pdfjs：它会 transfer / detach 传入的 buffer。
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const pageCount = doc.numPages;
    if (pageCount > LIMITS.document.maxPages) {
      throw oversize(`PDF 共 ${pageCount} 页，超过 ${LIMITS.document.maxPages} 页上限，请先拆分后再转`);
    }
    const scale = PDF_RENDER_DPI / 72;
    const images: PageImage[] = [];
    ctx.onPhase('converting');
    for (let p = 1; p <= pageCount; p++) {
      throwIfAborted(ctx.signal);
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const c2d = canvas.getContext('2d');
      if (!c2d) throw { kind: 'capability', message: '当前环境不支持 Canvas，无法渲染 PDF 页面' } satisfies ConvertError;
      await page.render({ canvasContext: c2d, viewport }).promise;
      const blob = await canvasToPngBlob(canvas);
      const data = new Uint8Array(await blob.arrayBuffer()) as Uint8Array<ArrayBuffer>;
      images.push({ data, mime: 'image/png', width: canvas.width, height: canvas.height });
      page.cleanup();
      ctx.onProgress(p / pageCount, `渲染第 ${p}/${pageCount} 页`);
    }
    return images;
  } catch (e) {
    const err = e as Partial<ConvertError>;
    if (err?.kind && err?.message) throw err;
    throw { kind: 'corrupt', message: '无法渲染 PDF 页面，文件可能损坏或受密码保护', detail: String(e).slice(0, 1500) } satisfies ConvertError;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))), 'image/png');
  });
}

async function runPdfToDocxImage(ctx: RunContext): Promise<ConvertResultData> {
  const images = await renderPdfPages(ctx);
  throwIfAborted(ctx.signal);
  const bytes = await buildDocxFromPageImages(images, { title: ctx.file.name });
  const name = convertedName(ctx.file.name, FORMATS.docx.ext, new Set());
  return {
    outputs: [{ blob: new Blob([bytes]), name }],
    mime: FORMATS.docx.mime,
    ext: FORMATS.docx.ext,
    inputSize: ctx.file.size,
    outputSize: bytes.byteLength,
    notices: [
      `逐页渲染（${PDF_RENDER_DPI} dpi）为图片后嵌入，**页面里的文字不可选、不可编辑**`,
      '书签、表单、可搜索文字层、批注与数字签名不保留',
      '放大查看会看到像素化；这是「外观还原」而非「可编辑重建」',
    ],
    previewKind: 'none',
  };
}

// ─── PDF 页面 → PPTX（每页一张 slide）─────────────────────────────────────────

interface PptxSlide {
  addImage(o: { data: string; x: number; y: number; w: number; h: number }): unknown;
}
interface PptxInstance {
  addSlide(): PptxSlide;
  write(o: { outputType: 'blob' }): Promise<string | ArrayBuffer | Blob | Uint8Array>;
}

async function runPdfToPptxImage(ctx: RunContext): Promise<ConvertResultData> {
  const images = await renderPdfPages(ctx);
  throwIfAborted(ctx.signal);
  ctx.onPhase('converting');
  const mod = (await import('pptxgenjs')) as unknown as { default?: unknown };
  const PptxGenJS = (mod.default ?? mod) as new () => PptxInstance;
  const pptx = new PptxGenJS();
  // 默认版式 10 × 7.5 英寸；图按比例居中放进 9 × 6.5 的区域。
  const regionW = 9;
  const regionH = 6.5;
  for (const img of images) {
    throwIfAborted(ctx.signal);
    const slide = pptx.addSlide();
    const ratio = img.width > 0 && img.height > 0 ? img.height / img.width : regionH / regionW;
    let w = regionW;
    let h = w * ratio;
    if (h > regionH) {
      h = regionH;
      w = h / ratio;
    }
    const x = (10 - w) / 2;
    const y = (7.5 - h) / 2;
    slide.addImage({ data: toDataUrl(img.mime, img.data), x, y, w, h });
  }
  const raw = await pptx.write({ outputType: 'blob' });
  const blob = raw instanceof Blob ? raw : new Blob([raw as ArrayBuffer]);
  const name = convertedName(ctx.file.name, FORMATS.pptx.ext, new Set());
  return {
    outputs: [{ blob, name }],
    mime: FORMATS.pptx.mime,
    ext: FORMATS.pptx.ext,
    inputSize: ctx.file.size,
    outputSize: blob.size,
    notices: [
      `逐页渲染（${PDF_RENDER_DPI} dpi）为图片，每页一张幻灯片，**文字不可选、不可编辑**`,
      '无动画与转场；书签、表单、批注与签名不保留',
      '放大查看会看到像素化；这是「外观还原」而非「可编辑重建」',
    ],
    previewKind: 'none',
  };
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}

// ─── 参数 ────────────────────────────────────────────────────────────────────

function titleParam(): ParamSpec {
  return { key: 'title', label: '书名', type: 'text', defaultValue: '', help: '留空则用文件名' };
}

function authorParam(): ParamSpec {
  return { key: 'author', label: '作者', type: 'text', defaultValue: '', advanced: true };
}

// ─── 电子书借调边（ebook 标签页用）───────────────────────────────────────────

export const ebookExtraEdges: EdgeDef[] = [
  {
    id: 'ebook:docx-to-epub',
    label: 'EPUB（Word 文档重排）',
    from: ['docx'],
    to: 'epub',
    method: 'reflow',
    notices: ['重新排版，无固定页码', '只保留基本结构，样式与版式不保留', '外链图片不保留'],
    params: [titleParam(), authorParam()],
    run: (ctx) => runDocxToEpub(ctx),
    status: 'live',
    group: '制作电子书',
  },
];

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

export const CATEGORY: CategoryDef = {
  key: 'document',
  label: 'Office 文档',
  hint:
    'DOCX 与 Markdown / HTML / 纯文本互转；PDF 转 DOCX / PPTX 为图片型（文字不可选）；' +
    '真正的 DOCX→PDF 需后续服务端支持。文件只在本机处理。',
  accept: '.docx,.md,.markdown,.html,.htm,.txt,.pdf',
  maxFilesPerTask: 1,
  edges: [
    // ── DOCX → 标记文档 ──────────────────────────────────────────────────────
    {
      id: 'office:docx-to-md',
      label: 'Markdown（重排版）',
      from: ['docx'],
      to: 'md',
      method: 'reflow',
      notices: ['重排版，不是原样导出', '复杂版式与样式不保留', '图片不导出'],
      params: [],
      run: (ctx) => runDocxTo(ctx, 'md'),
      status: 'live',
      group: 'Word 文档 →',
    },
    {
      id: 'office:docx-to-html',
      label: 'HTML（重排版，图片内嵌）',
      from: ['docx'],
      to: 'html',
      method: 'reflow',
      notices: ['重排版，不是原样导出', '图片内嵌为 data: URL，体积增大', '样式与版式不保留'],
      params: [],
      run: (ctx) => runDocxTo(ctx, 'html'),
      status: 'live',
      group: 'Word 文档 →',
    },
    {
      id: 'office:docx-to-txt',
      label: 'TXT（提取纯文字）',
      from: ['docx'],
      to: 'txt',
      method: 'reflow',
      notices: ['只保留文字，版式与图片丢失'],
      params: [],
      run: (ctx) => runDocxTo(ctx, 'txt'),
      status: 'live',
      group: 'Word 文档 →',
    },
    // ── 标记文档 → DOCX ──────────────────────────────────────────────────────
    {
      id: 'office:md-to-docx',
      label: 'Word 文档（Markdown 重排）',
      from: ['markdown'],
      to: 'docx',
      method: 'reflow',
      notices: ['重新排版，只保留内容结构', '复杂版式不生成', '图片不嵌入'],
      params: [],
      run: (ctx) => runToDocx(ctx, 'md'),
      status: 'live',
      group: '→ Word 文档',
    },
    {
      id: 'office:html-to-docx',
      label: 'Word 文档（HTML 重排）',
      from: ['html'],
      to: 'docx',
      method: 'reflow',
      notices: ['重新排版，只保留内容结构', '脚本与样式剥离', '图片不嵌入'],
      params: [],
      run: (ctx) => runToDocx(ctx, 'html'),
      status: 'live',
      group: '→ Word 文档',
    },
    {
      id: 'office:txt-to-docx',
      label: 'Word 文档（纯文本转段落）',
      from: ['text'],
      to: 'docx',
      method: 'reflow',
      notices: ['按空行分段，不识别标题/表格等结构', '仅生成标题级外的普通段落'],
      params: [],
      run: (ctx) => runToDocx(ctx, 'txt'),
      status: 'live',
      group: '→ Word 文档',
    },
    // ── PDF → 图片型重建 ─────────────────────────────────────────────────────
    {
      id: 'office:pdf-to-docx-image',
      label: 'Word 文档（图片型，文字不可选）',
      from: ['pdf'],
      to: 'docx',
      method: 'extract',
      notices: ['逐页渲染为图片后嵌入，文字不可选、不可编辑', '书签/表单/批注不保留', '放大较模糊'],
      params: [],
      run: (ctx) => runPdfToDocxImage(ctx),
      status: 'live',
      group: 'PDF →',
    },
    {
      id: 'office:pdf-to-pptx-image',
      label: 'PPT（图片型，每页一张）',
      from: ['pdf'],
      to: 'pptx',
      method: 'extract',
      notices: ['逐页渲染为图片，每页一张幻灯片，文字不可选', '无动画与转场', '放大较模糊'],
      params: [],
      run: (ctx) => runPdfToPptxImage(ctx),
      status: 'live',
      group: 'PDF →',
    },
    // ── 规划中（仅登记，不实现 run）──────────────────────────────────────────
    {
      id: 'office:html-print-pdf',
      label: 'HTML → PDF（打印视图）',
      from: ['html'],
      to: 'pdf',
      method: 'reflow',
      notices: ['浏览器打印为 PDF 的引导将在后续版本提供；当前请先转 DOCX'],
      params: [],
      status: 'planned',
      group: '规划中',
    },
    {
      id: 'office:docx-to-pdf',
      label: 'Word 文档 → PDF',
      from: ['docx'],
      to: 'pdf',
      method: 'reflow',
      notices: ['真正的 DOCX → PDF 需要 LibreOffice 等原生排版引擎，将随服务端模式提供'],
      params: [],
      status: 'planned',
      group: '规划中',
    },
  ],
};
