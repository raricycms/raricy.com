// ─────────────────────────────────────────────────────────────────────────────
// syntax-budget.ts —— 编译前的**语法复杂度闸门**（等长扫描，零编译）
//
// 兼容层本身已经线性，但上游 `compileLocal` 对「大量未闭合的 `<` / `{{`」仍是
// 超线性的：隔离实测 25 万个 `<` 约 30.7s、5 万个未闭合 `{{` 约 19.9s。编译是
// 同步的，落在一个 core+ 的写入 / 阅读请求上会把单进程整站一起排队。
//
// 这里在**编译前**数一遍「屏蔽区之外」的未闭合标签 / 插值的**峰值嵌套深度**：
//   · 代码 / 数学 / `<pre><code>` / 缩进代码由 `maskProtectedContent` 盖成 x；
//   · 成对标签（`<div>…</div>`）的 `<` 与 `>` 会互相抵消，正常长文不受影响；
//   · **按峰值而不是净差**：`'<'.repeat(N) + '>'.repeat(N)` 的净差是 0，但编译时
//     先要扫过连续 N 个 `<` 起点 —— 那正是上游超线性的输入（R3-100）。所以只要
//     任何时刻「未闭合起点」的累计数超过预算就拒绝，不会被后面的 `>` 补回来。
//   · 超过预算返回一条 `site.syntax-budget` 诊断 —— 调用方必须**明确拒绝**
//     （保留原文，不截断、不字面化后当成功）。
//
// 阈值是**交互/请求预算**，不是内容合法性：512 个未闭合 `<` 或 128 个未闭合
// `{{` 已经远超任何正常正文；成对的长 HTML / 代码示例不受影响。
// ─────────────────────────────────────────────────────────────────────────────

import type { Diagnostic } from 'reactive-md';
import { maskProtectedContent } from './legacy-compat';

export const SYNTAX_BUDGET_CODE = 'site.syntax-budget';
export const MAX_UNCLOSED_TAGS = 512;
export const MAX_UNCLOSED_INTERPOLATIONS = 128;

export interface SyntaxBudgetResult {
  diagnostic: Diagnostic;
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lastNewline = index;
    }
  }
  return { line, column: end - lastNewline };
}

function budgetDiagnostic(
  source: string,
  start: number,
  message: string
): SyntaxBudgetResult {
  const { line, column } = lineColumnAt(source, start);
  return {
    diagnostic: {
      code: SYNTAX_BUDGET_CODE,
      message,
      severity: 'error',
      range: { start: Math.max(0, start), end: Math.max(0, start) },
      line,
      column,
    },
  };
}

/**
 * 检查源码是否超过编译预算。
 *
 * 返回 `null` = 可以编译；否则调用方**不得**调用 `compileLocal`。
 */
export function checkSyntaxBudget(source: string): SyntaxBudgetResult | null {
  const masked = maskProtectedContent(source);

  // 标签：跟踪「未闭合起点」的**峰值深度**，而不是最终净差 —— 净差会被后面的
  // `>` 补回 0（`'<'.repeat(N) + '>'.repeat(N)`），而上游的扫描代价发生在峰值那一段。
  let tagDepth = 0;
  let peakTagDepth = 0;
  let firstTag = -1;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '<') {
      tagDepth += 1;
      if (tagDepth > peakTagDepth) {
        peakTagDepth = tagDepth;
        if (firstTag < 0) firstTag = index;
      }
    } else if (char === '>' && tagDepth > 0) {
      tagDepth -= 1;
    }
  }
  if (peakTagDepth > MAX_UNCLOSED_TAGS) {
    return budgetDiagnostic(
      source,
      firstTag,
      `正文的未闭合标签起点峰值达到 ${peakTagDepth}，超过编译预算（${MAX_UNCLOSED_TAGS}）；已保留原文并拒绝本次编译。`
    );
  }

  // 插值同一口径：峰值嵌套而不是净差（`'{{'.repeat(N) + '}}'.repeat(N)` 净差为 0）。
  let interpolationDepth = 0;
  let peakInterpolationDepth = 0;
  let firstInterpolation = -1;
  for (let index = 0; index + 1 < masked.length; index += 1) {
    if (masked[index] === '{' && masked[index + 1] === '{') {
      interpolationDepth += 1;
      if (interpolationDepth > peakInterpolationDepth) {
        peakInterpolationDepth = interpolationDepth;
        if (firstInterpolation < 0) firstInterpolation = index;
      }
      index += 1;
    } else if (masked[index] === '}' && masked[index + 1] === '}') {
      if (interpolationDepth > 0) interpolationDepth -= 1;
      index += 1;
    }
  }
  if (peakInterpolationDepth > MAX_UNCLOSED_INTERPOLATIONS) {
    return budgetDiagnostic(
      source,
      firstInterpolation,
      `正文的未闭合插值起点峰值达到 ${peakInterpolationDepth}，超过编译预算（${MAX_UNCLOSED_INTERPOLATIONS}）；已保留原文并拒绝本次编译。`
    );
  }

  return null;
}
