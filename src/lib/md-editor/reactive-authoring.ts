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
  createLocalComponentCatalogForOptions,
  filterLocalComponentCatalog,
  formatLocalSource,
  insertLocalComponentFromOptions,
  localCatalogAncestors,
  localComponentCatalogGroups,
  localComponentHelp,
} from 'reactive-md/authoring';
import type {
  AuthorAnalysis,
  AuthorCompletion,
  Diagnostic,
  LocalComponentCatalogEntry,
} from 'reactive-md/authoring';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';

export type { AuthorAnalysis, AuthorCompletion } from 'reactive-md/authoring';

/** 与预览 / 阅读页完全一致的宿主 schema、节点预算与语法开关。 */
const COMPILE_OPTIONS = reactiveCompileOptions('reactive');

/** 停手一小会儿再分析：比逐键解析省得多，又赶得上视觉上的「即时」。 */
const ANALYSIS_DEBOUNCE_MS = 250;

/**
 * 组件目录来自**站点当前编译配置**，不维护第二份清单。
 *
 * `createLocalComponentCatalogForOptions(COMPILE_OPTIONS)` 与编译器读同一份 host schema /
 * 预算，于是「菜单里点得出来」和「预览里编译得过」天然一致。站点没有宿主能力的组件
 * 不会凭空出现在这里（`<site-embed>` 是 host component，上游目录不收录它 ——
 * 引用走「插入引用」面板，不走 Components）。
 *
 * 目录在一次模块求值里算好：选项是静态的，`localComponentCatalogKey` 也只是为了
 * 上游自己的缓存口径；这里没有随正文变化的输入。
 */
const SITE_ENTRIES: readonly LocalComponentCatalogEntry[] =
  createLocalComponentCatalogForOptions(COMPILE_OPTIONS, 'zh');

const SITE_GROUPS = localComponentCatalogGroups(SITE_ENTRIES);

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

// ── 组件目录（供 Components 菜单）────────────────────────────────────────────

/** 菜单里的一行：直接从上游目录投影，不另写文案 / 模板。 */
export interface SiteComponentEntry {
  id: string;
  title: string;
  description: string;
  category: string;
  categoryLabel: string;
  inline: boolean;
  paired: boolean;
  /** 搜索词（中英双语，来自上游 manifest）。 */
  keywords: readonly string[];
  /** 纯文本帮助：说明 + 属性帮助（悬停 / 可访问名用）。 */
  help: string;
}

export interface SiteComponentGroup {
  id: string;
  label: string;
  entries: SiteComponentEntry[];
}

function toEntry(item: LocalComponentCatalogEntry): SiteComponentEntry {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    category: item.category,
    categoryLabel: item.categoryLabel,
    inline: item.inline,
    paired: item.paired,
    keywords: item.keywords ?? [],
    help: localComponentHelp(item),
  };
}

/** 分组顺序 = 上游目录顺序（输入 / 交互 / 组织 / 数据 / 提示）。 */
export function getSiteComponentCatalog(): SiteComponentGroup[] {
  return SITE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    entries: group.entries.map(toEntry),
  }));
}

/**
 * 按搜索词与光标上下文过滤。
 *
 * `ancestors` 交给上游 `filterLocalComponentCatalog`：只该出现在某个容器里的组件
 * （声明了 `parents` 的那些）不会在光标外面变成永远插不对的死模板。
 * 本模块不自己判父子关系 —— 那是编译器的 schema。
 */
export function filterSiteComponents(
  query: string,
  ancestors: readonly string[] = []
): SiteComponentGroup[] {
  const term = query.trim();
  const entries = filterLocalComponentCatalog(SITE_ENTRIES, {
    query: term || undefined,
    ancestors: ancestors.length > 0 ? ancestors : undefined,
  });
  const allowed = new Set(entries.map((entry) => entry.id));
  return SITE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    entries: group.entries
      .filter((entry) => allowed.has(entry.id))
      .map(toEntry),
  })).filter((group) => group.entries.length > 0);
}

/**
 * 光标处的容器祖先（最外 → 最内），交给 `filterSiteComponents` 做上下文过滤。
 * 解析失败一律返回空数组：菜单退回「全部组件」比整块菜单消失好。
 */
export function getComponentAncestors(view: EditorView): string[] {
  try {
    return [
      ...localCatalogAncestors(
        view.state.doc.toString(),
        view.state.selection.main.head,
        COMPILE_OPTIONS
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * 插入一个组件模板。
 *
 * 顺序与上游工具条一致：从**站点配置**的目录取条目 → `insertLocalComponentFromOptions`
 * 解析 `{{bind:…}}`（同名绑定复用、与原文冲突时自动加序号）、处理选区 / 占位光标。
 * 整段落成**一个** CM6 事务，因此 Ctrl+Z 一步退回，history 不重建。
 */
export function applyReactiveTemplate(view: EditorView, componentId: string): boolean {
  if (view.state.readOnly || view.composing) return false;
  if (!SITE_ENTRIES.some((item) => item.id === componentId)) return false;

  const source = view.state.doc.toString();
  const range = view.state.selection.main;
  let edit;
  try {
    edit = insertLocalComponentFromOptions(
      COMPILE_OPTIONS,
      componentId,
      source,
      { start: range.from, end: range.to },
      'zh'
    );
  } catch {
    // 目录里每条模板在构建期已校验；这里只是防御 —— 插不进去时保持正文原样。
    return false;
  }
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
