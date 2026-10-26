// ─────────────────────────────────────────────────────────────────────────────
// md-editor/reactive-authoring.ts —— ReactiveMD 作者工具的 CM6 适配层
//
// 【职责】把上游 `reactive-md/authoring` 的**纯函数**接到 CodeMirror 6 上：
//   · 防抖分析原文 → 装饰器着色 + 诊断下划线（外加交给宿主的面板数据）；
//   · Ctrl/Cmd+Space 触发补全（列表由宿主渲染，本模块只管取数与落地）；
//   · 原生组件模板、格式化、诊断定位。
//
// 【为什么用上游公开入口】分析 / 补全 / 格式化的词法、schema 与编译预算都必须
// 和预览/阅读页**同一份**。自己再解析一遍，两边对「什么算 reactive 语法」迟早
// 会分叉，而且分叉时不报错。编译选项统一走 `reactiveCompileOptions('reactive')`，
// 宿主组件 schema 与节点预算因此与预览一致。
//
// 【几条静默错】
//   · 分析是**防抖**的：每次改动都把上一份待执行的计时器清掉。不清的话，旧文档的
//     诊断会在新文档上闪一下，甚至覆盖新结果；
//   · 卸载后计时器必须停：否则回调会打到已经不在的 React 树上；
//   · 光标移动**不**重新分析（只有 `docChanged` 才排），否则每一帧都跑一遍解析；
//   · 所有改动都走一次 `dispatch`（一个事务 = 一步撤销），绝不重建 EditorState
//     —— 重建会丢撤销历史与选区；
//   · 上游 token / 诊断的 range 是原文 UTF-16 偏移，进装饰器前按当前文档长度夹紧；
//     range 越界会让 EditorView 抛错，而错误发生在下一次渲染。
//
// 【类名契约】token 用 `cm-reactive-<kind>`，诊断用
// `cm-reactive-diagnostic--error` / `--warning`。CSS 由 UI 侧提供，本模块只负责
// 加类名与 `title`（诊断 message）。
// ─────────────────────────────────────────────────────────────────────────────

import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  analyzeLocalSource,
  completeLocalSource,
  formatLocalSource,
  getNativeComponentCatalog,
  insertTemplate,
  renderNativeSnippet,
} from 'reactive-md/authoring';
import type { AuthorAnalysis, AuthorCompletion, Diagnostic } from 'reactive-md/authoring';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';

export type { AuthorAnalysis, AuthorCompletion } from 'reactive-md/authoring';

/** 与预览 / 阅读页完全一致的宿主 schema、节点预算与语法开关。 */
const COMPILE_OPTIONS = reactiveCompileOptions('reactive');

/** 停手一小会儿再分析：比逐键解析省得多，又赶得上视觉上的「即时」。 */
const ANALYSIS_DEBOUNCE_MS = 250;

/** 模板列表固定用中文目录（契约见文件头）。 */
const ZH_CATALOG = getNativeComponentCatalog('zh');

const EMPTY_ANALYSIS: AuthorAnalysis = { tokens: [], bindings: [], diagnostics: [] };

/** 上游 token kind → 站内固定类名（未列出的 kind 不着色）。 */
const TOKEN_CLASSES: Readonly<Record<string, string>> = {
  tag: 'cm-reactive-tag',
  attribute: 'cm-reactive-attribute',
  string: 'cm-reactive-string',
  expression: 'cm-reactive-expression',
  binding: 'cm-reactive-binding',
  comment: 'cm-reactive-comment',
  math: 'cm-reactive-math',
  code: 'cm-reactive-code',
};

interface SourceSpan {
  start: number;
  end: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 按文档长度夹紧并纠正反向区间（上游保证有序，这里只是防御）。 */
function clampSpan(span: SourceSpan, length: number): { from: number; to: number } {
  const a = clamp(span.start, 0, length);
  const b = clamp(span.end, 0, length);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/* -------------------------------------------------------------------------- */
/* 装饰                                                                        */
/* -------------------------------------------------------------------------- */

const setAnalysis = StateEffect.define<AuthorAnalysis>();

function buildDecorations(length: number, analysis: AuthorAnalysis): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (const token of analysis.tokens) {
    const className = TOKEN_CLASSES[token.kind];
    if (!className) continue;
    const { from, to } = clampSpan(token.range, length);
    if (to > from) marks.push(Decoration.mark({ class: className }).range(from, to));
  }
  for (const diagnostic of analysis.diagnostics) {
    const { from, to } = clampSpan(diagnostic.range, length);
    if (to <= from) continue;
    marks.push(
      Decoration.mark({
        class: `cm-reactive-diagnostic--${diagnostic.severity}`,
        attributes: { title: diagnostic.message },
      }).range(from, to)
    );
  }
  return Decoration.set(marks, true);
}

/**
 * 分析结果住 StateField，文档一变就立刻清空 —— 旧偏移的装饰不能继续贴在新文字上
 * （它们在防抖窗口里看起来「还挺对」，但已经指错了地方）。
 */
const analysisDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAnalysis)) return buildDecorations(tr.state.doc.length, effect.value);
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* -------------------------------------------------------------------------- */
/* 防抖分析                                                                    */
/* -------------------------------------------------------------------------- */

function analysisExtension(options: {
  onAnalysis: (analysis: AuthorAnalysis) => void;
}): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        // 打开一篇已有正文的文档时也要先给出一份分析
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.schedule();
      }

      destroy(): void {
        this.destroyed = true;
        this.clearTimer();
      }

      private schedule(): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.destroyed) return;
          const source = this.view.state.doc.toString();
          let analysis: AuthorAnalysis;
          try {
            analysis = analyzeLocalSource(source, COMPILE_OPTIONS);
          } catch {
            analysis = EMPTY_ANALYSIS;
          }
          // 计时器回调与文档更新在同一线程，但卸载可能发生在回调排上之后
          if (this.destroyed) return;
          this.view.dispatch({ effects: setAnalysis.of(analysis) });
          try {
            options.onAnalysis(analysis);
          } catch {
            /* 宿主回调的异常不拖垮编辑器 */
          }
        }, ANALYSIS_DEBOUNCE_MS);
      }

      private clearTimer(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  );
}

/* -------------------------------------------------------------------------- */
/* 补全                                                                        */
/* -------------------------------------------------------------------------- */

function completionExtension(
  onCompletions?: (items: AuthorCompletion[]) => void
): Extension {
  return keymap.of([
    {
      key: 'Mod-Space',
      run(view) {
        // 输入法组合期间不抢键、不改文档；Escape 的原生行为一概不碰
        if (!onCompletions || view.composing) return false;
        onCompletions(getReactiveCompletions(view));
        return true;
      },
    },
  ]);
}

/** 当前光标处的建议（宿主按钮可以直接调；没有结果时返回空数组）。 */
export function getReactiveCompletions(view: EditorView): AuthorCompletion[] {
  if (view.composing) return [];
  const at = view.state.selection.main.head;
  try {
    return completeLocalSource(view.state.doc.toString(), at, COMPILE_OPTIONS);
  } catch {
    return [];
  }
}

/** 应用一条补全：一条事务、一步撤销；range 按当前文档夹紧。 */
export function applyReactiveCompletion(
  view: EditorView,
  completion: AuthorCompletion
): boolean {
  if (view.state.readOnly || view.composing) return false;
  const length = view.state.doc.length;
  const from = clamp(completion.range.start, 0, length);
  const to = clamp(completion.range.end, from, length);
  if (from === to && completion.insertText.length === 0) return false;
  view.dispatch({
    changes: { from, to, insert: completion.insertText },
    selection: { anchor: from + completion.insertText.length },
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* 命令                                                                        */
/* -------------------------------------------------------------------------- */

/** 一次改动只报「不同的那一段」，避免整篇替换带来的多余映射与冗余历史。 */
function singleChange(before: string, after: string): { from: number; to: number; insert: string } {
  const max = Math.min(before.length, after.length);
  let from = 0;
  while (from < max && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > from &&
    afterEnd > from &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { from, to: beforeEnd, insert: after.slice(from, afterEnd) };
}

/**
 * 插入一个原生组件模板。
 *
 * 顺序与上游工具条一致：中文目录取模板 → `renderNativeSnippet` 只解析
 * `{{bind:…}}`（同一次插入里同名绑定复用、与原文已有名字冲突时自动加序号）→
 * `insertTemplate` 处理选区 / 占位光标。整段落成**一个** CM6 事务，因此 Ctrl+Z
 * 一步退回，history 不重建。
 */
export function applyReactiveTemplate(view: EditorView, componentId: string): boolean {
  if (view.state.readOnly || view.composing) return false;
  const component = ZH_CATALOG.components.find((item) => item.id === componentId);
  if (!component) return false;

  const source = view.state.doc.toString();
  const range = view.state.selection.main;
  const selectedText = source.slice(range.from, range.to);
  const snippet = renderNativeSnippet(component, source, selectedText);
  const edit = insertTemplate(
    source,
    { start: range.from, end: range.to },
    snippet,
    { block: !component.inline }
  );
  if (edit.value === source) return false;

  view.dispatch({
    changes: singleChange(source, edit.value),
    selection: { anchor: edit.selection.start, head: edit.selection.end },
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
  return true;
}

/**
 * 保守格式化：只整理已识别标签内的空白（代码、公式、普通文字都不动）。
 * 上游在有编译错误时原样返回，所以这里无需另判。
 */
export function formatReactiveDocument(view: EditorView): boolean {
  if (view.state.readOnly || view.composing) return false;
  const state = view.state;
  const before = state.doc.toString();
  let after: string;
  try {
    after = formatLocalSource(before, COMPILE_OPTIONS);
  } catch {
    return false;
  }
  if (after === before) return false;

  const changes = state.changes(singleChange(before, after));
  view.dispatch({
    changes,
    selection: state.selection.map(changes),
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
  return true;
}

/** 聚焦到诊断区间（夹紧到当前文档），只改选区、不改正文。 */
export function revealReactiveDiagnostic(view: EditorView, diagnostic: Diagnostic): void {
  const { from, to } = clampSpan(diagnostic.range, view.state.doc.length);
  view.focus();
  view.dispatch({
    selection: { anchor: from, head: to },
    scrollIntoView: true,
  });
}

/* -------------------------------------------------------------------------- */
/* 扩展                                                                        */
/* -------------------------------------------------------------------------- */

export function reactiveAuthoring(options: {
  onAnalysis: (analysis: AuthorAnalysis) => void;
  onCompletions?: (items: AuthorCompletion[]) => void;
}): Extension {
  return [
    analysisExtension(options),
    analysisDecorations,
    completionExtension(options.onCompletions),
  ];
}
