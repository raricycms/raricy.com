'use client';

// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/Toolbar.tsx —— 编辑器的工具条
//
// 【按钮做什么】每一项都直接调用 src/lib/md-editor/commands.ts 里的事务命令 ——
// 工具条自己**不改文档**。这样「点按钮」和「按快捷键」走的是同一条路径，
// 撤销历史里也是同一类记录，不会出现「用按钮加的粗体撤不掉」。
//
// 【按钮清单】emoji→表情面板  headings→标题菜单  bold/italic/strike  link
//   list/ordered-list/check/outdent/indent   quote/line/code/inline-code
//   math（仅剪贴板）  upload  table  undo/redo  export→导出菜单
//   library→「插入引用」资源面板（图床 / 音频 / 剪贴板 / 投票 / 收藏夹）
// 「preview」不是按钮，而是右侧的视图切换（编辑 / 并排 / 预览）—— 预览态本身
// 就覆盖了「把编辑器切成预览看」这件事，不必再占一颗按钮。
//
// 【窄屏只留三件事 + 「更多」】手机上一整排图标既挤不进一行、又要点准 ——
// 390px 上 16 颗 28px 的按钮要占三行，编辑区被挤矮。所以窄屏默认只留
// **表情 / 上传图片 / 插入引用** 三颗核心动作，加一颗「更多工具」把其余
// （标题、格式、列表、引用块、代码、公式、表格、撤销重做、导出）收进去，
// **一行放得下**（宽屏工具条一字不动，只是那颗「更多」由样式表整个藏掉）。
//
// 两件事都只由样式表做，组件里**不写 matchMedia**：
//   · 每一颗按钮、每一个分组都只有**一份 DOM**（不是「宽屏一套、窄屏一套」）——
//     两份 DOM 会让定位、菜单、选区各自认到不同的那一个；
//   · 窄屏分支靠 CSS（`@media (max-width: 767px)` + `data-more`）切换，跟
//     MarkdownEditor 的「并排」按钮同理：JS 侧过滤会先渲染后收起，闪一下，
//     且服务端渲染的结果与客户端首帧不一致。
// 「更多」是**内联展开**（分组直接显示出来、工具条自己长高），不是浮层 ——
// 浮层在窄屏要么被视口裁掉、要么盖住编辑区，而分组本身是 flex 换行，天生不会溢出。
// 展开后**不自动收起**：连点几颗格式按钮是常态，收起留给用户自己按同一个按钮
//（图标此时翻成向上箭头）。
//
// ⚠️ **收起的粒度是分组，所以「哪几颗归哪一组」有实际后果**：窄屏留在首行的
// 分组必须整组都是核心动作。反例是「表格」—— 它语义上属于 media，但窄屏是次要的；
// 留在 media 里的话，它跟着那一档展开时会把排在后面的「更多」开关挤着往右挪，
// 用户按完第一下得重新瞄准才按得到第二下。所以它自成一档（`--table`），
// 宽屏上仍紧挨着「插入引用」、与拆分前逐像素一致。
//
// 【表情为什么是 Unicode 而不是站内表情包】站内的表情包 / 黄脸是 `[@合集/名字]`
// token，那套 token **不被博客与剪贴板的终稿展开**（§1.3 明写不在这两处接入）。
// 插进去只会得到一串原文。所以这里给的是普通 Unicode 字符：它就是文本，
// 任何管线都当文本渲染，也正是旧工具条 emoji 按钮实际做的事。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import {
  Bold,
  ChevronUp,
  Code,
  Columns2,
  Eye,
  FileDown,
  Heading,
  ImagePlus,
  Indent,
  Italic,
  Library,
  Link as LinkIcon,
  List,
  ListChecks,
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
} from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import { redoDepth, undoDepth } from '@codemirror/commands';
import * as cmd from '@/lib/md-editor/commands';

/** 表情面板里的字符 —— 常用的一组，够写日常文章即可（不做搜索，不做分页）。 */
const EMOJI = [
  '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉',
  '😊', '😍', '😘', '😜', '🤔', '😐', '😴', '😢',
  '😭', '😤', '😱', '🥳', '🤯', '😇', '🙃', '😎',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '👌',
  '❤️', '💔', '✨', '🔥', '🎉', '🎁', '⭐', '💡',
  '✅', '❌', '⚠️', '❓', '❗', '📌', '📎', '🔗',
  '🚀', '🐟', '🌱', '🌈', '☀️', '🌙', '☕', '🍜',
].join('');

const HEADINGS = [
  { level: 0, label: '正文' },
  { level: 1, label: '标题 1' },
  { level: 2, label: '标题 2' },
  { level: 3, label: '标题 3' },
  { level: 4, label: '标题 4' },
  { level: 5, label: '标题 5' },
  { level: 6, label: '标题 6' },
];

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
}

/** 点外面或按 Esc 关掉的小浮层。 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

export default function Toolbar({
  view,
  onPickFiles,
  onOpenResources,
  onExportHtml,
  onPrint,
  withMath,
}: ToolbarProps) {
  const [headingOpen, setHeadingOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /** 窄屏的「更多工具」是否展开（宽屏那颗按钮整个不显示，这个状态也就不参与）。 */
  const [moreOpen, setMoreOpen] = useState(false);
  const headingRef = useDismiss(headingOpen, () => setHeadingOpen(false));
  const emojiRef = useDismiss(emojiOpen, () => setEmojiOpen(false));
  const exportRef = useDismiss(exportOpen, () => setExportOpen(false));

  const disabled = !view;
  // 撤销 / 重做的可用态每次都按当前 state 现算。外壳把正文存在 state 里
  // （字数统计要用），所以每次改动都会重渲染到这里，读数不会是旧的。
  const canUndo = !!view && undoDepth(view.state) > 0;
  const canRedo = !!view && redoDepth(view.state) > 0;

  /** 跑一条命令：先聚焦（点按钮时焦点在按钮上），再 dispatch。 */
  function run(command: cmd.EditorCommand) {
    if (!view) return;
    view.focus();
    command(view);
  }

  function insert(text: string) {
    run(cmd.insertText(text));
  }

  const btn = (label: string, Icon: typeof Bold, action: () => void, enabled = true) => (
    <button
      type="button"
      className="md-toolbar__btn"
      title={label}
      aria-label={label}
      disabled={disabled || !enabled}
      // 用 onMouseDown 而不是 onClick：按下时焦点还没被按钮拿走，
      // 编辑区里的选区因此不会被清掉（点工具条时最容易丢的就是这个选区）
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  return (
    // data-more 是窄屏的展开开关（见文件头）：样式表按它决定要不要把次要分组
    // 显示出来。宽屏读到它也不做任何事 —— 那边所有分组本来就都在。
    <div
      className="md-toolbar"
      role="toolbar"
      aria-label="编辑器工具条"
      data-more={moreOpen ? 'open' : 'closed'}
    >
      {/* 核心动作之一：表情。单独一组，窄屏靠分组顺序排到首行第一个。 */}
      <div className="md-toolbar__group md-toolbar__group--core">
        <div className="md-toolbar__popover-host" ref={emojiRef}>
          {btn('表情', Smile, () => setEmojiOpen((v) => !v))}
          {emojiOpen && (
            <div className="md-toolbar__menu md-toolbar__menu--emoji" role="menu">
              {Array.from(EMOJI).map((ch, i) => (
                <button
                  key={`${ch}-${i}`}
                  type="button"
                  className="md-toolbar__emoji"
                  role="menuitem"
                  aria-label={`插入表情 ${ch}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    insert(ch);
                    setEmojiOpen(false);
                  }}
                >
                  {ch}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 窄屏的「更多工具」开关。宽屏由 `.md-toolbar__group--more` 整个藏掉；
          窄屏永远在首行、且**位置固定**（不随展开与否移动）。 */}
      <div className="md-toolbar__group md-toolbar__group--more">
        <button
          type="button"
          // 只挂基类：这里不需要额外的命名钩子 —— e2e 按可访问名（「更多工具」）定位，
          // 而 css-tsx-classes 守卫要求每个写进 JSX 的类名都有对应规则，不定义就别写。
          className="md-toolbar__btn"
          title="更多工具"
          // 可访问名固定为「更多工具」，状态由 aria-expanded 交代 ——
          // 名字随开关变的话，读屏与自动化都得再猜一次「现在是什么状态」。
          aria-label="更多工具"
          aria-expanded={moreOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMoreOpen((v) => !v)}
        >
          {/* 图标翻转交代状态：收起时是「…」（还有东西），展开时是向上箭头（按一下收回去） */}
          {moreOpen ? (
            <ChevronUp size={16} strokeWidth={2} aria-hidden="true" />
          ) : (
            <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="md-toolbar__group md-toolbar__group--format">
        <div className="md-toolbar__popover-host" ref={headingRef}>
          {btn('标题', Heading, () => setHeadingOpen((v) => !v))}
          {headingOpen && (
            <div className="md-toolbar__menu" role="menu">
              {HEADINGS.map((h) => (
                <button
                  key={h.level}
                  type="button"
                  className="md-toolbar__menu-item"
                  role="menuitem"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    run(cmd.setHeading(h.level));
                    setHeadingOpen(false);
                  }}
                >
                  {h.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {btn('粗体', Bold, () => run(cmd.toggleWrap('**', '粗体')))}
        {btn('斜体', Italic, () => run(cmd.toggleWrap('*', '斜体')))}
        {btn('删除线', Strikethrough, () => run(cmd.toggleWrap('~~', '删除线')))}
        {btn('链接', LinkIcon, () => run(cmd.insertLink()))}
      </div>

      <span className="md-toolbar__sep" aria-hidden="true" />

      <div className="md-toolbar__group md-toolbar__group--lists">
        {btn('无序列表', List, () => run(cmd.toggleBulletList))}
        {btn('有序列表', ListOrdered, () => run(cmd.toggleOrderedList))}
        {btn('任务列表', ListChecks, () => run(cmd.toggleTaskList))}
        {btn('减少缩进', Outdent, () => run(cmd.shiftIndent(true)))}
        {btn('增加缩进', Indent, () => run(cmd.shiftIndent(false)))}
      </div>

      <span className="md-toolbar__sep" aria-hidden="true" />

      <div className="md-toolbar__group md-toolbar__group--blocks">
        {btn('引用', Quote, () => run(cmd.toggleQuote))}
        {btn('分隔线', Minus, () => run(cmd.insertHorizontalRule()))}
        {btn('代码块', SquareCode, () => run(cmd.insertCodeBlock()))}
        {btn('行内代码', Code, () => run(cmd.toggleWrap('`', 'code')))}
        {withMath && btn('公式', Sigma, () => run(cmd.insertMathBlock()))}
      </div>

      {/* 上传图片 / 插入引用 是窄屏首行的另外两件事，所以它们自成一档、且
          **中间不插分隔线**（宽屏上原样挨着，与拆分前逐像素一致）。 */}
      <div className="md-toolbar__group md-toolbar__group--media">
        {btn('上传图片', ImagePlus, onPickFiles)}
        {/* 五类资源一个入口（图床 / 音频 / 剪贴板 / 投票 / 收藏夹）——
            「上传图片」是**新传一张**，这里是**挑已有的**，两者不重叠。 */}
        {btn('插入引用', Library, onOpenResources)}
      </div>

      {/* 表格：宽屏上它紧挨着「插入引用」（这一组的 DOM 位置就在 media 之后，
          两处间距都是 2px，与拆分前逐像素一致），窄屏则收进「更多」。
          ⚠️ **它必须自成一档，不能留在 `--media` 里**：那一档窄屏留在首行，而
          「更多」那颗开关排在它后面 —— 表格若跟着那一档展开，就会把开关**挤着
          往右挪**（实测 42px = 一颗按钮），用户按完第一下要重新瞄准才按得到第二下。
          自成一组后开关的位置与「更多里有什么」完全无关。 */}
      <div className="md-toolbar__group md-toolbar__group--table">
        {btn('表格', Table, () => run(cmd.insertTable()))}
      </div>

      <span className="md-toolbar__sep" aria-hidden="true" />

      <div className="md-toolbar__group md-toolbar__group--history">
        {btn('撤销', Undo2, () => run(cmd.undoCommand), canUndo)}
        {btn('重做', Redo2, () => run(cmd.redoCommand), canRedo)}
      </div>

      <span className="md-toolbar__grow" aria-hidden="true" />

      <div className="md-toolbar__group md-toolbar__group--export">
        <div className="md-toolbar__popover-host" ref={exportRef}>
          {btn('导出', FileDown, () => setExportOpen((v) => !v))}
          {exportOpen && (
            <div className="md-toolbar__menu md-toolbar__menu--right" role="menu">
              <button
                type="button"
                className="md-toolbar__menu-item"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onExportHtml();
                  setExportOpen(false);
                }}
              >
                导出 HTML
              </button>
              <button
                type="button"
                className="md-toolbar__menu-item"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPrint();
                  setExportOpen(false);
                }}
              >
                打印 / 存为 PDF
              </button>
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
