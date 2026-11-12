import { compileSource } from './compile-source';
import {
  analyzeLocalSource,
  LOCAL_SYNTAX_VERSION,
  type AuthorAnalysis,
  type Diagnostic,
  type LocalCompileOptions,
  type LocalCompileResult,
} from 'reactive-md';
import { LOCAL_COMPONENT_NAMES } from 'reactive-md/authoring';
import { REACTIVE_COMPILE_OPTIONS } from './host-components';

const componentNames = new Set<string>(LOCAL_COMPONENT_NAMES);

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
}

function collectEvidence(source: string, result: LocalCompileResult, analysis?: AuthorAnalysis): string[] {
  const evidence = new Set<string>();
  if (result.ok) {
    const { document } = result;
    for (const [kind, entries] of Object.entries({
      bindings: document.bindings,
      computation: document.computations,
      external: document.externals,
      validation: document.validations,
    })) {
      if (entries && Object.keys(entries).length) evidence.add(kind);
    }
    if (document.themeRange) evidence.add('theme');
    if (document.versionDeclaration) evidence.add('version');
    const nodes = [...document.nodes];
    while (nodes.length) {
      const node = nodes.pop()!;
      if (node.type === 'component' && node.name) evidence.add('component:' + node.name);
      if (node.type === 'interpolation') evidence.add('interpolation');
      if (node.children) nodes.push(...node.children);
    }
  } else {
    for (const token of analysis?.tokens ?? []) {
      if (token.kind === 'expression') evidence.add('interpolation');
      if (token.kind === 'tag') addTag(source.slice(token.range.start, token.range.end));
    }
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.code.startsWith('local.interpolation') || diagnostic.code.startsWith('local.expression')) {
        evidence.add('interpolation');
      }
      if (diagnostic.code === 'local.budget') evidence.add('syntax-budget');
      const name = diagnostic.params?.name;
      if (typeof name === 'string') addTag(name);
    }
  }

  function addTag(name: string) {
    if (componentNames.has(name)) evidence.add('component:' + name);
  }
  for (const { code, causeRange } of result.recoveries ?? []) {
    if (!code.startsWith('local.recovery.')) continue;
    const tag = /^<\/?([a-z][a-z0-9-]*)/.exec(source.slice(causeRange.start, causeRange.end));
    if (tag) addTag(tag[1]);
  }
  return [...evidence];
}

export function classifyReactiveSyntax(source: string, result: LocalCompileResult, analysis?: AuthorAnalysis):
  Omit<ReactiveSyntaxDetection, 'syntaxVersion'> {
  const evidence = collectEvidence(source, result, analysis);
  const declaredVersion = result.ok ? result.document.versionDeclaration?.version ?? null : null;
  const reactive = evidence.length > 0;
  return {
    format: reactive ? 'reactive' : 'markdown',
    reactive,
    valid: result.ok,
    publishable: result.ok,
    evidence,
    diagnostics: result.diagnostics,
    codes: [...new Set(result.diagnostics.map(({ code }) => code))],
    declaredVersion,
  };
}

export function finalizeReactiveDetection(detection: Omit<ReactiveSyntaxDetection, 'syntaxVersion'>): ReactiveSyntaxDetection {
  return { ...detection, syntaxVersion: detection.format === 'reactive' ? LOCAL_SYNTAX_VERSION : null };
}

export function detectReactiveSyntax(source: string, options: LocalCompileOptions = REACTIVE_COMPILE_OPTIONS): ReactiveSyntaxDetection {
  const result = compileSource(source, options);
  const analysis = result.ok || result.diagnostics.some(({ code }) => code === 'local.budget')
    ? undefined
    : analyzeLocalSource(source, options, { diagnostics: false });
  return finalizeReactiveDetection(classifyReactiveSyntax(source, result, analysis));
}
