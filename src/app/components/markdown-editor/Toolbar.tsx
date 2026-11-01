'use client';

// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/Toolbar.tsx —— 编辑器的工具条（四入口信息架构）
//
//   Insert ▾   Components ▾   上传图片   插入引用   │   撤销 / 重做       更多 ▾
//
// 【为什么是这四个入口】工具条此前把十几颗按钮平铺成两行（窄屏三行），手机上既
// 点不准也看不出分组。现在：
//   · **Insert** —— 所有「往正文里写 Markdown」的动作，按 文字 / 列表 / 内容 /
//     表情 分组。标题、粗斜、列表缩进、引用块、代码、数学、表格、链接、外链图片
//     都在这里；快捷键不变（命令层仍是 lib/md-editor/commands.ts）。
//   · **Components** —— ReactiveMD 原生组件的插入目录。目录来自**站点当前编译
//     配置**（见 lib/md-editor/reactive-authoring.ts），不维护第二份清单，也不会
//     列出站点没有宿主能力的死模板。插入组件本身就是「开始写增强语法」，不要求
//     作者先手动选择 Reactive 格式。
//   · **上传图片** —— 新传一张、插进正文（文件选择 / 拖拽 / 粘贴仍走编辑器自身）。
//   · **插入引用** —— 图床 / 音频 / 剪贴板 / 投票 / 收藏夹（ResourcePanel）。
// 撤销 / 重做独立成组，按真实历史启用；导出 / 打印 / 格式化 / 补全收进 **更多**
// （低频动作，不该和内容插入挤在一起）。
//
// 【一份 DOM，桌面与手机同一套逻辑】组件里**不写 matchMedia**：宽屏显示带文字的
// 入口，窄屏由样式表把文字标签藏起来、把历史组收进「更多」菜单。绝不做两套工具条
// ——两份 DOM 会让菜单、选区、焦点各认到不同的一份。
//
// 【浮层互斥】同一时刻只开一个菜单（`openMenu` 单值）。点外面关闭且焦点留在用户
// 点的位置；Esc 关闭并把焦点还给触发按钮。菜单自己限宽限高、内部滚动，窄屏跟着
// 编辑器可用宽度收（100cqw，见 _markdown-editor.scss），不会撑出 overflow:hidden
// 的裁剪框。
//
// 【一次插入 = 一笔撤销】按钮只调用 lib/md-editor 的事务命令；工具条自己不改文档，
// 于是「点按钮」与「按快捷键」走同一条路径。所有按钮一律 type="button" —— 工具条
// 挂在博客 / 剪贴板的 <form> 里，省略 type 会让 Enter / 点击误触提交。
// ─────────────────────────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Bold,
  Blocks,
  ChevronDown,
  Code,
  Columns2,
  Eye,
  FileDown,
  Heading,
  ImagePlus,
  Image as ImageIcon,
  Indent,
  Italic,
  Library,
  Link as LinkIcon,
  List,
  ListChecks,
  ListFilter,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Outdent,
  Pencil,
  Quote,
  Redo2,
  Sigma,
  Smile,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
  WandSparkles,
} from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import { redoDepth, undoDepth } from '@codemirror/commands';
import { readFormatState } from 'reactive-md/authoring';
import * as cmd from '@/lib/md-editor/commands';
import { applyReactiveTemplate, getComponentAncestors } from '@/lib/md-editor/reactive-authoring';
import { ReactiveComponentPicker } from './ReactiveAuthoringPanel';

/** 表情面板里的完整表情：保留变体选择符，按码点拆开会产生不可见的空白按钮。 */
const EMOJI = [
  '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉',
  '😊', '😍', '😘', '😜', '🤔', '😐', '😴', '😢',
  '😭', '😤', '😱', '🥳', '🤯', '😇', '🙃', '😎',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '👌',
  '❤️', '💔', '✨', '🔥', '🎉', '🎁', '⭐', '💡',
  '✅', '❌', '⚠️', '❓', '❗', '📌', '📎', '🔗',
  '🚀', '🐟', '🌱', '🌈', '☀️', '🌙', '☕', '🍜',
];

const HEADINGS = [
  { level: 0, label: '正文' },
  { level: 1, label: '标题 1' },
  { level: 2, label: '标题 2' },
  { level: 3, label: '标题 3' },
  { level: 4, label: '标题 4' },
  { level: 5, label: '标题 5' },
  { level: 6, label: '标题 6' },
];

type MenuKey = 'insert' | 'components' | 'more' | null;

/** `readFormatState` 的落点；null = 编辑区还没建好。 */
type FormatState = ReturnType<typeof readFormatState> | null;

export interface ToolbarProps {
  /** 编辑器视图；null = 还没建好，此时按钮全部禁用。 */
  view: EditorView | null;
  /** 上传按钮：去点那个隐藏的 file input。 */
  onPickFiles: () => void;
  /** 「插入引用」面板（图床 / 音频 / 剪贴板 / 投票 / 收藏夹）。 */
  onOpenResources: () => void;
  /** 导出 HTML。 */
  onExportHtml: () => void;
  /** 打印 / PDF。 */
  onPrint: () => void;
  /** 是否给公式按钮（剪贴板有、博客没有 —— 与旧工具条一致）。 */
  withMath: boolean;
  /** 「补全」：由外壳读取当前候选并展示。 */
  onRequestCompletions?: () => void;
  /** 「格式化」：整理已识别 Reactive 标签内的空白。 */
  onFormat?: () => void;
  /** 成功插入一个组件后通知外壳：这份正文从此按增强语法保存（不要求先选格式）。 */
  onComponentInserted?: () => void;
  /**
   * 当前正文是否已按 Reactive 呈现。**不再用来隐藏任何入口**（Components 永远
   * 可点：插一个组件就是把这份正文变成增强语法）；只用于把「补全 / 格式化」
   * 标成更显眼的那一档。
   */
  reactive?: boolean;
}

/** 菜单里的一颗按钮：鼠标按下不抢编辑区选区。 */
function MenuButton({
  onRun,
  className = 'md-toolbar__menu-item',
  children,
  ...rest
}: {
  onRun: () => void;
  className?: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onMouseDown' | 'type'>) {
  return (
    <button
      type="button"
      className={className}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
      {...rest}
    >
      {children}
    </button>
  );
}

export default function Toolbar({
  view,
  onPickFiles,
  onOpenResources,
  onExportHtml,
  onPrint,
  withMath,
  onRequestCompletions,
  onFormat,
  onComponentInserted,
  reactive = false,
}: ToolbarProps) {
  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [formatState, setFormatState] = useState<FormatState>(null);
  /**
   * Components 菜单的上下文（光标所在的容器祖先）。
   *
   * 只在**点开菜单**时算一次，不是逐键分析；上游解析有长度上限
   * （`AUTHOR_TOOL_LENGTH_LIMIT`，见 `getComponentAncestors`），超长正文直接
   * 返回空 = 不按上下文过滤，不会把菜单卡住。
   */
  const [componentAncestors, setComponentAncestors] = useState<string[]>([]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const insertTriggerRef = useRef<HTMLButtonElement>(null);
  const componentsTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  const disabled = !view;
  const canUndo = !!view && undoDepth(view.state) > 0;
  const canRedo = !!view && redoDepth(view.state) > 0;

  /** 当前打开的菜单（同步副本）—— 关闭 / 切换时读它，不在 state updater 里做副作用。 */
  const openMenuRef = useRef<MenuKey>(null);
  openMenuRef.current = openMenu;

  /** 关菜单：Esc 把焦点还给触发钮；点外面留给用户点的目标。 */
  const closeMenu = useCallback((restoreFocus = false) => {
    const current = openMenuRef.current;
    setOpenMenu(null);
    setEmojiOpen(false);
    if (!restoreFocus || !current) return;
    const triggers: Record<Exclude<MenuKey, null>, RefObject<HTMLButtonElement | null>> = {
      insert: insertTriggerRef,
      components: componentsTriggerRef,
      more: moreTriggerRef,
    };
    triggers[current].current?.focus();
  }, []);

  /** 打开某个菜单前，按**此刻**的选区读一次格式状态（菜单里可显示当前状态）。 */
  const openWith = useCallback(
    (menu: Exclude<MenuKey, null>) => {
      if (openMenuRef.current === menu) {
        closeMenu(false);
        return;
      }
      if (view) {
        const range = view.state.selection.main;
        try {
          setFormatState(
            readFormatState(view.state.doc.toString(), { start: range.from, end: range.to })
          );
        } catch {
          setFormatState(null);
        }
        if (menu === 'components') {
          // 有界的一次同步解析（见 getComponentAncestors）；失败 / 超长时为空，
          // 菜单退回「全部组件」，不会因为上下文算不出来就整块消失。
          setComponentAncestors(getComponentAncestors(view));
        }
      }
      setEmojiOpen(false);
      setOpenMenu(menu);
    },
    [view, closeMenu]
  );

  // Esc / 点外面关闭。点外面**不**抢焦点 —— 用户正在点哪儿就留在哪儿。
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (toolbarRef.current?.contains(target)) return;
      closeMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu, closeMenu]);

  // 菜单打开后把焦点放到第一颗可操作项上：键盘用户可以立刻 ↑↓ / Enter。
  // Components 面板自己把焦点放在搜索框上 —— 这里不能再抢一次（父子 effect 的
  // 执行顺序里父级在后，抢过去会让「打开就能打字搜索」失效）。
  useEffect(() => {
    if (!openMenu || openMenu === 'components') return;
    const first = menuRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [role="menuitem"]:not([disabled])'
    );
    first?.focus();
  }, [openMenu]);

  /** 跑一条命令：先聚焦（点按钮时焦点在按钮上），再 dispatch。 */
  const run = useCallback(
    (command: cmd.EditorCommand) => {
      if (!view) return;
      view.focus();
      command(view);
    },
    [view]
  );

  const runAndClose = useCallback(
    (command: cmd.EditorCommand) => {
      run(command);
      closeMenu(false);
    },
    [run, closeMenu]
  );

  function insertComponent(componentId: string) {
    closeMenu(false);
    if (!view) return;
    if (applyReactiveTemplate(view, componentId)) onComponentInserted?.();
    view.focus();
  }

  /** 菜单内 ↑↓ / Home / End 在可操作项之间移动焦点（Tab 仍交给浏览器）。 */
  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const root = menuRef.current;
    if (!root) return;
    const items = Array.from(
      root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  }

  const active = formatState;
  const headingActive = (level: number) => !!active && active.headingLevel === level;
  const isBold = !!active?.bold;
  const isItalic = !!active?.italic;
  const isStrike = !!active?.strike;
  const isInlineCode = !!active?.inlineCode;
  const isQuote = !!active?.quote;
  const listType = active?.list ?? null;

  const item = (
    label: string,
    Icon: typeof Bold,
    action: () => void,
    opts: { active?: boolean; shortcut?: string; disabled?: boolean } = {}
  ) => (
    <MenuButton
      key={label}
      role="menuitem"
      onRun={action}
      disabled={disabled || opts.disabled}
      aria-pressed={opts.active === undefined ? undefined : opts.active}
      className={`md-toolbar__menu-item${opts.active ? ' is-active' : ''}`}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      <span className="md-toolbar__menu-label">{label}</span>
      {opts.shortcut && <span className="md-toolbar__menu-kbd">{opts.shortcut}</span>}
    </MenuButton>
  );

  /**
   * 主入口按钮：桌面 = 图标 + 完整文字，手机 = 只留**短文字**（图标与箭头由样式表
   * 藏掉）。手机上保留可读的中文标签，而不是一排只有内行才认得的图标 ——
   * `aria-label` 始终是完整名称，读屏不受视觉缩写影响。
   */
  const entry = (
    key: string,
    label: string,
    short: string,
    Icon: typeof Bold,
    triggerRef: RefObject<HTMLButtonElement | null>,
    menu: Exclude<MenuKey, null>
  ) => (
    <button
      key={key}
      ref={triggerRef}
      type="button"
      className={`md-toolbar__btn md-toolbar__btn--entry${openMenu === menu ? ' is-open' : ''}`}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={openMenu === menu}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openWith(menu)}
    >
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span className="md-toolbar__entry-label">{label}</span>
      <span className="md-toolbar__entry-short">{short}</span>
      <ChevronDown className="md-toolbar__entry-caret" size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  const insertMenu = (
    <div
      ref={menuRef}
      className="md-toolbar__menu md-toolbar__menu--insert"
      role="menu"
      aria-label="插入"
      onKeyDown={onMenuKeyDown}
    >
      <div className="md-toolbar__section" role="group" aria-label="标题">
        <div className="md-toolbar__section-title">标题</div>
        <div className="md-toolbar__chips">
          {HEADINGS.map((heading) => (
            <button
              key={heading.level}
              type="button"
              role="menuitem"
              className={`md-toolbar__chip${headingActive(heading.level) ? ' is-active' : ''}`}
              aria-pressed={headingActive(heading.level)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runAndClose(cmd.setHeading(heading.level))}
            >
              {heading.label}
            </button>
          ))}
        </div>
      </div>

      <div className="md-toolbar__section" role="group" aria-label="文字">
        <div className="md-toolbar__section-title">文字</div>
        {item('粗体', Bold, () => runAndClose(cmd.toggleWrap('**', '粗体')), {
          active: isBold,
          shortcut: 'Ctrl+B',
        })}
        {item('斜体', Italic, () => runAndClose(cmd.toggleWrap('*', '斜体')), {
          active: isItalic,
          shortcut: 'Ctrl+I',
        })}
        {item('删除线', Strikethrough, () => runAndClose(cmd.toggleWrap('~~', '删除线')), {
          active: isStrike,
          shortcut: 'Ctrl+Shift+X',
        })}
        {item('行内代码', Code, () => runAndClose(cmd.toggleWrap('`', 'code')), {
          active: isInlineCode,
          shortcut: 'Ctrl+E',
        })}
        {item('链接', LinkIcon, () => runAndClose(cmd.insertLink()), { shortcut: 'Ctrl+K' })}
        {item('外链图片', ImageIcon, () => runAndClose(cmd.insertImage()))}
      </div>

      <div className="md-toolbar__section" role="group" aria-label="列表">
        <div className="md-toolbar__section-title">列表</div>
        {item('无序列表', List, () => runAndClose(cmd.toggleBulletList), {
          active: listType === 'bullet',
        })}
        {item('有序列表', ListOrdered, () => runAndClose(cmd.toggleOrderedList), {
          active: listType === 'ordered',
        })}
        {item('任务列表', ListChecks, () => runAndClose(cmd.toggleTaskList), {
          active: listType === 'task',
        })}
        {item('减少缩进', Outdent, () => runAndClose(cmd.shiftIndent(true)))}
        {item('增加缩进', Indent, () => runAndClose(cmd.shiftIndent(false)))}
      </div>

      <div className="md-toolbar__section" role="group" aria-label="内容">
        <div className="md-toolbar__section-title">内容</div>
        {item('引用块', Quote, () => runAndClose(cmd.toggleQuote), { active: isQuote })}
        {item('分隔线', Minus, () => runAndClose(cmd.insertHorizontalRule()))}
        {item('代码块', SquareCode, () => runAndClose(cmd.insertCodeBlock()))}
        {withMath && item('公式', Sigma, () => runAndClose(cmd.insertMathBlock()))}
        {item('表格', Table, () => runAndClose(cmd.insertTable()))}
      </div>

      <div className="md-toolbar__section md-toolbar__section--emoji" role="group" aria-label="表情">
        <div className="md-toolbar__section-head">
          <div className="md-toolbar__section-title">表情</div>
          <button
            type="button"
            className="md-toolbar__emoji-toggle"
            aria-label={emojiOpen ? '收起表情' : '展开表情'}
            aria-expanded={emojiOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setEmojiOpen((value) => !value)}
          >
            {emojiOpen ? '收起' : '展开'}
          </button>
        </div>
        {emojiOpen && (
          <div className="md-toolbar__emoji-grid" role="group" aria-label="表情列表">
            {EMOJI.map((ch) => (
              <button
                key={ch}
                type="button"
                role="menuitem"
                className="md-toolbar__emoji"
                aria-label={`插入表情 ${ch}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runAndClose(cmd.insertText(ch))}
              >
                {ch}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="md-toolbar" role="toolbar" aria-label="编辑器工具条" ref={toolbarRef}>
      {/* 1. Insert：所有 Markdown 写入动作 */}
      <div className="md-toolbar__group md-toolbar__group--insert">
        <div className="md-toolbar__popover-host">
          {entry('insert', '插入', '插入', Heading, insertTriggerRef, 'insert')}
          {openMenu === 'insert' && insertMenu}
        </div>
      </div>

      {/* 2. Components：ReactiveMD 原生组件（目录来自站点编译配置） */}
      <div className="md-toolbar__group md-toolbar__group--components">
        <div className="md-toolbar__popover-host">
          {entry('components', '组件', '组件', Blocks, componentsTriggerRef, 'components')}
          {openMenu === 'components' && (
            <ReactiveComponentPicker
              triggerRef={componentsTriggerRef}
              ancestors={componentAncestors}
              onClose={closeMenu}
              onInsert={insertComponent}
            />
          )}
        </div>
      </div>

      {/* 3 / 4. 上传图片 / 插入引用 —— 窄屏首行也保留 */}
      <div className="md-toolbar__group md-toolbar__group--media">
        <button
          type="button"
          className="md-toolbar__btn md-toolbar__btn--entry"
          title="上传图片"
          aria-label="上传图片"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onPickFiles}
        >
          <ImagePlus size={16} strokeWidth={2} aria-hidden="true" />
          <span className="md-toolbar__entry-label">上传图片</span>
          <span className="md-toolbar__entry-short">图片</span>
        </button>
        <button
          type="button"
          className="md-toolbar__btn md-toolbar__btn--entry"
          title="插入引用"
          aria-label="插入引用"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onOpenResources}
        >
          <Library size={16} strokeWidth={2} aria-hidden="true" />
          <span className="md-toolbar__entry-label">插入引用</span>
          <span className="md-toolbar__entry-short">引用</span>
        </button>
      </div>

      <span className="md-toolbar__sep" aria-hidden="true" />

      {/* 撤销 / 重做：独立于内容插入分类；窄屏由样式表收进「更多」菜单 */}
      <div className="md-toolbar__group md-toolbar__group--history">
        <button
          type="button"
          className="md-toolbar__btn"
          title="撤销"
          aria-label="撤销"
          disabled={disabled || !canUndo}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(cmd.undoCommand)}
        >
          <Undo2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="md-toolbar__btn"
          title="重做"
          aria-label="重做"
          disabled={disabled || !canRedo}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(cmd.redoCommand)}
        >
          <Redo2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <span className="md-toolbar__grow" aria-hidden="true" />

      {/* 更多：低频动作（导出 / 打印 / 格式化 / 补全；窄屏还含历史） */}
      <div className="md-toolbar__group md-toolbar__group--more">
        <div className="md-toolbar__popover-host">
          <button
            ref={moreTriggerRef}
            type="button"
            className={`md-toolbar__btn md-toolbar__btn--entry${openMenu === 'more' ? ' is-open' : ''}`}
            title="更多"
            aria-label="更多"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'more'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openWith('more')}
          >
            <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
            <span className="md-toolbar__entry-label">更多</span>
            <span className="md-toolbar__entry-short">更多</span>
          </button>
          {openMenu === 'more' && (
            <div
              ref={menuRef}
              className="md-toolbar__menu md-toolbar__menu--right"
              role="menu"
              aria-label="更多"
              onKeyDown={onMenuKeyDown}
            >
              <MenuButton
                role="menuitem"
                onRun={() => runAndClose(cmd.undoCommand)}
                disabled={disabled || !canUndo}
              >
                <Undo2 size={15} strokeWidth={2} aria-hidden="true" />
                <span className="md-toolbar__menu-label">撤销</span>
              </MenuButton>
              <MenuButton
                role="menuitem"
                onRun={() => runAndClose(cmd.redoCommand)}
                disabled={disabled || !canRedo}
              >
                <Redo2 size={15} strokeWidth={2} aria-hidden="true" />
                <span className="md-toolbar__menu-label">重做</span>
              </MenuButton>
              <MenuButton
                role="menuitem"
                title="导出静态 HTML：正文按初始状态，预览里临时拖动的值不会写入"
                onRun={() => {
                  onExportHtml();
                  closeMenu(false);
                }}
              >
                <FileDown size={15} strokeWidth={2} aria-hidden="true" />
                <span className="md-toolbar__menu-label">导出 HTML</span>
              </MenuButton>
              <MenuButton
                role="menuitem"
                title="打印 / 存为 PDF：正文按初始状态，预览里临时拖动的值不会写入"
                onRun={() => {
                  onPrint();
                  closeMenu(false);
                }}
              >
                <FileDown size={15} strokeWidth={2} aria-hidden="true" />
                <span className="md-toolbar__menu-label">打印 / 存为 PDF</span>
              </MenuButton>
              {onFormat && (
                <MenuButton
                  role="menuitem"
                  onRun={() => {
                    onFormat();
                    closeMenu(false);
                  }}
                  disabled={disabled}
                >
                  <WandSparkles size={15} strokeWidth={2} aria-hidden="true" />
                  <span className="md-toolbar__menu-label">
                    格式化{reactive ? ' Reactive 标签' : ''}
                  </span>
                </MenuButton>
              )}
              {onRequestCompletions && (
                <MenuButton
                  role="menuitem"
                  onRun={() => {
                    onRequestCompletions();
                    closeMenu(false);
                  }}
                  disabled={disabled}
                >
                  <ListFilter size={15} strokeWidth={2} aria-hidden="true" />
                  <span className="md-toolbar__menu-label">补全</span>
                  <span className="md-toolbar__menu-kbd">Ctrl+Space</span>
                </MenuButton>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 视图切换三档的图标与文案（供外壳复用，避免两边各写一份）。 */
export const VIEW_MODES = [
  { key: 'edit' as const, label: '编辑', Icon: Pencil },
  { key: 'split' as const, label: '并排', Icon: Columns2 },
  { key: 'preview' as const, label: '预览', Icon: Eye },
];
