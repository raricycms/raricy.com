// ─────────────────────────────────────────────────────────────────────────────
// md-editor/reactive-authoring.ts —— ReactiveMD 作者工具的 CM6 适配层
//
// 【职责】把上游 `reactive-md/authoring` 的**用户触发**的纯函数接到 CodeMirror 6：
//   · Ctrl/Cmd+Space 补全（列表由宿主渲染，本模块只管取数与落地）；
//   · 组件模板 / 格式化 / 诊断定位。
//
// 【逐键分析已经**移出主线程**】这里曾经在每次 `docChanged` 后 250ms 同步调用
// `analyzeLocalSource`（内含完整编译），与编辑器新增的 worker 格式分析并存 ——
// 20 万字符正文会卡住 UI，而 worker 失效时更会被静默。现在：
//   · 正文格式 / 诊断 / 计数只来自 `@/lib/reactive/format-observer`（worker +
//     revision），见 MarkdownEditor；
//   · 本模块不再做任何自动解析，只提供**接收** worker 结果的入口
//     （`applyReactiveAuthorAnalysis`）：调用方在核对 revision / 原文之后把
//     `FormatAnalysis.author` 的 tokens 与诊断交给它，StateField 负责贴成
//     `cm-reactive-*` / `cm-reactive-diagnostic--*` 装饰。正文一变（任何来源）
//     装饰立即清空 —— 旧偏移贴在新文字上，看起来「还挺对」，但已经指错了地方；
//   · 补全 / 格式化是**用户显式触发**的，且有 `AUTHOR_TOOL_LENGTH_LIMIT` 上限；
//     超长正文直接给一句状态，不在主线程硬算。
//
// 【类名契约】token 用 `cm-reactive-<kind>`，诊断用
// `cm-reactive-diagnostic--error` / `--warning`。CSS 由 UI 侧提供，本模块只负责
// 加类名与 `title`（诊断 message）。
//
// 【为什么用上游公开入口】补全 / 格式化的词法、schema 与编译预算必须和
// 预览 / 阅读页**同一份**。自己再解析一遍，两边对「什么算 reactive 语法」迟早
// 会分叉，而且分叉时不报错。编译选项统一走 `REACTIVE_COMPILE_OPTIONS`。
// ─────────────────────────────────────────────────────────────────────────────

import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import {
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
import { REACTIVE_COMPILE_OPTIONS } from '@/lib/reactive/host-components';

export type { AuthorAnalysis, AuthorCompletion } from 'reactive-md/authoring';

/** 与预览 / 阅读页完全一致的宿主 schema、节点预算与语法开关。 */
const COMPILE_OPTIONS = REACTIVE_COMPILE_OPTIONS;

/**
 * 用户显式触发作者工具（补全 / 格式化）的正文长度上限。
 *
 * 两者都是**同步**的上游解析。普通长文里「按一下 Ctrl+Space 卡三秒」同样是
 * 静默劣化，所以超过这个长度直接拒绝并说明原因；编辑本身不受影响。
 * 50k 与站点预算注释里的「200k 最坏约 3s」不是一个东西 —— 这是交互预算。
 */
export const AUTHOR_TOOL_LENGTH_LIMIT = 50_000;

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
/* 装饰：接收 worker 的作者分析                                               */
/* -------------------------------------------------------------------------- */

/**
 * worker 回报的作者分析里本模块要画的那部分。
 *
 * 刻意收窄成 `tokens` / `diagnostics`：完整的 `AuthorAnalysis` 还带 bindings，
 * 装饰用不上；收窄也让调用方不必为了贴装饰多传一份数据。
 */
export type ReactiveAuthorAnalysis = Pick<AuthorAnalysis, 'tokens' | 'diagnostics'>;

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

function buildDecorations(length: number, analysis: ReactiveAuthorAnalysis): DecorationSet {
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

/** null = 清空（正文已变，或当前没有可用的分析）。 */
const setAuthorAnalysis = StateEffect.define<ReactiveAuthorAnalysis | null>();

/**
 * 装饰住 StateField，**docChanged 一律立即清空**。
 *
 * 清空不能等下一次分析：防抖窗口里旧偏移仍会命中新文字，看起来「还挺对」，
 * 但已经指错了地方。调用方在核对 revision / 原文之后才 dispatch 新值。
 */
const authorAnalysisDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAuthorAnalysis)) {
        return effect.value === null
          ? Decoration.none
          : buildDecorations(tr.state.doc.length, effect.value);
      }
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 把 worker 算好的分析贴成装饰。
 *
 * 调用方必须**先核对这份结果仍对应当前正文**（revision / 原文 / 代次）；
 * 本函数仍按当前文档长度夹紧每一次区间 —— 上游给的是 UTF-16 偏移，越界会让
 * EditorView 在下一次渲染时抛错，而错误现场早已不在调用点。
 */
export function applyReactiveAuthorAnalysis(
  view: EditorView,
  analysis: ReactiveAuthorAnalysis
): void {
  view.dispatch({ effects: setAuthorAnalysis.of(analysis) });
}

/** 收起装饰（切走格式 / 正文变化 / 结果作废时）。 */
export function clearReactiveAuthorAnalysis(view: EditorView): void {
  view.dispatch({ effects: setAuthorAnalysis.of(null) });
}

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

/* -------------------------------------------------------------------------- */
/* 补全                                                                        */
/* -------------------------------------------------------------------------- */

function completionExtension(options: {
  onCompletions?: (items: AuthorCompletion[]) => void;
  onTooLong?: () => void;
}): Extension {
  return keymap.of([
    {
      key: 'Mod-Space',
      run(view) {
        // 输入法组合期间不抢键、不改文档；Escape 的原生行为一概不碰
        if ((!options.onCompletions && !options.onTooLong) || view.composing) return false;
        if (view.state.doc.length > AUTHOR_TOOL_LENGTH_LIMIT) {
          options.onTooLong?.();
          return true;
        }
        options.onCompletions?.(getReactiveCompletions(view));
        return true;
      },
    },
  ]);
}

/** 当前光标处的建议（宿主按钮可以直接调；没有结果时返回空数组）。 */
export function getReactiveCompletions(view: EditorView): AuthorCompletion[] {
  if (view.composing) return [];
  if (view.state.doc.length > AUTHOR_TOOL_LENGTH_LIMIT) return [];
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
 *
 * 这是**打开 Components 菜单时**的一次同步解析，与逐键分析不是一回事：它只在
 * 用户点开菜单时跑一次，不是每键都跑。但 20 万字符正文仍可能顿一下，所以沿用
 * `AUTHOR_TOOL_LENGTH_LIMIT` 作为上限 —— 超长时不猜（返回空 = 不按上下文过滤，
 * 菜单显示全部条目），而不是把 UI 卡住。
 *
 * 解析失败同样返回空数组：菜单退回「全部组件」比整块菜单消失好。
 */
export function getComponentAncestors(view: EditorView): string[] {
  if (view.state.doc.length > AUTHOR_TOOL_LENGTH_LIMIT) return [];
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
  if (state.doc.length > AUTHOR_TOOL_LENGTH_LIMIT) return false;
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
  onCompletions?: (items: AuthorCompletion[]) => void;
  onTooLong?: () => void;
}): Extension {
  // 逐键分析不在本模块跑：装饰由 `applyReactiveAuthorAnalysis` 用 worker 的
  // 结果喂养（见本文件头）。这里只装 StateField 与用户触发的补全键位。
  return [authorAnalysisDecorations, completionExtension(options)];
}
