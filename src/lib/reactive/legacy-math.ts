// ─────────────────────────────────────────────────────────────────────────────
// legacy-math.ts — Markdown 反斜线数学定界符的观测（纯函数）
//
// 上游 0.6.0 已支持 `\(…\)` / `\[…\]`；保留原文扫描作为灰度日志的观测字段，
// 不再据此选择旧渲染器。公式降级由编译诊断决定。
//
// 【排除代码】扫描跑在 `maskMarkdownCode` 的盖码副本上：代码块 / 行内代码里的
// 同形文本是**示例**，不是公式；排除它们可以避免污染灰度观测。
//
// 【成对才算】孤立的一个 `\(` / `\[` 不构成数学；只有成对出现才改变可见内容。
// 被转义的反斜线（`\\(` = 字面量反斜线 + 左括号）也不算：`isEscapedBackslash`
// 数前面连续的反斜线，奇数个表示这个反斜线本身被转义。
//
// 【只用于 markdown 候选】reactive 正文不参与这项观测。
//
// 本模块零 prisma / 零 DOM，服务端阅读决策与单测共用一份。
// ─────────────────────────────────────────────────────────────────────────────

import { maskMarkdownCode } from '@/lib/favorite-refs';

/** `\(…\)`（行内）与 `\[…\]`（块级）两套定界符。 */
const DELIMITER_PAIRS = [
  ['\\(', '\\)'],
  ['\\[', '\\]'],
] as const;

/** 下标处的反斜线是否**被自身转义**（前面有奇数个连续反斜线）。 */
function isEscapedBackslash(source: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}

/** 在盖码副本里找一对未被转义的定界符；找到即停。 */
function hasDelimitedPair(source: string, open: string, close: string): boolean {
  let from = 0;
  while (from < source.length) {
    const openAt = source.indexOf(open, from);
    if (openAt < 0) return false;
    if (!isEscapedBackslash(source, openAt)) {
      let closeFrom = openAt + open.length;
      while (closeFrom < source.length) {
        const closeAt = source.indexOf(close, closeFrom);
        if (closeAt < 0) break;
        if (!isEscapedBackslash(source, closeAt)) return true;
        closeFrom = closeAt + close.length;
      }
      // 最早的有效起点之后已经没有有效终点，后续起点也不可能配对。
      return false;
    }
    from = openAt + open.length;
  }
  return false;
}

/**
 * 原文（排除围栏 / 行内代码）里是否有成对的 `\(…\)` / `\[…\]`。
 *
 * 有 = 记录这篇 Markdown 使用了反斜线定界符；不代表编译不兼容。
 */
export function hasLegacyMathDelimiters(source: string): boolean {
  if (!source) return false;
  const masked = maskMarkdownCode(source);
  return DELIMITER_PAIRS.some(([open, close]) => hasDelimitedPair(masked, open, close));
}
