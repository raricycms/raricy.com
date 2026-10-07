'use client';

// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/Toolbar.tsx —— 编辑器的工具条
//
// 【按钮做什么】每一项都直接调用 src/lib/md-editor/commands.ts 里的事务命令 ——
// 工具条自己**不改文档**。这样「点按钮」和「按快捷键」走的是同一条路径，
// 撤销历史里也是同一类记录，不会出现「用按钮加的粗体撤不掉」。
//
// 【与旧工具条的对应】逐项对齐 Vditor 那套，少的是资源面板（M2）：
//   emoji→表情面板  headings→标题菜单  bold/italic/strike  link
//   list/ordered-list/check/outdent/indent   quote/line/code/inline-code
//   math（仅剪贴板）  upload  table  undo/redo  export→导出菜单
//   「preview」不再是按钮，而是右侧的视图切换（编辑 / 并排 / 预览）——
//   旧版那个按钮就是把编辑器切成预览态，语义已被视图切换完整覆盖。
//
// 【表情为什么是 Unicode 而不是站内表情包】站内的表情包 / 黄脸是 `[@合集/名字]`
// token，那套 token **不被博客与剪贴板的终稿展开**（§1.3 明写不在这两处接入）。
// 插进去只会得到一串原文。所以这里给的是普通 Unicode 字符：它就是文本，
// 任何管线都当文本渲染，也正是旧工具条 emoji 按钮实际做的事。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import {
  Bold,
  Code,
  Columns2,
  Eye,
  FileDown,
  Heading,
  ImagePlus,
  Indent,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
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
  onExportHtml,
  onPrint,
  withMath,
}: ToolbarProps) {
  const [headingOpen, setHeadingOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
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

  const btn = (
    label: string,
    Icon: typeof Bold,
    action: () => void,
    enabled = true
  ) => (
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
    <div className="md-toolbar" role="toolbar" aria-label="编辑器工具条">
      <div className="md-toolbar__group">
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

      <div className="md-toolbar__group">
        {btn('无序列表', List, () => run(cmd.toggleBulletList))}
        {btn('有序列表', ListOrdered, () => run(cmd.toggleOrderedList))}
        {btn('任务列表', ListChecks, () => run(cmd.toggleTaskList))}
        {btn('减少缩进', Outdent, () => run(cmd.shiftIndent(true)))}
        {btn('增加缩进', Indent, () => run(cmd.shiftIndent(false)))}
      </div>

      <span className="md-toolbar__sep" aria-hidden="true" />

      <div className="md-toolbar__group">
        {btn('引用', Quote, () => run(cmd.toggleQuote))}
        {btn('分隔线', Minus, () => run(cmd.insertHorizontalRule()))}
        {btn('代码块', SquareCode, () => run(cmd.insertCodeBlock()))}
        {btn('行内代码', Code, () => run(cmd.toggleWrap('`', 'code')))}
        {withMath && btn('公式', Sigma, () => run(cmd.insertMathBlock()))}
        {btn('上传图片', ImagePlus, onPickFiles)}
        {btn('表格', Table, () => run(cmd.insertTable()))}
      </div>

      <span className="md-toolbar__sep" aria-hidden="true" />

      <div className="md-toolbar__group">
        {btn('撤销', Undo2, () => run(cmd.undoCommand), canUndo)}
        {btn('重做', Redo2, () => run(cmd.redoCommand), canRedo)}
      </div>

      <span className="md-toolbar__grow" aria-hidden="true" />

      <div className="md-toolbar__group">
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
