// ─────────────────────────────────────────────────────────────────────────────
// md-editor/format-mode.ts —— 编辑器侧的格式词汇（**零依赖、纯函数**）
//
// 【这里没有解析器】真正的格式判定只来自后端公共契约
// `@/lib/reactive/format-observer`（worker + revision）与
// `@/lib/reactive/detect-format`（保存时的同步确认）。本文件只放：
//   · 一个**调度预筛**：没有 `<` / `{{` 的正文根本不可能是增强语法，跳过分析；
//   · 提交快照的形状与「能不能发布」的判据类型。
// 预筛只决定「要不要花时间分析」，**绝不参与分类** —— 有 `<` 的普通正文照样
// 交给解析器，解析器说了才算。
//
// 这个文件零 import：表单（客户端）与单测都能直接用它。
// ─────────────────────────────────────────────────────────────────────────────

import type { ContentFormat } from '../content-format';

/** 诊断在 UI 上真正要用到的字段（后端 FormatAnalysis / CM6 分析都满足）。 */
export interface EditorDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
  range: { start: number; end: number };
}

export interface EditorSubmitSnapshot {
  /** 与这次判定**同一份**的正文。表单必须用它提交，别再读一次编辑器。 */
  content: string;
  /** 服务端应写入的格式。 */
  format: ContentFormat;
  /** Reactive 时为权威当前版本；Markdown 为 null。 */
  syntaxVersion: string | null;
  /** 非 null = 不能按这个格式发布（无效增强语法 / 分析失败）。 */
  blocked: { message: string; diagnostics: EditorDiagnostic[] } | null;
}

/**
 * 调度预筛：增强语法**必然**包含 `<`（组件 / HTML 风格声明 / 版本指令）或 `{{`
 * （插值 / 表达式）。没有这两者就不用排一次编译。
 *
 * 宁可多分析（普通正文里有 `<`），不可漏判（漏了就等于把增强语法静默当 Markdown
 * 保存）—— 所以只做「肯定不含」的排除，不做任何肯定判断。
 */
export function mightContainReactiveSyntax(source: string): boolean {
  return source.includes('<') || source.includes('{{');
}

/** 空正文 / 纯文本的确定结论（不经过解析器也知道它只能是 Markdown）。 */
export const MARKDOWN_SUBMIT_SNAPSHOT: Omit<EditorSubmitSnapshot, 'content'> = {
  format: 'markdown',
  syntaxVersion: null,
  blocked: null,
};
