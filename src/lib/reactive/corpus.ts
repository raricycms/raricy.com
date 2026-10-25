// ─────────────────────────────────────────────────────────────────────────────
// corpus.ts — 存量语料的**只读静态风险扫描**（P6）
//
// 这不是编译，也不宣称「编译等价」。它只回答一类问题：把现有 Markdown 交给
// ReactiveMD 之前，哪些**语法形状**需要人工复核。因此每份报告都带：
//   · `bucket: 'provisional'`、`compile: 'not-run'`、`textDiff: 'not-run'`；
//   · 不产出「C 类（等价）」结论 —— 那要等上游补丁后的固定版本重跑。
//
// 扫什么（全部在**盖掉代码**的副本上，代码块/行内代码里的同形文本不算）：
//   · 软换行（单换行）、硬换行、表格行、任务列表、脚注、裸 `<br>`；
//   · HTML 标签与 `class` / `style` / `on*` / 危险标签（audio / video / input …）；
//   · `{{ }}` 表达式、行首未知标签（`<panel>` / `<slider>` / `<theme>` / 宿主标签）；
//   · 数学命令/环境/宏/历史定界线（只做清单，不判定支持与否）；
//   · 五类 `[@…]` 引用（图床 / 音频 / 投票 / 收藏夹 / 剪贴板）与各档预算；
//   · 图片来源（站内 API / `/image/i/` 历史路径 / 历史 IP / http(s) 外链 / 相对 / data:）。
//
// 隐私边界：返回结构里**没有正文、没有标题**，只有 id、种类与计数。调用方（脚本）
// 也只在显式 `--out` 时落盘，默认不读生产库。
//
// 盖码为什么不用 `favorite-refs.ts` 的 `maskMarkdownCode`：那个实现为了替换方便把
// 整段代码（含换行）替换成等长 `x`，**行结构会被压平**；本扫描要按行判断软换行与
// 行首标签，需要保留换行。这里用同一套围栏/行内规则，但只把**非换行字符**涂掉。
// ─────────────────────────────────────────────────────────────────────────────

import { AUDIO_REF_RE, MAX_AUDIO_REFS } from '../audio-refs';
import { MAX_BLOG_REF_ITEMS, MAX_REF_EXPAND_CHARS, MAX_REF_FETCHES } from '../content-refs';
import { parseContentFormat, type ContentFormat } from '../content-format';
import { MAX_FAVORITE_REFS } from '../favorite-refs';
import { utf8ByteLength } from './cache';

export const CORPUS_SCAN_SCHEMA_VERSION = 1;

export type CorpusDocumentKind = 'blog' | 'clipboard';

export interface CorpusDocument {
  id: string;
  kind: CorpusDocumentKind;
  content: string;
  format: ContentFormat;
  formatSource: 'declared' | 'default';
}

export interface CorpusInputError {
  index: number;
  code:
    | 'not_array'
    | 'not_object'
    | 'missing_id'
    | 'invalid_kind'
    | 'missing_content'
    | 'invalid_format'
    | 'duplicate_id'
    | 'invalid_json';
  /** 不要放正文 / 标题；只写位置或类别。 */
  detail?: string;
}

/**
 * 校验原始输入。**不静默丢文档**：每一条不合法项都进 `errors`，合法的照常返回。
 *
 * 缺 format 视为存量 Markdown（迁移前的库就是这样）；显式给了非法值则报错，
 * 不替调用方猜成 Markdown。
 */
export function validateCorpusDocuments(raw: unknown): {
  documents: CorpusDocument[];
  errors: CorpusInputError[];
} {
  if (!Array.isArray(raw)) {
    return { documents: [], errors: [{ index: -1, code: 'not_array' }] };
  }

  const documents: CorpusDocument[] = [];
  const errors: CorpusInputError[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index, code: 'not_object' });
      return;
    }
    const record = item as Record<string, unknown>;
    let invalid = false;

    const id = record.id;
    const kind = record.kind;
    const content = record.content;

    if (typeof id !== 'string' || id.length === 0) {
      errors.push({ index, code: 'missing_id' });
      invalid = true;
    }
    if (kind !== 'blog' && kind !== 'clipboard') {
      errors.push({ index, code: 'invalid_kind' });
      invalid = true;
    }
    if (typeof content !== 'string') {
      errors.push({ index, code: 'missing_content' });
      invalid = true;
    }

    let format: ContentFormat = 'markdown';
    let formatSource: 'declared' | 'default' = 'default';
    if (record.format !== undefined) {
      const parsed = parseContentFormat(record.format);
      if (parsed === null) {
        errors.push({ index, code: 'invalid_format' });
        invalid = true;
      } else {
        format = parsed;
        formatSource = 'declared';
      }
    }

    if (invalid) return;

    const documentId = id as string;
    const documentKind = kind as CorpusDocumentKind;
    const key = `${documentKind}:${documentId}`;
    if (seen.has(key)) {
      errors.push({ index, code: 'duplicate_id' });
      return;
    }
    seen.add(key);
    documents.push({
      id: documentId,
      kind: documentKind,
      content: content as string,
      format,
      formatSource,
    });
  });

  return { documents, errors };
}

export interface CorpusStructureScan {
  softLineBreaks: number;
  hardBreaks: number;
  fencedBlocks: number;
  inlineCodeSpans: number;
  tableRows: number;
  taskListItems: number;
  footnoteMarkers: number;
  rawBrTags: number;
}

export interface CorpusHtmlScan {
  /** 只数**开标签**（闭合标签不计数）。 */
  openingTags: number;
  withClass: number;
  withStyle: number;
  withEvent: number;
  /** audio / video / input / button / iframe … 这些不在 P0 HTML 子集里。 */
  riskyTags: Record<string, number>;
  riskyTagOverflow: number;
}

export interface CorpusSyntaxCollisions {
  /** 完整 `{{ ... }}` 表达式个数。 */
  braceExpressions: number;
  /** `{{` 出现次数；大于表达式个数说明有未闭合/嵌套写法。 */
  braceOpenings: number;
  /** 行首 `<tag>` 且 tag 不在常见 HTML 名单里（ReactiveMD 组件/宿主标签风险）。 */
  unknownLineStartTags: Record<string, number>;
  unknownLineStartOverflow: number;
}

export interface CorpusMathScan {
  commands: Record<string, number>;
  commandOverflow: number;
  environments: Record<string, number>;
  environmentOverflow: number;
  macroDefinitions: number;
  /** `\\(` / `\\[` 这类历史定界线。 */
  legacyDelimiters: number;
  displayDollarMarkers: number;
  /** 有环境/宏/历史定界线 → 需要人工复核；不代表一定不支持。 */
  reviewNeeded: boolean;
}

export interface CorpusRefCounts {
  image: number;
  audio: number;
  vote: number;
  favorite: number;
  clipboard: number;
}

export interface CorpusRefScan {
  counts: CorpusRefCounts;
  unique: CorpusRefCounts;
  /** 主替换循环会尝试替换的条数（图床 + 剪贴板 + 投票）。 */
  replacementSlots: number;
  replacementBudget: number;
  replacementOverBudget: boolean;
  /** 需要取数的去重候选数（剪贴板 + 投票 + 收藏夹）。 */
  fetchCandidates: number;
  fetchBudget: number;
  fetchOverBudget: boolean;
  favoriteBudget: number;
  favoriteOverBudget: boolean;
  audioBudget: number;
  audioOverBudget: boolean;
  /** 展开后的总字符预算；源文本身超限时后续替换都会保留字面量。 */
  expandBudget: number;
  sourceOverExpandBudget: boolean;
}

export interface CorpusImageScan {
  total: number;
  internalApi: number;
  legacyPath: number;
  legacyIpHost: number;
  externalHttp: number;
  relative: number;
  dataUri: number;
  otherScheme: number;
}

export interface CorpusDocumentScan {
  id: string;
  kind: CorpusDocumentKind;
  format: ContentFormat;
  formatSource: 'declared' | 'default';
  bucket: 'provisional';
  compile: 'not-run';
  textDiff: 'not-run';
  sourceChars: number;
  sourceBytes: number;
  structure: CorpusStructureScan;
  html: CorpusHtmlScan;
  syntaxCollisions: CorpusSyntaxCollisions;
  math: CorpusMathScan;
  refs: CorpusRefScan;
  images: CorpusImageScan;
}

export interface CorpusTotals {
  documents: number;
  blogs: number;
  clipboards: number;
  documentsWithSoftLineBreaks: number;
  documentsWithHtml: number;
  documentsWithBraceExpressions: number;
  documentsWithMathReview: number;
  documentsWithReferences: number;
  documentsWithExternalImages: number;
  refs: CorpusRefCounts;
  images: CorpusImageScan;
  errors: number;
}

export interface CorpusReport {
  schemaVersion: typeof CORPUS_SCAN_SCHEMA_VERSION;
  generator: 'reactive-corpus-static-scan';
  provisional: true;
  compile: 'not-run';
  textDiff: 'not-run';
  scannedAt: string;
  totals: CorpusTotals;
  documents: CorpusDocumentScan[];
  errors: CorpusInputError[];
}

export interface CorpusReportOptions {
  /** 站点时钟 ISO（调用方传 `isoWithOffset(nowForDb())`）。 */
  scannedAt: string;
  errors?: readonly CorpusInputError[];
}

// ── 代码盖码（保留换行）──────────────────────────────────────────────────────

/** 把围栏代码块与行内代码里的非换行字符涂成 x；长度与行结构不变。 */
function maskCodePreservingLines(text: string): string {
  let out = text.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, (match) =>
    match.replace(/[^\n]/g, 'x')
  );
  out = out.replace(/`[^`\n]*`/g, (match) => match.replace(/[^\n]/g, 'x'));
  return out;
}

function countFenceMarkers(source: string): number {
  return (source.match(/(?:^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*/g) ?? []).length;
}

function countInlineCodeSpans(source: string): number {
  // 先把围栏整段（含换行）压成空格，避免把围栏里的反引号当成行内代码。
  const withoutFences = source.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, (match) =>
    ' '.repeat(match.length)
  );
  return (withoutFences.match(/`[^`\n]*`/g) ?? []).length;
}

// ── 行级结构 ─────────────────────────────────────────────────────────────────

function isBlockStartLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return true;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (trimmed.startsWith('>')) return true;
  if (/^([-*+]|\d{1,9}[.)])\s/.test(trimmed)) return true;
  if (trimmed.startsWith('|')) return true;
  if (/^(`{3,}|~{3,})/.test(trimmed)) return true;
  if (/^<[A-Za-z!/]/.test(trimmed)) return true;
  if (/^(\*{3,}|-{3,}|_{3,}|={3,})$/.test(trimmed)) return true;
  return false;
}

interface LineScanResult {
  softLineBreaks: number;
  hardBreaks: number;
  tableRows: number;
  taskListItems: number;
  footnoteMarkers: number;
  unknownLineStartTags: Map<string, number>;
  unknownLineStartOverflow: number;
}

const KNOWN_HTML_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'audio', 'b', 'blockquote', 'br', 'button',
  'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q',
  's', 'samp', 'section', 'small', 'source', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'track',
  'u', 'ul', 'video',
]);

const MAX_NAMED_KEYS = 40;

function bumpNamed(map: Map<string, number>, name: string): boolean {
  const current = map.get(name);
  if (current !== undefined) {
    map.set(name, current + 1);
    return true;
  }
  if (map.size >= MAX_NAMED_KEYS) return false;
  map.set(name, 1);
  return true;
}

function scanLines(source: string): LineScanResult {
  const lines = source.split('\n');
  let inFence = false;
  let fenceMarker = '';
  let softLineBreaks = 0;
  let hardBreaks = 0;
  let tableRows = 0;
  let taskListItems = 0;
  let footnoteMarkers = 0;
  const unknownLineStartTags = new Map<string, number>();
  let unknownLineStartOverflow = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    if (line.trimStart().startsWith('|')) tableRows += 1;
    if (/^[ \t]*[-*+]\s+\[[ xX]\]\s/.test(line)) taskListItems += 1;
    footnoteMarkers += (line.match(/\[\^[^\]]+\]/g) ?? []).length;

    const lineStartTag = /^[ \t]*<([A-Za-z][A-Za-z0-9-]*)/.exec(line);
    if (lineStartTag && !KNOWN_HTML_TAGS.has(lineStartTag[1].toLowerCase())) {
      if (!bumpNamed(unknownLineStartTags, lineStartTag[1].toLowerCase())) {
        unknownLineStartOverflow += 1;
      }
    }

    const trimmedEnd = line.trimEnd();
    if (trimmedEnd.length === 0) continue;
    const isHardBreak = / {2,}$/.test(line) || /\\$/.test(trimmedEnd);
    if (isHardBreak) hardBreaks += 1;

    const next = lines[index + 1];
    if (next === undefined || next.trim().length === 0) continue;
    if (isBlockStartLine(line) || isBlockStartLine(next)) continue;
    if (isHardBreak) continue;
    softLineBreaks += 1;
  }

  return {
    softLineBreaks,
    hardBreaks,
    tableRows,
    taskListItems,
    footnoteMarkers,
    unknownLineStartTags,
    unknownLineStartOverflow,
  };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const RISKY_HTML_TAGS = new Set([
  'audio', 'video', 'source', 'track', 'input', 'button', 'iframe', 'object',
  'embed', 'form', 'textarea', 'select', 'option', 'canvas', 'svg',
]);

const HTML_TAG_RE = /<([A-Za-z][A-Za-z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)>/g;

function scanHtml(masked: string): Omit<CorpusHtmlScan, 'riskyTags' | 'riskyTagOverflow'> & {
  riskyTags: Map<string, number>;
  riskyTagOverflow: number;
} {
  let openingTags = 0;
  let withClass = 0;
  let withStyle = 0;
  let withEvent = 0;
  const riskyTags = new Map<string, number>();
  let riskyTagOverflow = 0;

  for (const match of masked.matchAll(HTML_TAG_RE)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? '';
    openingTags += 1;
    if (/\bclass\s*=/i.test(attrs)) withClass += 1;
    if (/\bstyle\s*=/i.test(attrs)) withStyle += 1;
    if (/\bon[a-z]+\s*=/i.test(attrs)) withEvent += 1;
    if (RISKY_HTML_TAGS.has(tag) && !bumpNamed(riskyTags, tag)) {
      riskyTagOverflow += 1;
    }
  }

  return { openingTags, withClass, withStyle, withEvent, riskyTags, riskyTagOverflow };
}

// ── 数学 ─────────────────────────────────────────────────────────────────────

function scanMath(masked: string): CorpusMathScan {
  const commands = new Map<string, number>();
  let commandOverflow = 0;
  for (const match of masked.matchAll(/\\([A-Za-z]+)/g)) {
    const name = match[1];
    if (name === 'begin' || name === 'end') continue;
    if (!bumpNamed(commands, name)) commandOverflow += 1;
  }

  const environments = new Map<string, number>();
  let environmentOverflow = 0;
  for (const match of masked.matchAll(/\\begin\{([^{}]+)\}/g)) {
    if (!bumpNamed(environments, match[1].trim())) environmentOverflow += 1;
  }

  const macroDefinitions = (
    masked.match(/\\(?:newcommand|renewcommand|def|DeclareMathOperator)\b/g) ?? []
  ).length;

  const legacyDelimiters =
    (masked.match(/\\\(/g) ?? []).length +
    (masked.match(/\\\)/g) ?? []).length +
    (masked.match(/\\\[/g) ?? []).length +
    (masked.match(/\\\]/g) ?? []).length;
  const displayDollarMarkers = (masked.match(/\$\$/g) ?? []).length;

  return {
    commands: Object.fromEntries(commands),
    commandOverflow,
    environments: Object.fromEntries(environments),
    environmentOverflow,
    macroDefinitions,
    legacyDelimiters,
    displayDollarMarkers,
    reviewNeeded:
      environments.size > 0 || macroDefinitions > 0 || legacyDelimiters > 0,
  };
}

// ── 引用与预算 ───────────────────────────────────────────────────────────────

function scanReferences(masked: string, sourceChars: number): CorpusRefScan {
  const unique = {
    image: new Set<string>(),
    audio: new Set<string>(),
    vote: new Set<string>(),
    favorite: new Set<string>(),
    clipboard: new Set<string>(),
  };
  const counts: CorpusRefCounts = {
    image: 0,
    audio: 0,
    vote: 0,
    favorite: 0,
    clipboard: 0,
  };

  // 数字 token 按长度分流，与 content-ref-processor 同口径；只认字母数字
  // （下划线凑出来的伪 id 不算）。
  for (const match of masked.matchAll(/\[@\s*([A-Za-z0-9]+)\s*\]/g)) {
    const id = match[1];
    let kind: keyof CorpusRefCounts | null = null;
    if (id.length === 10) kind = 'image';
    else if (id.length === 9) kind = 'vote';
    else if (id.length === 8) kind = 'clipboard';
    else if (/^[0-9]{6}$/.test(id)) kind = 'favorite';
    if (!kind) continue;
    counts[kind] += 1;
    unique[kind].add(id);
  }

  for (const match of masked.matchAll(new RegExp(AUDIO_REF_RE.source, 'g'))) {
    counts.audio += 1;
    unique.audio.add(match[1]);
  }

  // 这里的计数是**出现次数**：成功替换还要看引用能否取到。作为风险扫描，
  // 它给出的是「主循环最多会尝试多少处」的上界，不声称等于最终替换数。
  const replacementSlots = counts.image + counts.clipboard + counts.vote;
  const fetchCandidates =
    unique.clipboard.size + unique.vote.size + unique.favorite.size;

  return {
    counts,
    unique: {
      image: unique.image.size,
      audio: unique.audio.size,
      vote: unique.vote.size,
      favorite: unique.favorite.size,
      clipboard: unique.clipboard.size,
    },
    replacementSlots,
    replacementBudget: MAX_BLOG_REF_ITEMS,
    replacementOverBudget: replacementSlots > MAX_BLOG_REF_ITEMS,
    fetchCandidates,
    fetchBudget: MAX_REF_FETCHES,
    fetchOverBudget: fetchCandidates > MAX_REF_FETCHES,
    favoriteBudget: MAX_FAVORITE_REFS,
    favoriteOverBudget: counts.favorite > MAX_FAVORITE_REFS,
    audioBudget: MAX_AUDIO_REFS,
    audioOverBudget: counts.audio > MAX_AUDIO_REFS,
    expandBudget: MAX_REF_EXPAND_CHARS,
    sourceOverExpandBudget: sourceChars > MAX_REF_EXPAND_CHARS,
  };
}

// ── 图片来源 ─────────────────────────────────────────────────────────────────

type ImageSourceKind =
  | 'internalApi'
  | 'legacyPath'
  | 'legacyIpHost'
  | 'externalHttp'
  | 'relative'
  | 'dataUri'
  | 'otherScheme';

function classifyImageUrl(rawUrl: string): ImageSourceKind {
  const url = rawUrl.trim();
  if (/^data:/i.test(url)) return 'dataUri';
  // 历史正文里写死了这个主机（next.config.mjs 有说明）：它不是站内路由，必须单独认。
  if (url.includes('116.62.179.232:22822')) return 'legacyIpHost';
  if (url.startsWith('/api/images/')) return 'internalApi';
  if (url.startsWith('/image/i/')) return 'legacyPath';
  if (/^https?:\/\//i.test(url) || url.startsWith('//')) return 'externalHttp';
  if (url.startsWith('/')) return 'relative';
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return 'relative';
  return 'otherScheme';
}

const MD_IMAGE_RE =
  /!\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)\n]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMG_SRC_RE =
  /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function scanImages(masked: string): CorpusImageScan {
  const scan: CorpusImageScan = {
    total: 0,
    internalApi: 0,
    legacyPath: 0,
    legacyIpHost: 0,
    externalHttp: 0,
    relative: 0,
    dataUri: 0,
    otherScheme: 0,
  };

  const visit = (url: string | undefined) => {
    if (!url) return;
    scan.total += 1;
    scan[classifyImageUrl(url)] += 1;
  };

  for (const match of masked.matchAll(MD_IMAGE_RE)) {
    visit(match[1] ?? match[2]);
  }
  for (const match of masked.matchAll(HTML_IMG_SRC_RE)) {
    visit(match[1] ?? match[2] ?? match[3]);
  }

  return scan;
}

// ── 单篇与整份报告 ───────────────────────────────────────────────────────────

export function scanCorpusDocument(document: CorpusDocument): CorpusDocumentScan {
  const masked = maskCodePreservingLines(document.content);
  const lines = scanLines(document.content);
  const html = scanHtml(masked);
  const refs = scanReferences(masked, document.content.length);
  const math = scanMath(masked);

  const braceExpressions = (masked.match(/\{\{[\s\S]*?\}\}/g) ?? []).length;
  const braceOpenings = (masked.match(/\{\{/g) ?? []).length;

  return {
    id: document.id,
    kind: document.kind,
    format: document.format,
    formatSource: document.formatSource,
    bucket: 'provisional',
    compile: 'not-run',
    textDiff: 'not-run',
    sourceChars: document.content.length,
    sourceBytes: utf8ByteLength(document.content),
    structure: {
      softLineBreaks: lines.softLineBreaks,
      hardBreaks: lines.hardBreaks,
      fencedBlocks: Math.floor(countFenceMarkers(document.content) / 2),
      inlineCodeSpans: countInlineCodeSpans(document.content),
      tableRows: lines.tableRows,
      taskListItems: lines.taskListItems,
      footnoteMarkers: lines.footnoteMarkers,
      rawBrTags: (masked.match(/<br\b[^>]*>/gi) ?? []).length,
    },
    html: {
      openingTags: html.openingTags,
      withClass: html.withClass,
      withStyle: html.withStyle,
      withEvent: html.withEvent,
      riskyTags: Object.fromEntries(html.riskyTags),
      riskyTagOverflow: html.riskyTagOverflow,
    },
    syntaxCollisions: {
      braceExpressions,
      braceOpenings,
      unknownLineStartTags: Object.fromEntries(lines.unknownLineStartTags),
      unknownLineStartOverflow: lines.unknownLineStartOverflow,
    },
    math,
    refs,
    images: scanImages(masked),
  };
}

function emptyCounts(): CorpusRefCounts {
  return { image: 0, audio: 0, vote: 0, favorite: 0, clipboard: 0 };
}

function emptyImageScan(): CorpusImageScan {
  return {
    total: 0,
    internalApi: 0,
    legacyPath: 0,
    legacyIpHost: 0,
    externalHttp: 0,
    relative: 0,
    dataUri: 0,
    otherScheme: 0,
  };
}

function buildTotals(
  documents: readonly CorpusDocumentScan[],
  errorCount: number
): CorpusTotals {
  const refs = emptyCounts();
  const images = emptyImageScan();
  const totals: CorpusTotals = {
    documents: documents.length,
    blogs: 0,
    clipboards: 0,
    documentsWithSoftLineBreaks: 0,
    documentsWithHtml: 0,
    documentsWithBraceExpressions: 0,
    documentsWithMathReview: 0,
    documentsWithReferences: 0,
    documentsWithExternalImages: 0,
    refs,
    images,
    errors: errorCount,
  };

  for (const document of documents) {
    if (document.kind === 'blog') totals.blogs += 1;
    else totals.clipboards += 1;
    if (document.structure.softLineBreaks > 0) totals.documentsWithSoftLineBreaks += 1;
    if (document.html.openingTags > 0) totals.documentsWithHtml += 1;
    if (document.syntaxCollisions.braceExpressions > 0) {
      totals.documentsWithBraceExpressions += 1;
    }
    if (document.math.reviewNeeded) totals.documentsWithMathReview += 1;
    const referenceCount = Object.values(document.refs.counts).reduce(
      (sum, value) => sum + value,
      0
    );
    if (referenceCount > 0) totals.documentsWithReferences += 1;
    if (document.images.externalHttp > 0 || document.images.legacyIpHost > 0) {
      totals.documentsWithExternalImages += 1;
    }

    for (const kind of Object.keys(refs) as Array<keyof CorpusRefCounts>) {
      refs[kind] += document.refs.counts[kind];
    }
    for (const kind of Object.keys(images) as Array<keyof CorpusImageScan>) {
      images[kind] += document.images[kind];
    }
  }

  return totals;
}

/**
 * 扫描已校验的文档并生成报告。
 *
 * 报告是**静态风险清单**：没有正文、没有标题、没有「C 类可迁移」结论。
 * `scannedAt` 由调用方传入站点时钟（本模块不取「现在」）。
 */
export function scanCorpusDocuments(
  documents: readonly CorpusDocument[],
  options: CorpusReportOptions
): CorpusReport {
  if (typeof options?.scannedAt !== 'string' || options.scannedAt.length === 0) {
    throw new TypeError('scannedAt 必须是站点时钟的 ISO 字符串');
  }
  const scans = documents.map(scanCorpusDocument);
  const errors = [...(options.errors ?? [])];
  return {
    schemaVersion: CORPUS_SCAN_SCHEMA_VERSION,
    generator: 'reactive-corpus-static-scan',
    provisional: true,
    compile: 'not-run',
    textDiff: 'not-run',
    scannedAt: options.scannedAt,
    totals: buildTotals(scans, errors.length),
    documents: scans,
    errors,
  };
}
