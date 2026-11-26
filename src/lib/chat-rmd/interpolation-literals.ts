// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/interpolation-literals.ts — 让聊天把 `{{ … }}` 当普通文本编译
//
// 聊天不执行表达式，但 reactive-md 的语义阶段会把未声明标识符当错误，并把包含
// 它的表格 / 段落整块降级成 fallback 源码。为了让降级停在表达式本身，编译前把
// 表达式范围内的 ASCII 字符一对一换成私有区字符，解析器便不会识别成插值；
// 编译成功后再换回原文。替换等长，节点 range 仍指向原始源码。
//
// 恢复必须在 `applyChatDocumentPolicy` 之前：属性值里的 `{{` 仍要触发组件拒绝。
// 只改编译输入；恢复后 `document.source` 直接取原始源码。
// ─────────────────────────────────────────────────────────────────────────────

import {
  analyzeLocalSource,
  type LocalCompileOptions,
  type LocalDocument,
  type LocalNode,
} from 'reactive-md';

/** U+E100–U+E17F 对应 ASCII 0x00–0x7F；一个字符换一个字符。 */
const MASK_BASE = 0xe100;
const MASK_LAST = MASK_BASE + 0x7f;

export interface MaskedChatSource {
  source: string;
  /** 只有真正发生替换时才允许调用恢复，避免把正文里天然的同段私用区字符解码。 */
  masked: boolean;
}

function maskAscii(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    output += code <= 0x7f ? String.fromCharCode(MASK_BASE + code) : value[index];
  }
  return output;
}

function decodeAscii(value: string): string {
  let output = '';
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= MASK_BASE && code <= MASK_LAST) {
      output += String.fromCharCode(code - MASK_BASE);
      changed = true;
    } else {
      output += value[index];
    }
  }
  return changed ? output : value;
}

interface SourceRange {
  start: number;
  end: number;
}

function readMaskRanges(source: string, options: LocalCompileOptions): SourceRange[] {
  let tokens;
  try {
    tokens = analyzeLocalSource(source, options, { diagnostics: false }).tokens;
  } catch {
    return [];
  }

  const ranges: SourceRange[] = [];
  for (const token of tokens) {
    // `expression` 覆盖正文 / 表格里的完整 `{{ … }}`；属性值里的插值只出现在
    // `string` token 中，也一并按字面文本处理，避免整个组件标签回退源码。
    if (token.kind !== 'expression' && token.kind !== 'string') continue;
    const { start, end } = token.range;
    if (start < 0 || end <= start || end > source.length) continue;
    if (token.kind === 'string' && !source.slice(start, end).includes('{{')) continue;
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * 编译聊天源码前调用：把 `{{ … }}` 与含插值的属性字符串换成等长私用区文本。
 * 没有表达式时不扫描、不改写，保持普通消息的编译开销不变。
 */
export function maskChatExpressionLiterals(
  source: string,
  options: LocalCompileOptions
): MaskedChatSource {
  if (!source.includes('{{')) return { source, masked: false };

  const ranges = readMaskRanges(source, options);
  if (ranges.length === 0) return { source, masked: false };

  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += source.slice(cursor, range.start);
    output += maskAscii(source.slice(range.start, range.end));
    cursor = range.end;
  }
  output += source.slice(cursor);

  return { source: output, masked: output !== source };
}

function restoreNode(node: LocalNode): void {
  if (typeof node.value === 'string') node.value = decodeAscii(node.value);
  if (typeof node.url === 'string') node.url = decodeAscii(node.url);
  if (typeof node.title === 'string') node.title = decodeAscii(node.title);
  if (typeof node.alt === 'string') node.alt = decodeAscii(node.alt);
  if (typeof node.label === 'string') node.label = decodeAscii(node.label);
  if (typeof node.identifier === 'string') node.identifier = decodeAscii(node.identifier);
  if (node.attrs) {
    for (const key of Object.keys(node.attrs)) {
      node.attrs[key] = decodeAscii(node.attrs[key]);
    }
  }
  if (node.children) {
    for (const child of node.children) restoreNode(child);
  }
}

/**
 * 编译成功后、套用文档策略前恢复字面文本；`originalSource` 与掩码源码等长，
 * 直接作为 `document.source`，保证后续源码切片仍落在原文上。
 */
export function restoreChatExpressionLiterals(
  document: LocalDocument,
  originalSource: string
): void {
  document.source = originalSource;
  for (const node of document.nodes) restoreNode(node);
}