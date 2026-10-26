'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ReactiveAuthoringPanel.tsx —— Reactive 模式的作者工具（分析 / 补全 / 组件挑选）
//
// 【分工】分析、补全与格式化**都来自 CodeMirror 扩展**（`reactiveAuthoring`）：
//   · 本文件只画结果与转发动作，不自己跑解析器，也不自己拼组件模板；
//   · 诊断的原文位置是 UTF-16 range，点击直接交给 `revealReactiveDiagnostic`；
//   · 组件目录来自 `reactive-md/authoring` 的 `getNativeComponentCatalog('zh')`，
//     模板只由 `applyReactiveTemplate` 插入 —— 抄一份模板就会和上游两个版本。
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
import { Plus, Search, X } from 'lucide-react';
import { formatLocalDiagnostic, type Diagnostic } from 'reactive-md';
import {
  getNativeComponentCatalog,
  type NativeComponentDefinition,
} from 'reactive-md/authoring';
import type { AuthorAnalysis, AuthorCompletion } from '@/lib/md-editor/reactive-authoring';

const COMPLETION_KIND_LABELS: Record<AuthorCompletion['kind'], string> = {
  tag: '标签',
  attribute: '属性',
  binding: '绑定',
  value: '值',
};

function diagnosticText(diagnostic: Diagnostic): string {
  try {
    return formatLocalDiagnostic(diagnostic, 'zh');
  } catch {
    // 未知宿主诊断没有模板；它的 message 本来就是给人看的。
    return diagnostic.message;
  }
}

function diagnosticKey(diagnostic: Diagnostic, index: number): string {
  return `${diagnostic.code}:${diagnostic.range.start}:${diagnostic.range.end}:${index}`;
}

export interface ReactiveAuthoringPanelProps {
  /** 最近一次分析；null = 尚未分析（初始加载 / 刚切回 Markdown 时被清空）。 */
  analysis: AuthorAnalysis | null;
  /** null = 没有打开补全；[] = 打开但没有候选。 */
  completions: AuthorCompletion[] | null;
  /** 格式化等动作的一句话结果。 */
  status: string | null;
  onSelectCompletion: (item: AuthorCompletion) => void;
  onCloseCompletions: () => void;
  onRevealDiagnostic: (diagnostic: Diagnostic) => void;
}

/**
 * 分析摘要 + 诊断列表 + 补全候选。
 *
 * 计数始终显示（0 也显示）：切换格式后清零，是「现在这份正文没有错误」的
 * 明确答复，而不是一块时有时无的横幅让用户猜。
 */
export default function ReactiveAuthoringPanel({
  analysis,
  completions,
  status,
  onSelectCompletion,
  onCloseCompletions,
  onRevealDiagnostic,
}: ReactiveAuthoringPanelProps) {
  const diagnostics = analysis?.diagnostics ?? [];
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.length - errors;

  return (
    <section className="md-authoring" aria-label="Reactive 作者工具">
      <div className="md-authoring__summary">
        <span className="md-authoring__title">Reactive 检查</span>
        <span className={`md-authoring__count${errors > 0 ? ' is-error' : ''}`}>
          错误 {errors}
        </span>
        <span className={`md-authoring__count${warnings > 0 ? ' is-warning' : ''}`}>
          警告 {warnings}
        </span>
      </div>

      {diagnostics.length > 0 && (
        <ul className="md-authoring__diagnostics" aria-label="诊断列表">
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
                <span className="md-authoring__message">{diagnosticText(diagnostic)}</span>
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

function matchesQuery(component: NativeComponentDefinition, term: string): boolean {
  if (!term) return true;
  return [component.id, component.label, component.description, ...component.keywords].some(
    (value) => value.toLowerCase().includes(term)
  );
}

export interface ReactiveComponentPickerProps {
  /** 触发按钮：Esc / 关闭时把焦点还给它。 */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** `restoreFocus=false` 用于点外面关闭（焦点该留在用户点的地方）。 */
  onClose: (restoreFocus: boolean) => void;
  onInsert: (componentId: string) => void;
}

/**
 * 「插入组件」弹层。目录按 group 分组、可搜索中文；选中后由调用方走
 * `applyReactiveTemplate`（一次事务），本组件不碰编辑器的文档。
 */
export function ReactiveComponentPicker({
  triggerRef,
  onClose,
  onInsert,
}: ReactiveComponentPickerProps) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalog = useMemo(() => getNativeComponentCatalog('zh'), []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

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

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    return catalog.groups
      .map((group) => ({
        group,
        components: catalog.components.filter(
          (component) => component.group === group.id && matchesQuery(component, term)
        ),
      }))
      .filter((entry) => entry.components.length > 0);
  }, [catalog, query]);

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
          placeholder="搜索组件"
          aria-label="搜索组件"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="md-component-picker__scroll">
        {groups.length === 0 ? (
          <p className="md-component-picker__empty" role="status">
            没有匹配的组件。
          </p>
        ) : (
          groups.map(({ group, components }) => (
            <div
              key={group.id}
              className="md-component-picker__group"
              role="group"
              aria-label={group.label}
            >
              <div className="md-component-picker__group-title" aria-hidden="true">
                {group.label}
              </div>
              {components.map((component) => (
                <button
                  key={component.id}
                  type="button"
                  className="md-component-picker__item"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onInsert(component.id)}
                >
                  <span className="md-component-picker__copy">
                    <span className="md-component-picker__label">
                      {component.label}
                      {component.inline && (
                        <span className="md-component-picker__badge">行内</span>
                      )}
                    </span>
                    <span className="md-component-picker__desc">{component.description}</span>
                  </span>
                  <Plus
                    size={14}
                    strokeWidth={2}
                    className="md-component-picker__add"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
