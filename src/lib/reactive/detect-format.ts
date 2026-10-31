// ─────────────────────────────────────────────────────────────────────────────
// detect-format.ts — 由**解析器事实**推导 effective format（零 I/O）
//
// 作者界面不再提供 Markdown / ReactiveMD 选择。真值来自编译 / 作者分析结果，
// 而不是对 `{{` 或 `<tag>` 做全文正则：
//   · 代码 / 数学 / 转义里的示例不会激活；
//   · 普通 HTML（`<div>`、`<table>`）不算增强语法；
//   · 合法组件即使没有 `bind`（例如纯展示的 `<panel>`）也算；
//   · 插值（`{{ … }}`）、声明（theme / computed / const / external / validation）
//     与绑定都算。
//
// 【失败不猜，但也不否认增强身份】编译失败时分两种情况：
//   · authoring 分析在屏蔽区外认出了组件 / 插值 → `format` 仍是 reactive、
//     `valid: false`、`publishable: false`。编辑器必须保留增强身份、展示可定位
//     诊断、阻止发布并保留草稿；**不能**当成 Markdown 字面化把错误吞掉。
//   · 没有任何增强语法证据（普通历史 Markdown 的 HTML / 未配对 `{{`）→ format
//     markdown；再走 `literalizeReactiveSyntax` 复核可发布性。
//
// 【性能】同步 `detectReactiveSyntax` 只适合服务端 / 低频调用。编辑器逐键推导
// 请用 `format-observer.ts`：它把编译放进 worker，并用
// `classifyReactiveSyntax` 从 worker 结果直接推导，不在 UI 线程跑全量 compile。
//
// 本模块会 import `reactive-md` 编译核心；纯零依赖词汇表见 content-format.ts。
// ─────────────────────────────────────────────────────────────────────────────

import {
  analyzeLocalSource,
  compileLocal,
  LOCAL_SYNTAX_VERSION,
  type AuthorAnalysis,
  type Diagnostic,
  type LocalCompileOptions,
  type LocalCompileResult,
  type LocalDocument,
  type LocalNode,
} from 'reactive-md';
import { SITE_REACTIVE_COMPONENT_NAMES } from './component-names';
import { shouldRejectReactive } from './diagnostics';
import { applyLegacyHtmlCompat, maskProtectedContent } from './legacy-compat';
import { reactiveCompileOptions } from './host-components';
import { findLeadingVersionDirective } from './version-directive';

/** 当前语法版本的权威导出（草稿 / 写 API 契约用；来自上游 LOCAL_SYNTAX_VERSION）。 */
export { LOCAL_SYNTAX_VERSION as REACTIVE_SYNTAX_VERSION };

export type ContentFormatName = 'markdown' | 'reactive';

export interface ReactiveSyntaxDetection {
  /** 写入时应使用的格式。 */
  format: ContentFormatName;
  /** 是否包含有效增强语法（= format === 'reactive' 且 compile ok）。 */
  reactive: boolean;
  /** 编译是否成功（与「有没有增强语法」是两件事）。 */
  valid: boolean;
  /** 当前内容能否发布（服务端的写入闸门使用同一判据）。 */
  publishable: boolean;
  /** 解析器/authoring 给出的证据字段（日志、测试用，不含正文）。 */
  evidence: string[];
  /** 可定位诊断（code / range / line / column），供编辑器展示与跳转。 */
  diagnostics: Diagnostic[];
  codes: string[];
  /** 源码前导区声明的版本；没有声明为 null。 */
  declaredVersion: string | null;
  /** 写回正文行 / 草稿的 syntax_version：Reactive = 当前版本，Markdown = null。 */
  syntaxVersion: string | null;
  /** Markdown 历史异常经字面量降级后可发布（不代表这是增强文档）。 */
  literalized?: boolean;
}

const COMPONENT_NAMES: ReadonlySet<string> = new Set(SITE_REACTIVE_COMPONENT_NAMES);

function walk(nodes: readonly LocalNode[], onNode: (node: LocalNode) => void): void {
  for (const node of nodes) {
    onNode(node);
    if (node.children) walk(node.children, onNode);
  }
}

export function documentEvidence(document: LocalDocument): string[] {
  const evidence = new Set<string>();
  if (Object.keys(document.bindings).length > 0) evidence.add('bindings');
  if (document.computations && Object.keys(document.computations).length > 0) {
    evidence.add('computation');
  }
  if (document.validations && document.validations.length > 0) evidence.add('validation');
  if (document.externals && Object.keys(document.externals).length > 0) evidence.add('external');
  if (document.themeRange) evidence.add('theme');
  if (document.versionDeclaration) evidence.add('version');
  walk(document.nodes, (node) => {
    if (node.type === 'component') {
      evidence.add(node.name ? `component:${node.name}` : 'component');
    } else if (node.type === 'interpolation') {
      evidence.add('interpolation');
    }
  });
  return [...evidence];
}

/**
 * 编译失败时从 authoring token 找证据。
 *
 * 只认**全小写**的组件名：`<TAB>` 是历史 HTML（兼容层会解包），不是组件。
 * `token.kind === 'expression'` 是屏蔽区之外的 `{{ … }}`；代码 / 数学不会产生它。
 */
function analysisEvidence(source: string, analysis: AuthorAnalysis | undefined): string[] {
  if (!analysis) return [];
  const evidence = new Set<string>();
  for (const token of analysis.tokens) {
    if (token.kind === 'expression') {
      evidence.add('interpolation');
      continue;
    }
    if (token.kind !== 'tag') continue;
    const raw = source.slice(token.range.start, token.range.end);
    if (raw !== raw.toLowerCase()) continue;
    const name = raw.toLowerCase();
    if (COMPONENT_NAMES.has(name)) evidence.add(`component:${name}`);
  }
  return [...evidence];
}

function declaredVersion(source: string): string | null {
  const declaration = findLeadingVersionDirective(source);
  return declaration?.version ?? null;
}

/**
 * 纯分类：从一次已有的编译结果（最好附带 authoring analysis）推导格式。
 *
 * 这是 worker 路径的入口 —— 调用方**不要**为了格式再跑一次 compile。
 */
export function classifyReactiveSyntax(
  source: string,
  result: LocalCompileResult,
  analysis?: AuthorAnalysis
): Omit<ReactiveSyntaxDetection, 'syntaxVersion'> {
  const declaration = declaredVersion(source);
  if (result.ok) {
    const evidence = documentEvidence(result.document);
    const format: ContentFormatName = evidence.length > 0 ? 'reactive' : 'markdown';
    const publishable =
      format === 'reactive' ? !shouldRejectReactive(result) : !shouldRejectReactive(result);
    return {
      format,
      reactive: format === 'reactive',
      valid: true,
      publishable,
      evidence,
      diagnostics: result.diagnostics,
      codes: [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))],
      declaredVersion: declaration,
    };
  }
  const evidence = analysisEvidence(source, analysis);
  const format: ContentFormatName = evidence.length > 0 ? 'reactive' : 'markdown';
  return {
    format,
    reactive: format === 'reactive',
    valid: false,
    publishable: false,
    evidence,
    diagnostics: result.diagnostics,
    codes: [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))],
    declaredVersion: declaration,
  };
}

export function finalizeReactiveDetection(
  detection: Omit<ReactiveSyntaxDetection, 'syntaxVersion'>,
  literalized?: boolean
): ReactiveSyntaxDetection {
  return {
    ...detection,
    // Reactive 一律写当前编译器版本（旧声明会在发布闸门被拒绝）；Markdown 为 null。
    syntaxVersion: detection.format === 'reactive' ? LOCAL_SYNTAX_VERSION : null,
    ...(literalized ? { literalized: true } : {}),
  };
}

/**
 * 同步检测（服务端 / 低频调用）。
 *
 * ⚠️ 不要在每个按键上调用：它会在当前线程完整编译一次。编辑器请用
 * `createReactiveFormatObserver`（worker + revision 对应）。
 */
export function detectReactiveSyntax(
  source: string,
  options: LocalCompileOptions = reactiveCompileOptions('markdown')
): ReactiveSyntaxDetection {
  // 历史 HTML 先过兼容层，避免把「旧标签」误判成编译失败。等长改写，诊断位置不变。
  const compat = applyLegacyHtmlCompat(source);
  const result = compileLocal(compat.source, options);
  const analysis = result.ok
    ? undefined
    : analyzeLocalSource(compat.source, options, { diagnostics: false });

  const detection = classifyReactiveSyntax(source, result, analysis);
  if (result.ok || detection.format === 'reactive') {
    return finalizeReactiveDetection(detection);
  }

  // 普通 Markdown 的历史异常：把 Reactive 外形降为字面量后仍能编译，就允许保存。
  const literal = literalizeReactiveSyntax(source);
  if (!literal.changed) return finalizeReactiveDetection(detection);
  const fallback = compileLocal(applyLegacyHtmlCompat(literal.source).source, options);
  return finalizeReactiveDetection(
    {
      ...detection,
      publishable: fallback.ok && !shouldRejectReactive(fallback),
      valid: false,
    },
    true
  );
}

// ── 把无法编译的 Markdown 里的 Reactive 语法降为字面量 ──────────────────────

/**
 * 旧 Markdown 里可能出现 `{{ … }}` 或半截组件标签（不是代码块里的示例）。
 * ReactiveMD 会把它当增强语法，编译失败后整篇不可读；旧管线则原样显示。
 *
 * 这里在**确认没有增强身份**的 Markdown 容错路径调用：把 `{{` 与组件标签的 `<`
 * 转成 HTML 实体。代码 / 数学 / `<pre>` / `<code>` / 缩进代码不动。
 *
 * 编译失败但 authoring 已识别出组件 / 插值的正文**不要**走这里 —— 那会把作者
 * 写错的结构静默变成普通文字。
 */
export function literalizeReactiveSyntax(source: string): {
  source: string;
  changed: boolean;
  counts: Record<string, number>;
} {
  const masked = maskProtectedContent(source);
  const counts: Record<string, number> = {};
  const edits: { start: number; end: number; text: string }[] = [];

  for (const match of masked.matchAll(/\{\{/g)) {
    const start = match.index ?? 0;
    edits.push({ start, end: start + 2, text: '&#123;&#123;' });
    counts.interpolation = (counts.interpolation ?? 0) + 1;
  }

  const tag = /<\/?\s*([A-Za-z][A-Za-z0-9-]*)/g;
  for (const match of masked.matchAll(tag)) {
    const name = match[1].toLowerCase();
    if (!COMPONENT_NAMES.has(name) && name !== 'site-embed') continue;
    const start = match.index ?? 0;
    edits.push({ start, end: start + 1, text: '&lt;' });
    counts.tag = (counts.tag ?? 0) + 1;
  }

  if (edits.length === 0) return { source, changed: false, counts };

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  return { source: out, changed: out !== source, counts };
}
