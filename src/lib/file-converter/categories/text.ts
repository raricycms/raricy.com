// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/text.ts —— 文本 / 字幕能力区（roadmap §9）。
//
// 【范围】两条线：
//   · 字符编码：任意文本类（txt / csv / json / xml / srt…）在 UTF-8 / UTF-16 /
//     GBK / GB18030 / Big5 / Shift_JIS / EUC-JP / Latin-1 之间换编码（roadmap X01–X04）。
//   · 字幕：SRT / WebVTT / ASS 三者互转（X06–X08）。
//   另有 TXT → Markdown / HTML 的重排版（X05）。
//
// 【纪律】
//   · LIMITS.text（10 MiB）是硬上限：字节在 runner 开头直接判。
//   · 编码转换只改字节表示，**内容与换行不动**；换行 / BOM 是独立选项。
//   · 编码探测是候选判断：auto 猜不准时 notice 明写「编码是猜的，乱码请手动选」。
//   · 目标编码写不出的字符（iconv-lite 会静默变 "?"）用回环比对发现并如实标注。
//   · 字幕：样式 / 定位 / 字体 / 卡拉 OK 等特效**不重建**，结果页写明损失；
//     坏行跳过计数、时间倒置保留原样，都进 notice。
//   · 无任何网络请求；引擎（iconv-lite）在 runner / encoding.ts 内**动态 import**。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, TEXT_ENCODINGS, formatBytes } from '../formats';
import type {
  CategoryDef,
  ConvertError,
  ConvertResultData,
  FileKind,
  InspectInfo,
  ParamOption,
  ParamSpec,
  RunContext,
} from '../types';
import { convertedName } from '../utils';
import { decodeText, detectEncoding, encodeText, encodingSupportsBom, hasUnrepresentable } from '../engines/encoding';
import { parseSubtitle, serializeSubtitle, type SubtitleFormat } from '../engines/subtitle';

// ─── 词汇与参数 ──────────────────────────────────────────────────────────────

/** 可换编码的输入族（全部是「文本字节」，与具体格式无关）。 */
const TEXT_KINDS: readonly FileKind[] = [
  'text',
  'csv',
  'tsv',
  'markdown',
  'srt',
  'vtt',
  'ass',
  'json',
  'ndjson',
  'yaml',
  'xml',
  'html',
];

const ENCODING_KEYS: readonly string[] = TEXT_ENCODINGS.map((e) => e.key);

const ENCODING_LABELS: Record<string, string> = Object.fromEntries(
  TEXT_ENCODINGS.map((e) => [e.key, e.label])
);

function encodingLabel(enc: string): string {
  return ENCODING_LABELS[enc] ?? enc.toUpperCase();
}

/** select 选项：TEXT_ENCODINGS 的 key/label 映射成 ParamOption 的 value/label。 */
function encodingOptions(): ParamOption[] {
  return TEXT_ENCODINGS.map((e) => ({ value: e.key, label: e.label }));
}

function oversizeText(): ConvertError {
  return {
    kind: 'oversize',
    message: `文件超过 ${formatBytes(LIMITS.text.maxBytes)} 上限`,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

/** 白名单式字符串参数解析（UI 冻结的快照也要防御性读）。 */
function selectParam(params: Record<string, unknown>, key: string, allowed: readonly string[], fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && allowed.includes(v) ? v : fallback;
}

/** 输出扩展名：优先嗅探结果，其次文件名后缀，都没有给 txt。 */
function outputExtOf(ctx: RunContext): string {
  const sniffed = ctx.inspect?.sniff.ext;
  if (sniffed && /^[a-z0-9]{1,8}$/.test(sniffed)) return sniffed;
  const m = /\.([a-z0-9]{1,8})$/i.exec(ctx.file.name);
  return m ? m[1].toLowerCase() : 'txt';
}

async function readBytes(ctx: RunContext): Promise<Uint8Array> {
  if (ctx.file.size > LIMITS.text.maxBytes) throw oversizeText();
  throwIfAborted(ctx.signal);
  const bytes = new Uint8Array(await ctx.file.arrayBuffer());
  throwIfAborted(ctx.signal);
  return bytes;
}

// ─── runner：字符编码转换 ────────────────────────────────────────────────────

async function runConvertEncoding(ctx: RunContext): Promise<ConvertResultData> {
  const bytes = await readBytes(ctx);
  ctx.onPhase('converting');
  ctx.onProgress(0, '解析源编码');

  const fromRaw = selectParam(ctx.params, 'fromEncoding', ['auto', ...ENCODING_KEYS], 'auto');
  const toRaw = selectParam(ctx.params, 'toEncoding', ENCODING_KEYS, 'utf-8');
  const bomWanted = ctx.params.bom === true;

  let sourceEncoding = fromRaw;
  let guessNotice: string | null = null;
  if (fromRaw === 'auto') {
    const d = detectEncoding(bytes);
    sourceEncoding = d.encoding;
    if (!d.confident) {
      guessNotice = '源文件编码是自动猜测的（可能不准），如出现乱码请手动指定源编码后重试';
    }
  }

  const { text, detectedBom } = await decodeText(bytes, sourceEncoding);
  throwIfAborted(ctx.signal);
  ctx.onProgress(0.6, '按目标编码写出');

  const outBytes = await encodeText(text, toRaw, { bom: bomWanted });
  throwIfAborted(ctx.signal);
  ctx.onProgress(1);

  const toLabel = encodingLabel(toRaw);
  const notices: string[] = ['仅重新编码字符，文本内容与换行不改变'];
  if (detectedBom) notices.push(`已移除源文件的 ${encodingLabel(detectedBom)} BOM`);
  if (guessNotice) notices.push(guessNotice);
  if (bomWanted) {
    if (encodingSupportsBom(toRaw)) notices.push(`输出带 ${toLabel} BOM`);
    else notices.push(`${toLabel} 不使用 BOM，「输出带 BOM」已忽略`);
  }
  if (await hasUnrepresentable(text, toRaw)) {
    notices.push(`目标编码 ${toLabel} 无法表示的字符已被替换为 “?”，请核对结果`);
  }

  const ext = outputExtOf(ctx);
  const mime = ctx.inspect?.sniff.mime ?? FORMATS.txt.mime;
  const name = convertedName(ctx.file.name, ext, new Set());

  return {
    outputs: [{ blob: new Blob([outBytes]), name }],
    mime,
    ext,
    inputSize: ctx.file.size,
    outputSize: outBytes.byteLength,
    notices,
    previewKind: 'text',
  };
}

// ─── runner：TXT → Markdown（仅改扩展名的重排版）─────────────────────────────

async function runTxtToMarkdown(ctx: RunContext): Promise<ConvertResultData> {
  const bytes = await readBytes(ctx);
  ctx.onPhase('converting');
  ctx.onProgress(0);

  const d = detectEncoding(bytes);
  const { text, detectedBom } = await decodeText(bytes, d.encoding);
  throwIfAborted(ctx.signal);

  // 以 UTF-8 写出（Markdown 的目标生态默认 UTF-8）。
  const outBytes = await encodeText(text, 'utf-8');
  ctx.onProgress(1);

  const notices = [
    '仅将扩展名改为 .md，正文内容未做任何结构识别（TXT 不含标题 / 列表 / 表格语义）',
    '输出统一为 UTF-8 编码',
  ];
  if (detectedBom) notices.push(`已移除源文件的 ${encodingLabel(detectedBom)} BOM`);
  if (!d.confident) notices.push('源文件编码是自动猜测的（可能不准），如出现乱码请先转成 UTF-8 再处理');

  const name = convertedName(ctx.file.name, FORMATS.md.ext, new Set());
  return {
    outputs: [{ blob: new Blob([outBytes]), name }],
    mime: FORMATS.md.mime,
    ext: FORMATS.md.ext,
    inputSize: ctx.file.size,
    outputSize: outBytes.byteLength,
    notices,
    previewKind: 'text',
  };
}

// ─── runner：TXT → HTML（转义 + 段落化）──────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 空行分段 → <p>；段落内单换行 → <br>；所有特殊字符转义。 */
function textToHtmlBody(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const paras = normalized
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.length > 0);
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

async function runTxtToHtml(ctx: RunContext): Promise<ConvertResultData> {
  const bytes = await readBytes(ctx);
  ctx.onPhase('converting');
  ctx.onProgress(0);

  const d = detectEncoding(bytes);
  const { text, detectedBom } = await decodeText(bytes, d.encoding);
  throwIfAborted(ctx.signal);

  const title = escapeHtml(ctx.file.name.replace(/\.[^.]*$/, '') || ctx.file.name);
  const html =
    '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${title}</title>\n` +
    '</head>\n' +
    '<body>\n' +
    textToHtmlBody(text) +
    '\n</body>\n</html>\n';

  const outBytes = await encodeText(html, 'utf-8');
  ctx.onProgress(1);

  const notices = [
    '按空行分段、段落内换行转为 <br>；未识别标题、列表、表格等结构',
    '原文的特殊字符（& < > "）已转义，避免破坏页面',
    '输出为 UTF-8 编码',
  ];
  if (detectedBom) notices.push(`已移除源文件的 ${encodingLabel(detectedBom)} BOM`);
  if (!d.confident) notices.push('源文件编码是自动猜测的（可能不准），如出现乱码请先转成 UTF-8 再处理');

  const name = convertedName(ctx.file.name, FORMATS.html.ext, new Set());
  return {
    outputs: [{ blob: new Blob([outBytes]), name }],
    mime: FORMATS.html.mime,
    ext: FORMATS.html.ext,
    inputSize: ctx.file.size,
    outputSize: outBytes.byteLength,
    notices,
    previewKind: 'text',
  };
}

// ─── runner：字幕互转 ────────────────────────────────────────────────────────

const SUBTITLE_KINDS: readonly FileKind[] = ['srt', 'vtt', 'ass'];

function subtitleSourceOf(ctx: RunContext): SubtitleFormat {
  const kind = ctx.inspect?.sniff.kind;
  if (kind === 'srt' || kind === 'vtt' || kind === 'ass') return kind;
  const m = /\.([a-z0-9]+)$/i.exec(ctx.file.name);
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  return 'srt';
}

async function runSubtitleConvert(ctx: RunContext, target: SubtitleFormat): Promise<ConvertResultData> {
  const bytes = await readBytes(ctx);
  ctx.onPhase('converting');
  ctx.onProgress(0);

  const source = subtitleSourceOf(ctx);
  const d = detectEncoding(bytes);
  const { text, detectedBom } = await decodeText(bytes, d.encoding);
  throwIfAborted(ctx.signal);

  const { cues, skipped, inverted } = parseSubtitle(text, source);
  if (cues.length === 0) {
    throw {
      kind: 'corrupt',
      message: '未解析出任何字幕条目，文件可能不是有效的字幕',
    } satisfies ConvertError;
  }
  ctx.onProgress(0.6, '写出目标字幕');

  const outText = serializeSubtitle(cues, target);
  const outBytes = await encodeText(outText, 'utf-8');
  throwIfAborted(ctx.signal);
  ctx.onProgress(1);

  const notices: string[] = [`已解析 ${cues.length} 条字幕`];
  if (source === 'ass') {
    notices.push('ASS 的样式、定位、字体与卡拉 OK 等特效未保留，仅保留对白与时间');
  }
  if (target === 'ass') {
    notices.push('ASS 使用统一的 Default 样式模板，不是恢复原字幕的设计');
  }
  if (target !== 'ass' && source !== 'ass') {
    notices.push('保留原文的内联标签（如 <i>），目标播放器若不支持会按字面显示');
  }
  if (skipped > 0) notices.push(`跳过 ${skipped} 处无法解析的内容`);
  if (inverted > 0) notices.push(`${inverted} 条字幕时间倒置（结束早于开始），已按原样保留`);
  if (detectedBom) notices.push(`已移除源文件的 ${encodingLabel(detectedBom)} BOM`);
  if (!d.confident) notices.push('源文件编码是自动猜测的（可能不准），如出现乱码请先转成 UTF-8 再处理');
  notices.push('输出统一为 UTF-8 编码');

  const fmt = FORMATS[target];
  const name = convertedName(ctx.file.name, fmt.ext, new Set());
  return {
    outputs: [{ blob: new Blob([outBytes]), name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: ctx.file.size,
    outputSize: outBytes.byteLength,
    notices,
    previewKind: 'text',
  };
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

const CONVERT_PARAMS: ParamSpec[] = [
  {
    key: 'fromEncoding',
    label: '源编码',
    type: 'select',
    options: [{ value: 'auto', label: '自动检测' }, ...encodingOptions()],
    defaultValue: 'auto',
    help: '识别不准时手动指定，可修复乱码',
  },
  {
    key: 'toEncoding',
    label: '目标编码',
    type: 'select',
    options: encodingOptions(),
    defaultValue: 'utf-8',
  },
  {
    key: 'bom',
    label: '输出带 BOM',
    type: 'checkbox',
    defaultValue: false,
    advanced: true,
    help: '仅 UTF-8 / UTF-16 有效',
  },
];

export const CATEGORY: CategoryDef = {
  key: 'text',
  label: '文本 / 字幕',
  hint:
    '文本字符编码互转（UTF-8 / UTF-16 / GBK / Big5 / Shift_JIS 等）、TXT → Markdown / HTML；' +
    'SRT / WebVTT / ASS 字幕互转。单文件 ≤ 10 MiB；换编码只改字节表示、不改内容，' +
    '字幕样式与特效无法完全保留，结果页如实标注。文件只在本机处理。',
  accept: '.txt,.text,.md,.markdown,.csv,.tsv,.json,.jsonl,.ndjson,.yaml,.yml,.xml,.html,.htm,.srt,.vtt,.ass,.ssa,.log',
  maxFilesPerTask: 1,
  edges: [
    {
      id: 'text:convert-encoding',
      label: '同格式（仅换字符编码）',
      from: [...TEXT_KINDS],
      to: 'txt',
      method: 'map',
      notices: ['仅改字节表示，文本内容与换行不改变', '输出扩展名与输入相同'],
      params: CONVERT_PARAMS,
      estimateOutput: (info, params) => {
        const to = typeof params.toEncoding === 'string' ? params.toEncoding : 'utf-8';
        if (to === 'utf-16le' || to === 'utf-16be') return info.size * 2;
        return info.size;
      },
      run: runConvertEncoding,
      status: 'live',
      group: '字符编码',
    },
    {
      id: 'text:txt-to-md',
      label: 'Markdown（保留原文，仅改扩展名）',
      from: ['text'],
      to: 'md',
      method: 'reflow',
      notices: ['仅改扩展名与编码，正文未做结构识别', '输出统一为 UTF-8'],
      params: [],
      estimateOutput: (info) => info.size,
      run: runTxtToMarkdown,
      status: 'live',
      group: '文本互转',
    },
    {
      id: 'text:txt-to-html',
      label: 'HTML（段落化 + 转义）',
      from: ['text'],
      to: 'html',
      method: 'reflow',
      notices: ['按空行分段，未识别标题 / 列表 / 表格', '特殊字符已转义'],
      params: [],
      estimateOutput: (info) => info.size + 1024,
      run: runTxtToHtml,
      status: 'live',
      group: '文本互转',
    },
    {
      id: 'text:subtitle-to-srt',
      label: 'SRT 字幕（广泛兼容）',
      from: [...SUBTITLE_KINDS],
      to: 'srt',
      method: 'map',
      notices: ['样式与特效可能丢失，仅保留对白与时间', '输出统一为 UTF-8'],
      params: [],
      match: (info: InspectInfo) => info.sniff.kind !== 'srt',
      estimateOutput: (info) => info.size,
      run: (ctx) => runSubtitleConvert(ctx, 'srt'),
      status: 'live',
      group: '字幕互转',
    },
    {
      id: 'text:subtitle-to-vtt',
      label: 'WebVTT 字幕（网页播放器）',
      from: [...SUBTITLE_KINDS],
      to: 'vtt',
      method: 'map',
      notices: ['样式与特效可能丢失，仅保留对白与时间', '输出统一为 UTF-8'],
      params: [],
      match: (info: InspectInfo) => info.sniff.kind !== 'vtt',
      estimateOutput: (info) => info.size,
      run: (ctx) => runSubtitleConvert(ctx, 'vtt'),
      status: 'live',
      group: '字幕互转',
    },
    {
      id: 'text:subtitle-to-ass',
      label: 'ASS 字幕（可设定样式模板）',
      from: [...SUBTITLE_KINDS],
      to: 'ass',
      method: 'map',
      notices: ['使用统一的 Default 样式模板，不恢复原设计', '原文内联标签按字面保留'],
      params: [],
      match: (info: InspectInfo) => info.sniff.kind !== 'ass',
      estimateOutput: (info) => info.size,
      run: (ctx) => runSubtitleConvert(ctx, 'ass'),
      status: 'live',
      group: '字幕互转',
    },
  ],
};

// 供单元测试与未来复用：暴露常量（不参与页面渲染）。
export const TEXT_CATEGORY_KINDS = TEXT_KINDS;
