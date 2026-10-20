'use client';

// ExpandSelect —— 带「0fr → 1fr」展开动画的自定义下拉列表。
//
// 【为什么需要它】站内原先这些字段都是原生 <select>：博客创建页的「选择栏目 /
// 可见范围」、日志检索的动作 / 对象 / 来源 / 时间范围、文章管理的栏目筛选……
// 原生下拉的弹出层由浏览器画，样式、动画、圆角都不归我们管；而博客目录页的
// 「全部栏目」（BlogCategorySelect）早就有一版按内容高度伸展的展开动画。
// 这个组件把那一档体验抽成通用件，供**所有列表型字段**复用。
//
// 【与 BlogCategorySelect 的分工】后者是筛选条里的特例：宽度还要随最长选项伸缩、
// 父栏目旁边有独立的二级展开钮，所以保留自己的组件与几何。两者的共同点 ——
// 展开动画的节奏 —— 收在 abstracts/_mixins.scss 的 expand-panel，别各写一份。
//
// 【表单语义】给了 `name` 就渲染一枚隐藏 input，GET 表单 / FormData 读到的仍是
// 原来那个字段名。选择时**先同步写 DOM** 再回调 onChange —— 调用方可能在 onChange
// 里立刻 requestSubmit()（文章管理页的筛选就是这么做的），那时 React 状态还没刷进
// 隐藏 input，只靠状态更新会提交**上一格的值**，而且页面上看不出任何异常。
//
// 【可访问性】触发钮是 button（aria-haspopup / aria-expanded），面板是 listbox，
// 选项是 option。打开后方向键在选项间移动、Home / End 到首尾、Enter / 空格选中、
// Escape 收起并把焦点还给触发钮、Tab 正常离开；收起的面板挂 inert，不会进入焦点序列。
// 外部点击与焦点移出同样收起。

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronDown } from 'lucide-react';

export interface ExpandSelectOption {
  value: string;
  label: string;
  /** 二级条目缩进一档（博客栏目用）。 */
  depth?: number;
  disabled?: boolean;
}

export interface ExpandSelectGroup {
  /** 分组标题（不可选）。不传就是一组普通选项。 */
  label?: string;
  options: ExpandSelectOption[];
}

export interface ExpandSelectProps {
  /** 表单字段名。给了就渲染一枚隐藏 input。 */
  name?: string;
  /** 触发钮的 id（配合外部 `<label htmlFor>`）。 */
  id?: string;
  /** 受控值；不传则组件内部自管（初值 defaultValue）。 */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  groups: ExpandSelectGroup[];
  disabled?: boolean;
  /** 触发钮的无障碍名称。需要读出「当前值」时由调用方拼好传进来。 */
  ariaLabel?: string;
  /** 附加到根节点的类名（`admin-field__control` / `admin-toolbar__select` 等）。 */
  className?: string;
}

export default function ExpandSelect({
  name,
  id,
  value,
  defaultValue = '',
  onChange,
  groups,
  disabled = false,
  ariaLabel,
  className,
}: ExpandSelectProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'down' | 'up'>('down');
  const [internalValue, setInternalValue] = useState(defaultValue);
  const currentValue = value ?? internalValue;

  const hostRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pendingFocus = useRef<'selected' | 'first' | 'last' | null>(null);

  const autoId = useId().replace(/:/g, '');
  const panelId = `${id ?? autoId}-panel`;

  // 分组只影响展示，键盘 / 选中都在这张拍平表上跑。
  const flat = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const selected = flat.find((option) => option.value === currentValue);
  const selectedLabel = selected?.label ?? '';

  useLayoutEffect(() => {
    if (!open) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (!target) return;
    const selectedIndex = flat.findIndex((option) => option.value === currentValue);
    const index =
      target === 'first'
        ? 0
        : target === 'last'
          ? flat.length - 1
          : selectedIndex >= 0
            ? selectedIndex
            : 0;
    optionRefs.current[index]?.focus();
  }, [open, flat, currentValue]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  /**
   * 浮层开在触发钮下方还是上方：下方空间不够（表单底部的字段）就翻上去，
   * 否则面板会伸出视口底部，后半截选项得靠滚页面才够得到。
   * 同时把列表的最大高度钉在**实际可用空间**上，而不是写死 420px。
   */
  function measurePlacement() {
    const rect = toggleRef.current?.getBoundingClientRect();
    const root = hostRef.current;
    if (!rect || !root) return;
    const gap = 12;
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const next: 'down' | 'up' = below >= 320 || below >= above ? 'down' : 'up';
    setPlacement(next);
    root.style.setProperty(
      '--expand-select-max-height',
      `${Math.max(160, Math.min(420, next === 'down' ? below : above))}px`
    );
  }

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measurePlacement);
    return () => window.removeEventListener('resize', measurePlacement);
  }, [open]);

  function openPanel(where?: 'selected' | 'first' | 'last') {
    if (disabled) return;
    measurePlacement();
    pendingFocus.current = where ?? null;
    setOpen(true);
  }

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }

  function choose(option: ExpandSelectOption) {
    if (option.disabled) return;
    if (value === undefined) setInternalValue(option.value);
    // 见文件头「表单语义」：onChange 里可能立刻提交，隐藏 input 必须已是新值。
    if (inputRef.current) inputRef.current.value = option.value;
    close();
    onChange?.(option.value);
  }

  /** 在可选项之间移动焦点（跳过 disabled，首尾环绕）。 */
  function moveFocus(step: 1 | -1) {
    if (flat.length === 0) return;
    const active = optionRefs.current.findIndex((element) => element === document.activeElement);
    if (active === -1) {
      optionRefs.current[step === 1 ? 0 : flat.length - 1]?.focus();
      return;
    }
    let next = active;
    for (let i = 0; i < flat.length; i += 1) {
      next = (next + step + flat.length) % flat.length;
      if (!flat[next].disabled) {
        optionRefs.current[next]?.focus();
        return;
      }
    }
  }

  function onToggleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) moveFocus(event.key === 'ArrowDown' ? 1 : -1);
      else openPanel(event.key === 'ArrowDown' ? 'selected' : 'last');
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, option: ExpandSelectOption) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      optionRefs.current[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      optionRefs.current[flat.length - 1]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      // 先把焦点还给触发钮，再让浏览器按 DOM 顺序继续走；否则面板随后变 inert，
      // 焦点会落回 body（键盘用户「按 Tab 掉到页面顶部」）。
      setOpen(false);
      toggleRef.current?.focus();
    }
  }

  let nextIndex = 0;

  return (
    <div
      ref={hostRef}
      className={`expand-select${open ? ' is-open' : ''}${placement === 'up' ? ' is-up' : ''}${
        className ? ` ${className}` : ''
      }`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        id={id}
        className="expand-select__toggle"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) close(false);
          else openPanel();
        }}
        onKeyDown={onToggleKeyDown}
      >
        <span className="expand-select__label">{selectedLabel}</span>
        <ChevronDown className="expand-select__chevron" aria-hidden="true" />
      </button>

      <div className="expand-select__panel" inert={!open}>
        <div className="expand-select__clip">
          <div
            className="expand-select__list"
            id={panelId}
            role="listbox"
            aria-label={ariaLabel ?? '选项'}
          >
            {groups.map((group, groupIndex) => {
              const options = group.options.map((option) => {
                const index = nextIndex;
                nextIndex += 1;
                return (
                  <div
                    key={`${option.value}-${index}`}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    role="option"
                    aria-selected={option.value === currentValue}
                    aria-disabled={option.disabled || undefined}
                    tabIndex={-1}
                    className={`expand-select__option${option.depth ? ' expand-select__option--child' : ''}${
                      option.value === currentValue ? ' is-active' : ''
                    }`}
                    onClick={() => choose(option)}
                    onKeyDown={(event) => onOptionKeyDown(event, option)}
                  >
                    {option.label}
                  </div>
                );
              });
              // 有标题的分组给 role=group（读屏能把标题念出来）；没有标题的别套空壳。
              return group.label ? (
                <div key={`group-${groupIndex}`} role="group" aria-label={group.label}>
                  <div className="expand-select__group-label" aria-hidden="true">
                    {group.label}
                  </div>
                  {options}
                </div>
              ) : (
                <Fragment key={`group-${groupIndex}`}>{options}</Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {name ? (
        <input
          ref={inputRef}
          type="hidden"
          name={name}
          value={currentValue}
          readOnly
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
