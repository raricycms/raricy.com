// ─────────────────────────────────────────────────────────────────────────────
// version-directive.ts — 源码前导区版本声明的**纯扫描**（零依赖、零 I/O）
//
// 为什么不能只用 `inspectLocalSourceVersion`：大文档超过节点预算时，上游会把
// `versionDeclaration` 置空（实测 6,000 段即可复现）。迁移与格式推导都需要在
// 大文档上知道「作者到底声明了哪个版本」。
//
// 规则与上游一致：BOM、空行、普通 HTML 注释（可跨行）可以排在声明之前；声明必须
// 独占一行；遇到第一条其它内容就停止。本模块只扫描文本，不解释正文。
// ─────────────────────────────────────────────────────────────────────────────

import type { SourceRange } from 'reactive-md';
import { maskMarkdownCode } from '../favorite-refs';

/** 当前版本指令的精确文本（由调用方传入当前 LOCAL_SYNTAX_VERSION 时构造）。 */
export function currentDeclaration(version: string): string {
  return `<!-- reactive-md: ${version} -->`;
}

export interface LeadingDeclaration {
  version: string;
  range: SourceRange;
}

/** 版本指令整行（允许任意空白）。 */
const DECLARATION_LINE = /^\s*<!--\s*reactive-md:\s*([A-Za-z0-9.-]+)\s*-->\s*$/;

/**
 * 找出正文前导区的版本指令。返回 `null` = 没有声明。
 */
export function findLeadingVersionDirective(source: string): LeadingDeclaration | null {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cursor = start;
  while (cursor < source.length) {
    let lineEnd = source.indexOf('\n', cursor);
    if (lineEnd === -1) lineEnd = source.length;
    const contentEnd = lineEnd > cursor && source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = source.slice(cursor, contentEnd);

    if (line.trim() === '') {
      if (lineEnd === source.length) return null;
      cursor = lineEnd + 1;
      continue;
    }

    const declaration = DECLARATION_LINE.exec(line);
    if (declaration) return { version: declaration[1], range: { start: cursor, end: contentEnd } };

    // 普通 HTML 注释：可能跨行。跨行时一直跳到 `-->` 之后，再继续看下一行。
    if (/^\s*<!--/.test(line)) {
      const closeInLine = line.indexOf('-->');
      if (closeInLine !== -1) {
        if (lineEnd === source.length) return null;
        cursor = lineEnd + 1;
        continue;
      }
      const blockEnd = source.indexOf('-->', cursor + line.indexOf('<!--') + 4);
      if (blockEnd === -1) return null;
      const after = blockEnd + 3;
      if (after >= source.length) return null;
      const nextNewline = source.indexOf('\n', after);
      cursor = nextNewline === -1 ? source.length : nextNewline + 1;
      if (cursor >= source.length) return null;
      continue;
    }

    return null;
  }
  return null;
}


/** 把 `[start, end)` 盖成空格（保留 CR/LF，保持长度与偏移不变）。 */
function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    if (chars[i] !== '\r' && chars[i] !== '\n') chars[i] = ' ';
  }
}

/**
 * 盖住所有「作者在正文里展示的版本指令示例」：围栏 / 行内代码（`maskMarkdownCode`）、
 * 缩进代码块（含引用块内）、以及 `<pre>` 内容。
 *
 * 只盖示例，不改判定：一条真的残留声明必须独占一行、不在代码里。漏掉缩进代码 /
 * `<pre>` 的症状是「当前版本行里贴了一段升级示例 → 整批迁移被 `stale-declaration`
 * 阻塞」，属于 fail-closed 的误伤。
 */
function maskVersionExamples(source: string): string {
  const chars = maskMarkdownCode(source).split('');

  for (const match of source.matchAll(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi)) {
    const start = match.index ?? 0;
    maskRange(chars, start, start + match[0].length);
  }

  // 缩进代码块：行首 4 空格 / Tab。引用块里的缩进代码先剥掉 `>` 前缀再判 ——
  // `> 示例：\n>\n>     <!-- reactive-md: ... -->` 在 CommonMark 里是代码。
  let offset = 0;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    let contentStart = 0;
    let rest = line;
    for (;;) {
      const quote = /^ {0,3}> ?/.exec(rest);
      if (!quote) break;
      contentStart += quote[0].length;
      rest = rest.slice(quote[0].length);
    }
    if (/^(?: {4}|\t)/.test(rest)) {
      maskRange(chars, offset + contentStart, offset + line.length);
    }
    offset += rawLine.length + 1;
  }

  return chars.join('');
}

/**
 * 找出**正文任意位置**的版本指令（代码 / 示例之外）。
 *
 * 前导声明由 `findLeadingVersionDirective` 负责；这里是迁移兜底：一行标成当前
 * 版本、正文深处却残留旧声明时，一次性标记不能让阅读页编译失败。
 */
export function findVersionDirectives(source: string): LeadingDeclaration[] {
  const masked = maskVersionExamples(source);
  const re = /<!--\s*reactive-md:\s*([A-Za-z0-9.-]+)\s*-->/g;
  const found: LeadingDeclaration[] = [];
  for (const match of masked.matchAll(re)) {
    const start = match.index ?? 0;
    if (masked[start] !== '<') continue; // 被盖码
    found.push({
      version: match[1],
      range: { start, end: start + match[0].length },
    });
  }
  return found;
}
