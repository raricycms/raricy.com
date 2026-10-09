// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/office.ts —— Office / 标记文档引擎（DOCX ↔ HTML/MD/TXT）。
//
// 【范围】
//   · 读 DOCX：mammoth（convertToHtml / extractRawText）。
//   · 写 DOCX：docx 包（Document / Paragraph / TextRun / HeadingLevel / ImageRun）。
//   · 两段之间的**结构转换**（HTML → 块级/行内模型，MD ← 块级模型）是本文件
//     自己的**零依赖纯逻辑**：分词、解析、映射都不吃任何库，node 单测可直接驱动。
//
// 【为什么把 pure 与 engine 分开】重引擎（mammoth / docx）一律在函数体内
//   `await import(...)` 动态引入 —— 静态 import 会把它们卷进每个页面的主包。
//   纯逻辑（tokenize / parseBlocks / blocksToMarkdown / messages→notices）放在
//   顶层，随本模块被 node 单测直接 import，不触发任何重引擎加载。
//
// 【诚实边界（roadmap §7.1 / §15）】
//   · 只做「内容结构」转换，不承诺像素级版式：字体 / 页边距 / 页眉页脚 / 域 /
//     浮动对象都不保留，结果页逐条列出。
//   · HTML/MD → DOCX 只映射标题 / 段落 / 粗斜体 / 行内代码 / 列表 / 引用 / 代码块 / 链接；
//     表格降级为文本、图片丢弃（除非是 data: URL）—— 都进 notices。
//   · DOCX → MD/HTML/TXT 由 mammoth 的语义映射产出，不是原样导出。
// ─────────────────────────────────────────────────────────────────────────────

import type { ConvertError } from '../types';

// ─── 结构化中间表示（IR）──────────────────────────────────────────────────────
//
// 只有块级 + 行内两级；表格降级为纯文本单元格（不保留表内联样式），
// 图片在 DOCX 侧丢弃（data: URL 除外），在 Markdown 侧保留为 ![]()。

export type OfficeInline =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'img'; alt: string; src: string };

export type OfficeBlock =
  | { kind: 'heading'; level: number; spans: OfficeInline[] }
  | { kind: 'paragraph'; spans: OfficeInline[] }
  | { kind: 'listItem'; ordered: boolean; level: number; index: number; spans: OfficeInline[] }
  | { kind: 'quote'; spans: OfficeInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; rows: string[][] };

// ─── 实体解码（HTML 文本节点）─────────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, ent: string) => {
    if (ENTITY_MAP[ent] !== undefined) return ENTITY_MAP[ent];
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
    }
    return full;
  });
}

// ─── 分词 ─────────────────────────────────────────────────────────────────────

interface OpenTok { kind: 'open'; name: string; attrs: Record<string, string> }
interface CloseTok { kind: 'close'; name: string }
interface SelfTok { kind: 'self'; name: string; attrs: Record<string, string> }
interface TextTok { kind: 'text'; text: string }
type Tok = OpenTok | CloseTok | SelfTok | TextTok;

const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'wbr', 'source']);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

/** 去掉注释 / script / style / head（连同内容），再切成标签与文本 token。 */
function tokenize(html: string): Tok[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '');
  const toks: Tok[] = [];
  const re = /<(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) toks.push({ kind: 'text', text: cleaned.slice(last, m.index) });
    last = re.lastIndex;
    const name = m[2].toLowerCase();
    if (m[1] === '/') {
      toks.push({ kind: 'close', name });
    } else if (m[4] === '/' || VOID_TAGS.has(name)) {
      toks.push({ kind: 'self', name, attrs: parseAttrs(m[3]) });
    } else {
      toks.push({ kind: 'open', name, attrs: parseAttrs(m[3]) });
    }
  }
  if (last < cleaned.length) toks.push({ kind: 'text', text: cleaned.slice(last) });
  return toks;
}

/** 取 toks[i]（一个 open 标签）到与之配对的 close 之间的 token；返回 [inner, nextIndex]。 */
function collectUntilClose(toks: Tok[], i: number, name: string): [Tok[], number] {
  const inner: Tok[] = [];
  let depth = 0;
  let j = i;
  while (j < toks.length) {
    const tk = toks[j];
    if (tk.kind === 'open' && tk.name === name) {
      depth++;
      if (depth > 1) inner.push(tk);
    } else if (tk.kind === 'close' && tk.name === name) {
      depth--;
      if (depth === 0) return [inner, j + 1];
      inner.push(tk);
    } else {
      inner.push(tk);
    }
    j++;
  }
  return [inner, j];
}

// ─── 行内解析 ─────────────────────────────────────────────────────────────────

function applyStyle(spans: OfficeInline[], style: { bold?: boolean; italic?: boolean }): OfficeInline[] {
  return spans.map((s) => (s.kind === 'text' ? { ...s, ...style } : s));
}

/** 把一组 token 的全部文本拼起来（忽略标签结构），用于代码 / 链接标签文本。 */
function innerRawText(toks: Tok[]): string {
  let s = '';
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.kind === 'text') {
      s += tk.text;
      i++;
      continue;
    }
    if (tk.kind === 'self' && tk.name === 'br') {
      s += '\n';
      i++;
      continue;
    }
    if (tk.kind === 'open') {
      const [inner, next] = collectUntilClose(toks, i, tk.name);
      s += innerRawText(inner);
      i = next;
      continue;
    }
    i++;
  }
  return s;
}

function textInline(rawText: string, style?: { bold?: boolean; italic?: boolean; code?: boolean }): OfficeInline[] {
  const text = decodeHtmlEntities(rawText).replace(/[ \t]*\n[ \t]*/g, ' ');
  if (!text) return [];
  return [{ kind: 'text', text, ...style }];
}

function parseInlines(toks: Tok[]): OfficeInline[] {
  const out: OfficeInline[] = [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.kind === 'text') {
      out.push(...textInline(tk.text));
      i++;
      continue;
    }
    if (tk.kind === 'self') {
      if (tk.name === 'br') out.push({ kind: 'text', text: '\n' });
      else if (tk.name === 'img') out.push({ kind: 'img', alt: tk.attrs.alt ?? '', src: tk.attrs.src ?? '' });
      i++;
      continue;
    }
    if (tk.kind === 'close') {
      i++;
      continue;
    }
    const name = tk.name;
    if (name === 'br') {
      out.push({ kind: 'text', text: '\n' });
      i++;
      continue;
    }
    if (name === 'img') {
      out.push({ kind: 'img', alt: tk.attrs.alt ?? '', src: tk.attrs.src ?? '' });
      i++;
      continue;
    }
    const [inner, next] = collectUntilClose(toks, i, name);
    if (name === 'strong' || name === 'b') out.push(...applyStyle(parseInlines(inner), { bold: true }));
    else if (name === 'em' || name === 'i') out.push(...applyStyle(parseInlines(inner), { italic: true }));
    else if (name === 'code' || name === 'kbd' || name === 'samp' || name === 'tt') {
      const t = decodeHtmlEntities(innerRawText(inner));
      if (t) out.push({ kind: 'text', text: t, code: true });
    } else if (name === 'a') {
      const href = tk.attrs.href ?? '';
      const label = decodeHtmlEntities(innerRawText(inner)).trim() || href;
      out.push({ kind: 'link', text: label, href });
    } else {
      out.push(...parseInlines(inner));
    }
    i = next;
  }
  return out;
}

// ─── 块级解析 ─────────────────────────────────────────────────────────────────

const HEADING_RE = /^h([1-6])$/;

function trimSpans(spans: OfficeInline[]): OfficeInline[] {
  // 去掉首尾纯空白文本，段落里不留孤立空白
  const out = spans.slice();
  while (out.length) {
    const head = out[0];
    if (head.kind === 'text' && head.text.trim() === '') out.shift();
    else break;
  }
  while (out.length) {
    const tail = out[out.length - 1];
    if (tail.kind === 'text' && tail.text.trim() === '') out.pop();
    else break;
  }
  return out;
}

interface ListParseResult {
  blocks: OfficeBlock[];
  next: number;
}

function parseList(toks: Tok[], i: number, ordered: boolean, level: number): ListParseResult {
  const container = ordered ? 'ol' : 'ul';
  const [inner, after] = collectUntilClose(toks, i, container);
  const blocks: OfficeBlock[] = [];
  let j = 0;
  let order = 0;
  while (j < inner.length) {
    const tk = inner[j];
    if (tk.kind === 'open' && tk.name === 'li') {
      const [liInner, liNext] = collectUntilClose(inner, j, 'li');
      order++;
      // li 里可能嵌着子列表：找到第一个直接子 ul/ol，把之前的部分当行内。
      const nestedAt = liInner.findIndex((t) => t.kind === 'open' && (t.name === 'ul' || t.name === 'ol'));
      const head = nestedAt >= 0 ? liInner.slice(0, nestedAt) : liInner;
      const spans = trimSpans(parseInlines(head));
      if (spans.length) blocks.push({ kind: 'listItem', ordered, level, index: order, spans });
      let k = nestedAt;
      while (k >= 0 && k < liInner.length) {
        const nt = liInner[k];
        if (nt.kind === 'open' && (nt.name === 'ul' || nt.name === 'ol')) {
          const nested = parseList(liInner, k, nt.name === 'ol', level + 1);
          blocks.push(...nested.blocks);
          k = nested.next;
        } else {
          k++;
        }
      }
      j = liNext;
      continue;
    }
    j++;
  }
  return { blocks, next: after };
}

function parseTable(toks: Tok[], i: number): [OfficeBlock | null, number] {
  const [inner, next] = collectUntilClose(toks, i, 'table');
  const rows: string[][] = [];
  const headerFlags: boolean[] = [];
  let j = 0;
  while (j < inner.length) {
    const tk = inner[j];
    if (tk.kind === 'open' && tk.name === 'tr') {
      const [rowInner, rowNext] = collectUntilClose(inner, j, 'tr');
      const cells: string[] = [];
      let isHeader = false;
      let c = 0;
      while (c < rowInner.length) {
        const ct = rowInner[c];
        if (ct.kind === 'open' && (ct.name === 'td' || ct.name === 'th')) {
          const [cellInner, cellNext] = collectUntilClose(rowInner, c, ct.name);
          if (ct.name === 'th') isHeader = true;
          cells.push(decodeHtmlEntities(innerRawText(cellInner)).replace(/\s+/g, ' ').trim());
          c = cellNext;
          continue;
        }
        c++;
      }
      if (cells.length) {
        rows.push(cells);
        headerFlags.push(isHeader);
      }
      j = rowNext;
      continue;
    }
    j++;
  }
  if (!rows.length) return [null, next];
  const hasHeader = headerFlags[0] === true;
  return [
    { kind: 'table', header: hasHeader ? rows[0] : [], rows: hasHeader ? rows.slice(1) : rows },
    next,
  ];
}

function parseBlockList(toks: Tok[]): OfficeBlock[] {
  const blocks: OfficeBlock[] = [];
  let loose: OfficeInline[] = [];
  const flush = (): void => {
    const s = trimSpans(loose);
    if (s.length) blocks.push({ kind: 'paragraph', spans: s });
    loose = [];
  };
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.kind === 'text') {
      loose.push(...textInline(tk.text));
      i++;
      continue;
    }
    if (tk.kind === 'close') {
      i++;
      continue;
    }
    if (tk.kind === 'self') {
      if (tk.name === 'img') loose.push({ kind: 'img', alt: tk.attrs.alt ?? '', src: tk.attrs.src ?? '' });
      else if (tk.name === 'br') loose.push({ kind: 'text', text: '\n' });
      else if (tk.name === 'hr') {
        flush();
        blocks.push({ kind: 'hr' });
      }
      i++;
      continue;
    }
    // open
    const name = tk.name;
    const headingM = HEADING_RE.exec(name);
    if (headingM) {
      flush();
      const [inner, next] = collectUntilClose(toks, i, name);
      blocks.push({ kind: 'heading', level: Number(headingM[1]), spans: trimSpans(parseInlines(inner)) });
      i = next;
      continue;
    }
    if (name === 'p' || name === 'div' || name === 'section' || name === 'article' || name === 'header' || name === 'footer' || name === 'main' || name === 'figure' || name === 'figcaption') {
      flush();
      const [inner, next] = collectUntilClose(toks, i, name);
      const spans = trimSpans(parseInlines(inner));
      if (spans.length) blocks.push({ kind: 'paragraph', spans });
      i = next;
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      flush();
      const r = parseList(toks, i, name === 'ol', 0);
      blocks.push(...r.blocks);
      i = r.next;
      continue;
    }
    if (name === 'li') {
      // 顶层的孤立 li（罕见）：当段落处理
      flush();
      const [inner, next] = collectUntilClose(toks, i, 'li');
      const spans = trimSpans(parseInlines(inner));
      if (spans.length) blocks.push({ kind: 'paragraph', spans });
      i = next;
      continue;
    }
    if (name === 'blockquote') {
      flush();
      const [inner, next] = collectUntilClose(toks, i, 'blockquote');
      // 引用里再分块的话，把每块的行内拼到一行引文（版式损失在结果页说明）
      const spans = trimSpans(parseInlines(inner));
      if (spans.length) blocks.push({ kind: 'quote', spans });
      i = next;
      continue;
    }
    if (name === 'pre') {
      flush();
      const [inner, next] = collectUntilClose(toks, i, 'pre');
      // pre 里可能包着 <code>；取全部文本
      blocks.push({ kind: 'code', text: decodeHtmlEntities(innerRawText(inner)).replace(/\n$/, '') });
      i = next;
      continue;
    }
    if (name === 'table') {
      flush();
      const [tbl, next] = parseTable(toks, i);
      if (tbl) blocks.push(tbl);
      i = next;
      continue;
    }
    if (name === 'hr') {
      flush();
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (name === 'br') {
      loose.push({ kind: 'text', text: '\n' });
      i++;
      continue;
    }
    // 其它（span / strong / em / a / code / u / s…）：当行内元素处理
    const [inner, next] = collectUntilClose(toks, i, name);
    loose.push(...parseInlines([{ kind: 'open', name, attrs: tk.attrs }, ...inner, { kind: 'close', name }]));
    i = next;
  }
  flush();
  return blocks;
}

// ─── 对外纯逻辑 ───────────────────────────────────────────────────────────────

/** 纯文本 → 块级模型：以空行分段，段内换行保留为软换行。 */
export function textToBlocks(text: string): OfficeBlock[] {
  const norm = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  return norm
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ''))
    .filter((block) => block.trim() !== '')
    .map((block) => ({ kind: 'paragraph' as const, spans: [{ kind: 'text' as const, text: block }] }));
}

/** HTML → 块级模型（mammoth / marked 的产物都是它的输入）。 */
export function htmlToBlocks(html: string): OfficeBlock[] {
  return parseBlockList(tokenize(html));
}

function inlineToMarkdown(spans: OfficeInline[]): string {
  let s = '';
  for (const sp of spans) {
    if (sp.kind === 'text') {
      let t = sp.text;
      if (sp.code) t = '`' + t + '`';
      if (sp.italic) t = '*' + t + '*';
      if (sp.bold) t = '**' + t + '**';
      s += t;
    } else if (sp.kind === 'link') {
      s += `[${sp.text}](${sp.href})`;
    } else {
      s += `![${sp.alt}](${sp.src})`;
    }
  }
  return s;
}

/** 块级模型 → Markdown（table 走管道表；图片保留 ![]()）。 */
export function blocksToMarkdown(blocks: OfficeBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        parts.push(`${'#'.repeat(Math.min(6, Math.max(1, b.level)))} ${inlineToMarkdown(b.spans)}`);
        break;
      case 'paragraph':
        parts.push(inlineToMarkdown(b.spans));
        break;
      case 'listItem': {
        const indent = '  '.repeat(b.level);
        const mark = b.ordered ? `${b.index}. ` : '- ';
        parts.push(`${indent}${mark}${inlineToMarkdown(b.spans)}`);
        break;
      }
      case 'quote':
        parts.push(`> ${inlineToMarkdown(b.spans)}`);
        break;
      case 'code':
        parts.push('```\n' + b.text + '\n```');
        break;
      case 'hr':
        parts.push('---');
        break;
      case 'table': {
        const sep = (n: number) => '| ' + Array.from({ length: n }, () => '---').join(' | ') + ' |';
        const row = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
        const lines: string[] = [];
        if (b.header.length) {
          lines.push(row(b.header), sep(b.header.length));
          for (const r of b.rows) lines.push(row(r));
        } else {
          const first = b.rows[0] ?? [];
          lines.push(row(first), sep(first.length));
          for (const r of b.rows.slice(1)) lines.push(row(r));
        }
        parts.push(lines.join('\n'));
        break;
      }
    }
  }
  return parts.join('\n\n').trim();
}

/** HTML → Markdown（最小标签映射，p / h1-6 / strong / em / ul / ol / li / a / img）。 */
export function htmlToMarkdown(html: string): string {
  return blocksToMarkdown(htmlToBlocks(html));
}

export interface MammothMessage {
  type: 'warning' | 'error';
  message: string;
}

/** mammoth 的 messages 折算成结果页 notices（截断，避免刷屏）。 */
export function mammothMessagesToNotices(messages: MammothMessage[] | undefined, limit = 8): string[] {
  if (!messages || messages.length === 0) return [];
  const out: string[] = [];
  const errors = messages.filter((m) => m.type === 'error').length;
  const warnings = messages.filter((m) => m.type === 'warning').length;
  const head = `文档解析提示：${warnings} 条警告、${errors} 条错误`;
  out.push(head);
  for (const m of messages.slice(0, limit)) {
    const tag = m.type === 'error' ? '错误' : '警告';
    const text = (m.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text) out.push(`${tag}：${text}`);
  }
  if (messages.length > limit) out.push(`其余 ${messages.length - limit} 条提示从略`);
  return out;
}

// ─── 引擎调用（全部动态 import）───────────────────────────────────────────────

type DocxModule = typeof import('docx');

function loadMammoth(mod: unknown): {
  convertToHtml: (input: Record<string, unknown>) => Promise<{ value: string; messages: MammothMessage[] }>;
  extractRawText: (input: Record<string, unknown>) => Promise<{ value: string; messages: MammothMessage[] }>;
} {
  const m = mod as { default?: unknown } & Record<string, unknown>;
  const impl = (m.default ?? m) as {
    convertToHtml: (input: unknown) => Promise<{ value: string; messages: MammothMessage[] }>;
    extractRawText: (input: unknown) => Promise<{ value: string; messages: MammothMessage[] }>;
  };
  return {
    convertToHtml: (input) => impl.convertToHtml(input),
    extractRawText: (input) => impl.extractRawText(input),
  };
}

/**
 * mammoth 的输入形状**按构建而变**：浏览器构建要 `arrayBuffer`，node 构建要 `buffer`
 * （两边各自的 unzip.js 只认一种）。给足两者让同一份代码两端都通 —— mammoth 只读
 * 它认识的那个键，多余的键被忽略。不裸写 `Buffer` 标识符（浏览器没有它；用 globalThis
 * 探测，避免打包器把它当缺失的 Node 全局）。
 */
function mammothInput(bytes: Uint8Array): Record<string, unknown> {
  const arrayBuffer = toArrayBuffer(bytes);
  const input: Record<string, unknown> = { arrayBuffer };
  const BufferCtor = (globalThis as { Buffer?: { from(b: Uint8Array): unknown } }).Buffer;
  if (BufferCtor) input.buffer = BufferCtor.from(bytes);
  return input;
}

/** DOCX 字节 → HTML（mammoth.convertToHtml）。 */
export async function docxToHtml(bytes: Uint8Array): Promise<{ html: string; messages: MammothMessage[] }> {
  const mod = await import('mammoth');
  const mammoth = loadMammoth(mod);
  try {
    const r = await mammoth.convertToHtml(mammothInput(bytes));
    return { html: r.value ?? '', messages: r.messages ?? [] };
  } catch (e) {
    throw { kind: 'corrupt', message: '无法读取 DOCX 内容，文件可能损坏或不是有效的 Word 文档', detail: errText(e).slice(0, 1500) } satisfies ConvertError;
  }
}

/** DOCX 字节 → 纯文本（mammoth.extractRawText）。 */
export async function docxToText(bytes: Uint8Array): Promise<{ text: string; messages: MammothMessage[] }> {
  const mod = await import('mammoth');
  const mammoth = loadMammoth(mod);
  try {
    const r = await mammoth.extractRawText(mammothInput(bytes));
    return { text: r.value ?? '', messages: r.messages ?? [] };
  } catch (e) {
    throw { kind: 'corrupt', message: '无法提取 DOCX 文本，文件可能损坏或不是有效的 Word 文档', detail: errText(e).slice(0, 1500) } satisfies ConvertError;
  }
}

function headingOf(docx: DocxModule, level: number): (typeof docx.HeadingLevel)[keyof typeof docx.HeadingLevel] {
  const map = [
    docx.HeadingLevel.HEADING_1,
    docx.HeadingLevel.HEADING_2,
    docx.HeadingLevel.HEADING_3,
    docx.HeadingLevel.HEADING_4,
    docx.HeadingLevel.HEADING_5,
    docx.HeadingLevel.HEADING_6,
  ];
  return map[Math.min(6, Math.max(1, level)) - 1];
}

/** 行内 spans → docx 子元素（TextRun / ExternalHyperlink），软换行拆成带 break 的 run。 */
function inlinesToRuns(docx: DocxModule, spans: OfficeInline[]): import('docx').ParagraphChild[] {
  const children: import('docx').ParagraphChild[] = [];
  for (const sp of spans) {
    if (sp.kind === 'text') {
      const lines = sp.text.split('\n');
      lines.forEach((line, idx) => {
        if (idx > 0) children.push(new docx.TextRun({ break: 1 }));
        if (line !== '') {
          children.push(new docx.TextRun({ text: line, bold: sp.bold, italics: sp.italic, font: sp.code ? 'Consolas' : undefined }));
        }
      });
    } else if (sp.kind === 'link') {
      if (sp.href) {
        children.push(
          new docx.ExternalHyperlink({
            link: sp.href,
            children: [new docx.TextRun({ text: sp.text, style: 'Hyperlink' })],
          })
        );
      } else {
        children.push(new docx.TextRun({ text: sp.text }));
      }
    } else {
      // 图片在 DOCX 侧丢弃（data: URL 也丢：DOCX 需要的是真实字节，这里拿不到）
      children.push(new docx.TextRun({ text: sp.alt ? `[图片：${sp.alt}]` : '[图片]', italics: true }));
    }
  }
  return children;
}

function blockToParagraph(docx: DocxModule, b: OfficeBlock): import('docx').Paragraph | null {
  switch (b.kind) {
    case 'heading':
      return new docx.Paragraph({ heading: headingOf(docx, b.level), children: inlinesToRuns(docx, b.spans) });
    case 'paragraph':
      return new docx.Paragraph({ children: inlinesToRuns(docx, b.spans) });
    case 'listItem':
      if (b.ordered) {
        return new docx.Paragraph({
          indent: { left: 360 + b.level * 360 },
          children: [new docx.TextRun({ text: `${b.index}. ` }), ...inlinesToRuns(docx, b.spans)],
        });
      }
      return new docx.Paragraph({ bullet: { level: Math.min(8, b.level) }, children: inlinesToRuns(docx, b.spans) });
    case 'quote':
      return new docx.Paragraph({ indent: { left: 720 }, children: inlinesToRuns(docx, b.spans) });
    case 'code':
      return new docx.Paragraph({
        style: undefined,
        children: b.text.split('\n').flatMap((line, idx) => {
          const runs: import('docx').ParagraphChild[] = idx > 0 ? [new docx.TextRun({ break: 1 })] : [];
          runs.push(new docx.TextRun({ text: line, font: 'Consolas' }));
          return runs;
        }),
      });
    case 'hr':
      return new docx.Paragraph({ thematicBreak: true, children: [] });
    case 'table': {
      // 表格降级为文本行（保留单元格分隔，版式与表内样式丢失 —— 结果页说明）
      const rows = b.header.length ? [b.header, ...b.rows] : b.rows;
      return new docx.Paragraph({ children: rows.flatMap((r, idx) => {
        const runs: import('docx').ParagraphChild[] = idx > 0 ? [new docx.TextRun({ break: 1 })] : [];
        runs.push(new docx.TextRun({ text: r.join('  |  ') }));
        return runs;
      }) });
    }
  }
}

/** 块级模型 → DOCX 字节。空文档也保证至少一个空段落（Word 要求 body 非空）。 */
export async function buildDocxFromBlocks(blocks: OfficeBlock[], opts?: { title?: string; creator?: string }): Promise<Uint8Array<ArrayBuffer>> {
  const docx = await import('docx');
  const children = blocks
    .map((b) => blockToParagraph(docx, b))
    .filter((p): p is import('docx').Paragraph => p !== null);
  if (children.length === 0) children.push(new docx.Paragraph(''));
  const doc = new docx.Document({
    title: opts?.title,
    creator: opts?.creator,
    sections: [{ children }],
  });
  const buffer = await docx.Packer.toArrayBuffer(doc);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

export interface PageImage {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

/** 每页一张图 → DOCX（图片型，文字不可选）。用于 PDF → DOCX 的图片重建路线。 */
export async function buildDocxFromPageImages(images: PageImage[], opts?: { title?: string; maxDisplayWidthPx?: number }): Promise<Uint8Array<ArrayBuffer>> {
  const docx = await import('docx');
  const maxW = opts?.maxDisplayWidthPx ?? 624; // 约 6.5in @ 96dpi（A4 去边距）
  const children: import('docx').Paragraph[] = [];
  for (const img of images) {
    const type = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/gif' ? 'gif' : img.mime === 'image/bmp' ? 'bmp' : 'png';
    const ratio = img.width > 0 && img.height > 0 ? img.height / img.width : 1;
    const w = Math.min(maxW, img.width || maxW);
    const h = Math.round(w * ratio);
    children.push(
      new docx.Paragraph({
        alignment: 'center',
        children: [
          new docx.ImageRun({
            type,
            data: img.data,
            transformation: { width: w, height: h },
          }),
        ],
      })
    );
  }
  if (children.length === 0) children.push(new docx.Paragraph(''));
  const doc = new docx.Document({ title: opts?.title, sections: [{ children }] });
  const buffer = await docx.Packer.toArrayBuffer(doc);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // 复制一份并裁到实际长度：调用方可能给我们一个更大的 buffer 的子视图。
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
