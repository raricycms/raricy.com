// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/ebook.ts —— 电子书能力区（roadmap §10）。
//
// 【范围】Markdown / HTML / TXT → EPUB 3；EPUB → HTML / Markdown / TXT（拼接单输出）；
//   EPUB → 原始文件多输出（章节 + 图片）。引擎在 engines/ebook.ts（fflate / marked
//   一律动态 import）。DOCX → EPUB 由 office 区借同一个 epubFromHtml，不在这里。
//
// 【诚实说明（roadmap §10 / §15）】
//   · EPUB 是可重排格式，**没有固定页码** —— 转换不会保留原纸面版式。
//   · 生成的是**重新排版**的内容：标题层级、样式、脚注可能变化，结果页逐条列出。
//   · EPUB → HTML 把资源内嵌为 data: URL，**文件体积会明显增大**，且这不是「原样导出」。
//   · 只认标准 EPUB（zip + container.xml + opf），受保护 / 加密 EPUB 直接报错，不解密。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, formatBytes } from '../formats';
import type { CategoryDef, ConvertError, ConvertResultData, OutputFile, RunContext } from '../types';
import { convertedName, sanitizeBase, uniqueOutputName } from '../utils';
import {
  chaptersToMarkdown,
  chaptersToSingleHtml,
  chaptersToText,
  epubFromHtml,
  mimeForExt,
  parseEpub,
  type ParsedEpub,
} from '../engines/ebook';

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

function textParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v.trim() : '';
}

async function readBytes(ctx: RunContext): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await ctx.file.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

function checkSize(ctx: RunContext): void {
  if (ctx.file.size > LIMITS.ebook.maxBytes) {
    throw oversize(`文件 ${formatBytes(ctx.file.size)} 超过 ${formatBytes(LIMITS.ebook.maxBytes)} 电子书上限`);
  }
}

/** TXT → 段落 HTML（净化由 epubFromHtml 的白名单负责）。 */
function textToParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

// ─── → EPUB ──────────────────────────────────────────────────────────────────

type EpubSource = 'md' | 'html' | 'txt';

async function runToEpub(ctx: RunContext, source: EpubSource): Promise<ConvertResultData> {
  checkSize(ctx);
  aborted(ctx.signal);
  const text = await ctx.file.text();
  aborted(ctx.signal);
  ctx.onPhase('converting');

  let html: string;
  if (source === 'md') {
    // marked 动态 import（v18 的 parse 默认同步；await 兼容 async 选项）。
    const { marked } = await import('marked');
    html = String(await marked.parse(text));
  } else if (source === 'html') {
    html = text;
  } else {
    html = textToParagraphs(text);
  }
  aborted(ctx.signal);

  const title = textParam(ctx.params, 'title') || sanitizeBase(ctx.file.name);
  const author = textParam(ctx.params, 'author') || undefined;
  const language = textParam(ctx.params, 'language') || 'zh';
  const bytes = await epubFromHtml(html, { title, author, language });

  const name = convertedName(ctx.file.name, FORMATS.epub.ext, new Set());
  return {
    outputs: [{ blob: new Blob([bytes]), name }],
    mime: FORMATS.epub.mime,
    ext: FORMATS.epub.ext,
    inputSize: ctx.file.size,
    outputSize: bytes.byteLength,
    notices: [
      '重排为可重排电子书（EPUB 3），**没有固定页码**',
      '只保留基本排版标签（段落 / 标题 / 列表 / 强调 / 代码 / 图片）',
      '样式表、脚本与复杂版式不保留',
      '图片仅接受内嵌 data: URL，外部图片已剥离',
    ],
    previewKind: 'none',
  };
}

// ─── EPUB → ──────────────────────────────────────────────────────────────────

async function loadEpub(ctx: RunContext): Promise<ParsedEpub> {
  checkSize(ctx);
  aborted(ctx.signal);
  const bytes = await readBytes(ctx);
  ctx.onPhase('probing');
  let parsed: ParsedEpub;
  try {
    parsed = await parseEpub(bytes);
  } catch (e) {
    const err = e as Partial<ConvertError>;
    if (err?.kind && err?.message) throw err;
    throw { kind: 'corrupt', message: '无法读取 EPUB', detail: String(e) } satisfies ConvertError;
  }
  if (parsed.chapters.length === 0) {
    throw { kind: 'corrupt', message: 'EPUB 里没有可读章节（spine 为空）' } satisfies ConvertError;
  }
  return parsed;
}

function epubTitle(ctx: RunContext, parsed: ParsedEpub): string {
  return textParam(ctx.params, 'title') || parsed.meta.title || sanitizeBase(ctx.file.name);
}

async function runEpubToSingle(
  ctx: RunContext,
  build: (parsed: ParsedEpub, title: string) => string,
  ext: string,
  mime: string,
  notices: string[]
): Promise<ConvertResultData> {
  const parsed = await loadEpub(ctx);
  ctx.onPhase('converting');
  const title = epubTitle(ctx, parsed);
  const content = build(parsed, title);
  aborted(ctx.signal);
  const bytes = new TextEncoder().encode(content);
  const name = convertedName(ctx.file.name, ext, new Set());
  return {
    outputs: [{ blob: new Blob([bytes], { type: mime }), name }],
    mime,
    ext,
    inputSize: ctx.file.size,
    outputSize: bytes.byteLength,
    notices: [`按阅读顺序（spine）拼接 ${parsed.chapters.length} 章`, ...notices],
    previewKind: 'text',
  };
}

async function runEpubExtract(ctx: RunContext): Promise<ConvertResultData> {
  const parsed = await loadEpub(ctx);
  ctx.onPhase('converting');
  const taken = new Set<string>();
  const encoder = new TextEncoder();
  const outputs: OutputFile[] = [];
  let emptyDropped = 0;
  for (const ch of parsed.chapters) {
    const data = encoder.encode(ch.html) as Uint8Array<ArrayBuffer>;
    const name = uniqueOutputName(ch.path || `${ch.name}.xhtml`, 'xhtml', taken);
    outputs.push({ blob: new Blob([data], { type: 'application/xhtml+xml' }), name, note: ch.path });
  }
  for (const [path, data] of parsed.resources) {
    if (data.byteLength === 0) {
      emptyDropped++;
      continue; // 空文件会被执行器判为失败，跳过并在 notice 交代
    }
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1].toLowerCase() ?? 'bin';
    const name = uniqueOutputName(path, ext, taken);
    outputs.push({ blob: new Blob([data], { type: mimeForExt(ext) }), name, note: path });
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: 'application/octet-stream',
    ext: 'bin',
    inputSize: ctx.file.size,
    outputSize,
    notices: [
      `解出 ${outputs.length} 个文件（${parsed.chapters.length} 章 + 资源原样）`,
      '成员逐个单独下载，不做二次压缩',
      ...(emptyDropped ? [`${emptyDropped} 个空资源未输出`] : []),
    ],
    previewKind: 'none',
  };
}

// ─── 参数 ────────────────────────────────────────────────────────────────────

function titleParam(defaultsAdv = false) {
  return {
    key: 'title',
    label: '书名',
    type: 'text' as const,
    defaultValue: '',
    help: '留空则用文件名',
    advanced: defaultsAdv,
  };
}

function authorParam() {
  return { key: 'author', label: '作者', type: 'text' as const, defaultValue: '', advanced: true };
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

const EPUB_KINDS = ['epub'] as const;

export const CATEGORY: CategoryDef = {
  key: 'ebook',
  label: '电子书',
  hint:
    'Markdown / HTML / TXT → EPUB（可重排，无固定页码），EPUB → HTML / Markdown / TXT 或解包出原始文件。' +
    '生成与解析都是重新排版/重建，原纸面版式与页码不保留；结果页会说明保真范围。文件只在本机处理。',
  accept: '.epub,.md,.markdown,.html,.htm,.txt',
  maxFilesPerTask: 1,
  edges: [
    {
      id: 'ebook:md-to-epub',
      label: 'EPUB（Markdown 重排）',
      from: ['markdown'],
      to: 'epub',
      method: 'reflow',
      notices: ['重新排版，无固定页码', '样式与复杂版式不保留', '外链图片不保留'],
      params: [titleParam(), authorParam()],
      run: (ctx) => runToEpub(ctx, 'md'),
      status: 'live',
      group: '制作电子书',
    },
    {
      id: 'ebook:html-to-epub',
      label: 'EPUB（HTML 重排）',
      from: ['html'],
      to: 'epub',
      method: 'reflow',
      notices: ['重新排版，无固定页码', '脚本与样式剥离', '外链图片不保留'],
      params: [titleParam(), authorParam()],
      run: (ctx) => runToEpub(ctx, 'html'),
      status: 'live',
      group: '制作电子书',
    },
    {
      id: 'ebook:txt-to-epub',
      label: 'EPUB（TXT 转重排）',
      from: ['text'],
      to: 'epub',
      method: 'reflow',
      notices: ['按空行分段，重新排版，无固定页码', '原换行只在大段内保留为换行'],
      params: [titleParam(), authorParam()],
      run: (ctx) => runToEpub(ctx, 'txt'),
      status: 'live',
      group: '制作电子书',
    },
    {
      id: 'ebook:epub-to-html',
      label: 'HTML（单文件，资源内嵌）',
      from: [...EPUB_KINDS],
      to: 'html',
      method: 'extract',
      notices: ['资源内嵌为 data: URL，文件体积会明显增大', '按 spine 顺序拼接，非原样导出'],
      params: [],
      run: (ctx) =>
        runEpubToSingle(ctx, (parsed, title) => chaptersToSingleHtml(parsed, title), FORMATS.html.ext, FORMATS.html.mime, [
          '图片内嵌为 data: URL（体积增大）',
        ]),
      status: 'live',
      group: '阅读 / 导出',
    },
    {
      id: 'ebook:epub-to-md',
      label: 'Markdown（按章节拼接）',
      from: [...EPUB_KINDS],
      to: 'md',
      method: 'extract',
      notices: ['简单标签映射，复杂排版会失真', '图片不内嵌（仅文本）', '章间以 --- 分隔'],
      params: [],
      run: (ctx) =>
        runEpubToSingle(ctx, (parsed) => chaptersToMarkdown(parsed), FORMATS.md.ext, FORMATS.md.mime, [
          '简单标签映射；章间以 --- 分隔；图片未内嵌',
        ]),
      status: 'live',
      group: '阅读 / 导出',
    },
    {
      id: 'ebook:epub-to-txt',
      label: 'TXT（纯文本拼接）',
      from: [...EPUB_KINDS],
      to: 'txt',
      method: 'extract',
      notices: ['仅保留文字，排版与图片丢失', '章间空行分隔'],
      params: [],
      run: (ctx) =>
        runEpubToSingle(ctx, (parsed) => chaptersToText(parsed), FORMATS.txt.ext, FORMATS.txt.mime, [
          '仅保留文字；章间空行分隔',
        ]),
      status: 'live',
      group: '阅读 / 导出',
    },
    {
      id: 'ebook:epub-extract',
      label: '解包 EPUB（章节 + 资源原样）',
      from: [...EPUB_KINDS],
      to: 'bin',
      method: 'extract',
      notices: ['章节与图片等资源原样解出，各自单独下载', '不做二次压缩'],
      params: [],
      estimateOutput: (info) => info.size,
      run: (ctx) => runEpubExtract(ctx),
      status: 'live',
      group: '阅读 / 导出',
    },
  ],
  // probe：读 EPUB 元信息（书名 / 作者）填进 extra，供参数表单展示。
  // 失败必须降级（返回 {}）—— 探测失败不该挡住转换本身。
  probe: async (file, info) => {
    try {
      if (info.sniff.kind !== 'epub') return {};
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseEpub(bytes);
      const extra: Record<string, string> = {};
      if (parsed.meta.title) extra.title = parsed.meta.title;
      if (parsed.meta.creator) extra.author = parsed.meta.creator;
      return { extra };
    } catch {
      return {};
    }
  },
};
