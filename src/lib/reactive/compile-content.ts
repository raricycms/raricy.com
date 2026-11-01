// ─────────────────────────────────────────────────────────────────────────────
// compile-content.ts — 阅读 / 预览 / 发布共用的**容错编译**入口
//
// `compileReactiveSource` 只负责一次编译；本模块补上 Markdown 的降级策略：
//
//   · Reactive 源码编译失败 → 原样返回失败（新写入必须被拒绝，不能静默改写）；
//   · Markdown 源码编译失败 → 把 `{{ … }}` / 组件标签降成字面量再编译一次。
//     旧 Markdown 里出现这类文本不是错误，旧管线也按文字显示；整篇不可读才是
//     不可接受的回归。
//
// 只有 `changed` 时才重试，并把降级计数带回调用方（日志 / 测试）。重试后仍失败
// 就如实返回失败 —— 不拿一份没编译出来的正文冒充可读。
// ─────────────────────────────────────────────────────────────────────────────

import type { ContentFormat } from '../content-format';
import { compileReactiveSource, type ReactiveCompileInput, type ReactiveCompileOutcome } from './compile';
import { literalizeReactiveSyntax } from './detect-format';
import { SYNTAX_BUDGET_CODE } from './syntax-budget';

export interface CompileContentInput extends ReactiveCompileInput {
  format: ContentFormat;
}

export interface CompileContentResult {
  outcome: ReactiveCompileOutcome;
  /** 仅在 Markdown 容错降级发生时出现。 */
  literalized?: Record<string, number>;
}

export async function compileContent(input: CompileContentInput): Promise<CompileContentResult> {
  const first = await compileReactiveSource(input);
  if (first.result.ok || input.format !== 'markdown') return { outcome: first };
  // 超预算不是「历史 Markdown 外形」：字面化会把 `{{` 膨胀成实体并再编译一次，
  // 既救不回来也不该把资源继续烧下去。明确失败并保留原文。
  if (first.result.diagnostics.some((diagnostic) => diagnostic.code === SYNTAX_BUDGET_CODE)) {
    return { outcome: first };
  }

  const literal = literalizeReactiveSyntax(input.source);
  if (!literal.changed) return { outcome: first };

  const second = await compileReactiveSource({ ...input, source: literal.source });
  return { outcome: second, literalized: literal.counts };
}
