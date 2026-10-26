// ─────────────────────────────────────────────────────────────────────────────
// source-map.ts — 适配后源码与原文之间的 **UTF-16 半开区间**映射
//
// 【为什么需要】`[@…]` 适配器会把原文切成三段：
//   · 原文直接保留的区间（`origin: 'source'`，两边等长）；
//   · 每个引用 token 被换成生成内容（`origin: 'reference'`，一个 token → 一段
//     Markdown 图片或 `<site-embed … />` 块）；
//   · 作者伪造的 `<site-embed` 被改写成 `&lt;site-embed`（`origin: 'generated'`，
//     一个字符 → 四个字符）。
//
// 之后所有诊断（ReactiveMD 的 `local.*` 诊断、站点自己的校验错误）带的都是
// **适配后源码**里的偏移。要把它显示到编辑器里作者看的那份原文上，就必须有这张
// 映射 —— 否则诊断会落在错的字上，或者干脆落进生成的标签中间。没有映射时唯一
// 能做的「按长度等比缩放」在生成内容比 token 长二十倍时全是错的，而且不报错。
//
// 【半开区间】所有区间都是 `[start, end)`，单位是 UTF-16 code unit（与
// `String.prototype.slice` / 编辑器位置一致）。**绝不是字节偏移**。
//
// 【为什么整篇都要有 segment】映射不能只记「被替换的那几处」：调用方拿到的是任
// 意偏移（比如一个错误从原文保留区开始、延到生成区），只有连续覆盖整篇才能把
// 两个端点都定位住。适配器保证 segments 按 adaptedStart 递增且首尾相接。
//
// 本模块零依赖（只 import 类型），服务端与客户端都可直接用。
// ─────────────────────────────────────────────────────────────────────────────

import type { ReferenceKind } from './ref-types';

/** `[start, end)` UTF-16 区间。 */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * 一段适配后源码来自哪里：
 *   · `source`    —— 原文原样保留（含代码块：盖码只用于扫描，不改输出）；
 *   · `reference` —— 由某条 `[@…]` 引用生成（含 Markdown 图片与 site-embed 标签）；
 *   · `generated` —— 站点为安全而改写的文本（目前只有 `<site-embed` → `&lt;site-embed`）。
 */
export type SegmentOrigin = 'source' | 'reference' | 'generated';

/**
 * 适配后源码的一段。
 *
 * `sourceStart/sourceEnd` 与 `adaptedStart/adaptedEnd` 都满足半开区间；原文保留段
 * 两边等长，生成段则按「整段映射回它对应的原文区间」处理（诊断落在生成内容里
 * = 落在那个 token / 那个 `<` 上，而不是猜一个字符位置）。
 */
export interface AdaptedSourceSegment {
  origin: SegmentOrigin;
  sourceStart: number;
  sourceEnd: number;
  adaptedStart: number;
  adaptedEnd: number;
  /** 仅 reference 段：引用类别。 */
  kind?: ReferenceKind;
  /** 仅 reference 段：引用 id（site-embed 的 `ref` 属性）。 */
  ref?: string;
}

/** 诊断定位结果：映射回原文的区间 + 它来自哪一段。 */
export interface DiagnosticLocation extends TextRange {
  origin: SegmentOrigin;
  kind?: ReferenceKind;
  ref?: string;
}

function isValidRange(range: TextRange | null | undefined): range is TextRange {
  return (
    !!range &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start
  );
}

function adaptedTotal(segments: readonly AdaptedSourceSegment[]): number {
  return segments.length ? segments[segments.length - 1].adaptedEnd : 0;
}

function sourceTotal(segments: readonly AdaptedSourceSegment[]): number {
  return segments.length ? segments[segments.length - 1].sourceEnd : 0;
}

/**
 * 二分找到**包含**该位置的段（半开）。位置恰好等于某段终点时由调用方按
 * 「落在下一段起点」或「落在最后一段末尾」处理 —— 见 map*Point。
 */
function findAdaptedSegment(
  segments: readonly AdaptedSourceSegment[],
  position: number
): AdaptedSourceSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (position < seg.adaptedStart) hi = mid - 1;
    else if (position >= seg.adaptedEnd) lo = mid + 1;
    else return seg;
  }
  return null;
}

function findSourceSegment(
  segments: readonly AdaptedSourceSegment[],
  position: number
): AdaptedSourceSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (position < seg.sourceStart) hi = mid - 1;
    else if (position >= seg.sourceEnd) lo = mid + 1;
    else return seg;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把一个**适配后**位置映射回原文。`bias` 只对区间端点有意义：
 *   · 起点取第一格的映射位置；
 *   · 终点传入**最后一格**的位置，`'end'` 再 +1（半开区间 → 映射后仍是半开）。
 * 生成段（图片 / 标签 / `&lt;`）没有「第几格」的概念，起点与终点分别取它对应的
 * 原文区间两端 —— 于是「落在标签中间的一个诊断」会被定位成**整个 token**。
 */
function mapAdaptedPoint(seg: AdaptedSourceSegment, position: number, bias: 'start' | 'end'): number {
  if (seg.origin === 'source') {
    const mapped = seg.sourceStart + (position - seg.adaptedStart);
    return clamp(mapped + (bias === 'end' ? 1 : 0), seg.sourceStart, seg.sourceEnd);
  }
  return bias === 'start' ? seg.sourceStart : seg.sourceEnd;
}

function mapSourcePoint(seg: AdaptedSourceSegment, position: number, bias: 'start' | 'end'): number {
  if (seg.origin === 'source') {
    const mapped = seg.adaptedStart + (position - seg.sourceStart);
    return clamp(mapped + (bias === 'end' ? 1 : 0), seg.adaptedStart, seg.adaptedEnd);
  }
  return bias === 'start' ? seg.adaptedStart : seg.adaptedEnd;
}

/**
 * 适配后区间 → 原文区间。区间跨越多个段时，两个端点各自映射后取包络。
 *
 * 【端点用 `end - 1` 定位】**半开区间的终点本身不属于任何格子**：直接拿
 * `range.end` 去二分，会把它算进「紧挨着的下一段」（比如一个刚好在标签前面结束
 * 的范围，终点会被当成标签起点，然后因为标签是生成段而被映射成整个 token 的
 * 末尾）。改成定位最后一格再 +1，边界就自然落在原文的正确位置上。
 *
 * 越界（`end` 超出适配后源码、或负数 / 非整数）返回 `null`：调用方据此显示
 * 「无法定位」，不要猜一个位置。
 */
export function mapAdaptedRangeToSource(
  segments: readonly AdaptedSourceSegment[],
  range: TextRange
): TextRange | null {
  if (!isValidRange(range)) return null;
  if (!segments.length) return range.start === 0 && range.end === 0 ? { start: 0, end: 0 } : null;

  const total = adaptedTotal(segments);
  if (range.end > total) return null;
  // 原文末尾的零长度点（编辑器光标在 EOF）没有「包含它的段」，单独特判。
  if (range.start === range.end && range.start === total) {
    const end = sourceTotal(segments);
    return { start: end, end };
  }

  const startSeg = findAdaptedSegment(segments, range.start);
  if (!startSeg) return null;

  // 零长度区间：点诊断。生成段上按整段处理（见 mapAdaptedPoint 的说明）。
  if (range.start === range.end) {
    if (startSeg.origin === 'source') {
      const at = mapAdaptedPoint(startSeg, range.start, 'start');
      return { start: at, end: at };
    }
    return { start: startSeg.sourceStart, end: startSeg.sourceEnd };
  }

  // end > start ≥ 0，所以 end-1 一定落在某一段里（end ≤ total）。
  const endSeg = findAdaptedSegment(segments, range.end - 1);
  if (!endSeg) return null;

  const start = mapAdaptedPoint(startSeg, range.start, 'start');
  const end = mapAdaptedPoint(endSeg, range.end - 1, 'end');
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * 原文区间 → 适配后区间。用途：编辑器把「作者原文里的诊断」定位到预览里的位置。
 * 生成段被映射成它对应的整段生成内容；端点同 `mapAdaptedRangeToSource` 用
 * `end - 1` 定位，避免刚好落在生成 token 前的范围被扩大成整条引用。
 */
export function mapSourceRangeToAdapted(
  segments: readonly AdaptedSourceSegment[],
  range: TextRange
): TextRange | null {
  if (!isValidRange(range)) return null;
  if (!segments.length) return range.start === 0 && range.end === 0 ? { start: 0, end: 0 } : null;

  const total = sourceTotal(segments);
  if (range.end > total) return null;
  // 源码末尾的零长度点（光标在 EOF）—— 理由同 mapAdaptedRangeToSource。
  if (range.start === range.end && range.start === total) {
    const end = adaptedTotal(segments);
    return { start: end, end };
  }

  const startSeg = findSourceSegment(segments, range.start);
  if (!startSeg) return null;

  if (range.start === range.end) {
    if (startSeg.origin === 'source') {
      const at = mapSourcePoint(startSeg, range.start, 'start');
      return { start: at, end: at };
    }
    return { start: startSeg.adaptedStart, end: startSeg.adaptedEnd };
  }

  const endSeg = findSourceSegment(segments, range.end - 1);
  if (!endSeg) return null;

  const start = mapSourcePoint(startSeg, range.start, 'start');
  const end = mapSourcePoint(endSeg, range.end - 1, 'end');
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * 给**诊断**用的映射：在 `mapAdaptedRangeToSource` 的基础上带出「这段是谁生成
 * 的、对应哪条引用」。调用方据此把生成内容里的错误挂回原来的 `[@…]` token，
 * 或者把站点自身的 bug 与作者原文的错误区分开。
 */
export function locateDiagnosticRange(
  segments: readonly AdaptedSourceSegment[],
  range: TextRange
): DiagnosticLocation | null {
  const mapped = mapAdaptedRangeToSource(segments, range);
  if (!mapped) return null;
  if (!segments.length) return { ...mapped, origin: 'source' };

  const total = adaptedTotal(segments);
  const seg =
    range.start === total
      ? segments[segments.length - 1]
      : findAdaptedSegment(segments, range.start);
  if (!seg) return { ...mapped, origin: 'source' };

  const location: DiagnosticLocation = { ...mapped, origin: seg.origin };
  if (seg.kind) location.kind = seg.kind;
  if (seg.ref) location.ref = seg.ref;
  return location;
}
