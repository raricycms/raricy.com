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
