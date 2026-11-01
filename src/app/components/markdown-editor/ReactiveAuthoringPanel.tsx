'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ReactiveAuthoringPanel.tsx —— Reactive 作者工具（诊断与组件挑选）
//
// 【分工】分析、补全与格式化**都来自 CodeMirror 扩展 / lib/md-editor 适配层**：
//   · 本文件只画结果与转发动作，不自己跑解析器，也不自己拼组件模板；
//   · 诊断的原文位置是 UTF-16 range，点击直接交给 `revealReactiveDiagnostic`；
//   · 组件目录来自**站点当前编译配置**（`lib/md-editor/reactive-authoring.ts` 的
//     `getSiteComponentCatalog` / `filterSiteComponents`），模板只由
//     `applyReactiveTemplate` 插入 —— 抄一份模板就会和上游两个版本。
//
// 【诊断默认收起】它是一块常驻的编辑区附属条：数量与状态（检查中 / 错误 / 警告）
// 一眼可见，明细默认不占版面。展开后逐条列出「第几行第几列 + 原因」，点一条就把
// 光标定位过去。没有诊断时也明确显示「未发现问题」，而不是让面板时有时无。
//
// 【补全不劫持编辑器键盘】候选列表只是普通按钮：Esc / Tab 在编辑器里仍走
// CodeMirror 自带的那条「先 Esc 再 Tab 离开编辑区」；这里只在列表自己获得焦点时
// 处理 Esc（关闭列表），不注册任何全局捕获阶段的键处理。
// ─────────────────────────────────────────────────────────────────────────────

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import { formatLocalDiagnostic, type Diagnostic } from 'reactive-md';
import type { AuthorCompletion } from '@/lib/md-editor/reactive-authoring';
import {
  filterSiteComponents,
  getSiteComponentCatalog,
  type SiteComponentEntry,
} from '@/lib/md-editor/reactive-authoring';

/** 诊断只需要这几个字段；格式分析的返回与 CM6 作者分析都满足它。 */
export type PanelDiagnostic = Pick<
  Diagnostic,
  'code' | 'severity' | 'message' | 'line' | 'column' | 'range'
>;

const COMPLETION_KIND_LABELS: Record<AuthorCompletion['kind'], string> = {
  tag: '标签',
  attribute: '属性',
  binding: '绑定',
  value: '值',
};

function diagnosticText(diagnostic: PanelDiagnostic): string {
  try {
    return formatLocalDiagnostic(diagnostic as Diagnostic, 'zh');
  } catch {
    // 未知宿主诊断没有模板；它的 message 本来就是给人看的。
    return diagnostic.message;
  }
}

function diagnosticKey(diagnostic: PanelDiagnostic, index: number): string {
  return `${diagnostic.code}:${diagnostic.range.start}:${diagnostic.range.end}:${index}`;
}

export interface ReactiveAuthoringPanelProps {
  /** 当前正文的诊断（来自异步格式分析，或 CM6 作者分析兜底）。 */
  diagnostics: readonly PanelDiagnostic[];
  /** true = message 已由格式分析本地化，直接显示（不要再按 code 模板重排）。 */
  localized?: boolean;
  /** true = 分析在飞（正文刚变、结果未到）；计数照旧显示上一版。 */
  pending?: boolean;
  /** null = 没有打开补全；[] = 打开但没有候选。 */
  completions: AuthorCompletion[] | null;
  /** 格式化等动作的一句话结果。 */
  status: string | null;
  /** 分析失败（例如 worker 不可用且回退也失败）时的明确状态；null = 正常。 */
  failure?: string | null;
  /**
   * true = worker 不可用，已在主线程回退检查。
   *
   * 回退本身是**功能正常、体验变慢**：长文每次停顿都要在主线程编译。不提示的话
   * 用户只会觉得「今天编辑器很卡」，而测试也看不出退化，所以计数旁边明说。
   */
  fallback?: boolean;
  onSelectCompletion: (item: AuthorCompletion) => void;
  onCloseCompletions: () => void;
  onRevealDiagnostic: (diagnostic: PanelDiagnostic) => void;
}

/**
 * 分析摘要 + 可收起的诊断列表 + 补全候选。
 *
 * 计数始终显示（0 也显示）：它是「现在这份正文有没有问题」的明确答复，
 * 而不是一块时有时无的横幅让用户猜。
 */
export default function ReactiveAuthoringPanel({
  diagnostics,
  localized = false,
  pending = false,
  completions,
  status,
  failure = null,
  fallback = false,
  onSelectCompletion,
  onCloseCompletions,
  onRevealDiagnostic,
}: ReactiveAuthoringPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.length - errors;

  const baseStateText = failure
    ? '检查失败'
    : pending
      ? '检查中…'
      : diagnostics.length > 0
        ? `错误 ${errors} · 警告 ${warnings}`
        : '未发现问题';
  // 回退是「结果照旧、速度变差」，不是失败 —— 接在同一个状态串后面，
  // 读屏（role=status / aria-live）会一起念出来。
  const stateText = fallback ? `${baseStateText}（本地检查）` : baseStateText;

  return (
    <section className="md-authoring" aria-label="Reactive 作者工具">
      <div className="md-authoring__summary">
        <span className="md-authoring__title">Reactive 检查</span>
        <span
          className={`md-authoring__state${errors > 0 || failure ? ' is-error' : warnings > 0 || fallback ? ' is-warning' : ''}`}
          role="status"
          aria-live="polite"
          title={
            fallback
              ? '浏览器 Worker 不可用，已回退到主线程检查；长文编辑可能变慢。'
              : undefined
          }
        >
          {stateText}
        </span>
        {diagnostics.length > 0 && (
          <button
            type="button"
            className="md-authoring__toggle"
            aria-expanded={expanded}
            aria-controls="md-authoring-diagnostics"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起明细' : '查看明细'}
            <ChevronDown
              size={13}
              strokeWidth={2}
              aria-hidden="true"
              className={expanded ? 'is-flipped' : undefined}
            />
          </button>
        )}
      </div>

      {/* 分析在飞时明细先不画：上一份结果的偏移对不上新正文（点击会定位错）。 */}
      {expanded && !pending && diagnostics.length > 0 && (
        <ul
          id="md-authoring-diagnostics"
          ref={listRef}
          className="md-authoring__diagnostics"
          aria-label="诊断列表"
        >
          {diagnostics.map((diagnostic, index) => (
            <li key={diagnosticKey(diagnostic, index)}>
              <button
                type="button"
                className={`md-authoring__diagnostic md-authoring__diagnostic--${diagnostic.severity}`}
                title="在编辑器中定位"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onRevealDiagnostic(diagnostic)}
              >
                <span className="md-authoring__severity">
                  {diagnostic.severity === 'error' ? '错误' : '警告'}
                </span>
                <span className="md-authoring__message">
                  {localized ? diagnostic.message : diagnosticText(diagnostic)}
                </span>
                <span className="md-authoring__position numeric">
                  第 {diagnostic.line} 行 {diagnostic.column} 列
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {completions !== null && (
        <div
          className="md-authoring__completions"
          aria-label="补全建议"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onCloseCompletions();
          }}
        >
          <div className="md-authoring__completions-head">
            <span className="md-authoring__completions-title">补全建议</span>
            <span className="md-authoring__completions-count numeric">
              {completions.length} 条
            </span>
            <button
              type="button"
              className="md-authoring__close"
              aria-label="关闭补全建议"
              onClick={onCloseCompletions}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          {completions.length === 0 ? (
            <p className="md-authoring__empty" role="status">
              当前位置没有补全建议。
            </p>
          ) : (
            <div className="md-authoring__completion-list">
              {completions.map((item, index) => (
                <button
                  key={`${item.kind}:${item.range.start}:${item.range.end}:${item.label}:${index}`}
                  type="button"
                  className="md-authoring__completion"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelectCompletion(item)}
                >
                  <span className={`md-authoring__kind is-${item.kind}`}>
                    {COMPLETION_KIND_LABELS[item.kind] ?? item.kind}
                  </span>
                  <span className="md-authoring__completion-label">{item.label}</span>
                  {item.detail && (
                    <span className="md-authoring__completion-detail">{item.detail}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {status && (
        <p className="md-authoring__status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}

// ── 组件挑选 ────────────────────────────────────────────────────────────────

export interface ReactiveComponentPickerProps {
  /** 触发按钮：Esc / 关闭时把焦点还给它。 */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** 光标处的容器祖先（用于上游的结构过滤）。 */
  ancestors?: readonly string[];
  /** `restoreFocus=false` 用于点外面关闭（焦点该留在用户点的地方）。 */
  onClose: (restoreFocus: boolean) => void;
  onInsert: (componentId: string) => void;
}

/**
 * 「插入组件」弹层。目录按站点配置分组、可搜索中文；选中后由调用方走
 * `applyReactiveTemplate`（一次事务），本组件不碰编辑器的文档。
 *
 * 键盘：搜索框自动聚焦，↑ / ↓ 在可插入条目间移动，Enter 插入当前高亮项，
 * Esc 关闭。焦点始终留在搜索框上（roving 的是高亮），所以「打开 → 打字 → ↓ →
 * Enter」全程不用碰鼠标。
 */
export function ReactiveComponentPicker({
  triggerRef,
  ancestors = [],
  onClose,
  onInsert,
}: ReactiveComponentPickerProps) {
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 目录来自站点当前编译配置；祖先上下文每次打开时由调用方算好传入。
  const catalog = useMemo(() => getSiteComponentCatalog(), []);

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) {
      // 没有搜索词时无需走上游过滤的字符串匹配，但仍按祖先上下文收窄：
      // 只该出现在某个容器里的组件不会在容器外面变成永远插不对的死模板。
      const byContext = filterSiteComponents('', ancestors);
      const allowed = new Set(byContext.flatMap((group) => group.entries.map((e) => e.id)));
      return catalog
        .map((group) => ({
          ...group,
          entries: group.entries.filter((entry) => allowed.has(entry.id)),
        }))
        .filter((group) => group.entries.length > 0);
    }
    return filterSiteComponents(query, ancestors);
  }, [catalog, query, ancestors]);

  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 高亮项：搜索词或上下文变化后落到第一条。
  useEffect(() => {
    setActiveKey(flat[0]?.id ?? null);
  }, [flat]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (dialogRef.current?.contains(target)) return;
      // 点触发按钮本身交给它的 onClick 做开/关切换，别在这里先关一次又弹开。
      if (triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, triggerRef]);

  /** Tab 在弹层内部循环：它是浮层，不该把焦点送到看不见的正文里去。 */
  function trapTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('input, button:not([disabled])'));
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? index <= 0
        ? items.length - 1
        : index - 1
      : index < 0 || index === items.length - 1
        ? 0
        : index + 1;
    event.preventDefault();
    items[next]?.focus();
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (flat.length === 0) return;
      event.preventDefault();
      const index = flat.findIndex((entry) => entry.id === activeKey);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = index < 0 ? 0 : (index + delta + flat.length) % flat.length;
      setActiveKey(flat[next]?.id ?? null);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const entry = flat.find((item) => item.id === activeKey) ?? flat[0];
      if (entry) onInsert(entry.id);
    }
  }

  function renderItem(component: SiteComponentEntry) {
    const active = component.id === activeKey;
    return (
      <button
        key={component.id}
        type="button"
        className={`md-component-picker__item${active ? ' is-active' : ''}`}
        title={component.help}
        aria-current={active ? 'true' : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveKey(component.id)}
        onClick={() => onInsert(component.id)}
      >
        <span className="md-component-picker__copy">
          <span className="md-component-picker__label">
            {component.title}
            {component.inline && <span className="md-component-picker__badge">行内</span>}
          </span>
          <span className="md-component-picker__desc">{component.description}</span>
        </span>
        <Plus size={14} strokeWidth={2} className="md-component-picker__add" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      ref={dialogRef}
      className="md-toolbar__menu md-toolbar__menu--components"
      role="dialog"
      aria-label="插入组件"
      onKeyDown={trapTab}
    >
      <div className="md-component-picker__head">
        <span className="md-component-picker__title">插入组件</span>
        <button
          type="button"
          className="md-component-picker__close"
          aria-label="关闭组件面板"
          onClick={() => onClose(true)}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <label className="md-component-picker__search">
        <Search size={14} strokeWidth={2} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="搜索组件（名称 / 说明）"
          aria-label="搜索组件"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      </label>

      <div className="md-component-picker__scroll">
        {groups.length === 0 ? (
          <p className="md-component-picker__empty" role="status">
            没有匹配的组件。
          </p>
        ) : (
          groups.map((group) => (
            <div
              key={group.id}
              className="md-component-picker__group"
              role="group"
              aria-label={group.label}
            >
              <div className="md-component-picker__group-title" aria-hidden="true">
                {group.label}
              </div>
              {group.entries.map(renderItem)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
