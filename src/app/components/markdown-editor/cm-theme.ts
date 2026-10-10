// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/cm-theme.ts —— CM6 的外观扩展
//
// 【主题跟随不用 MutationObserver —— 全程走站点 CSS 变量】
// 只要配色烘在某个第三方样式表里，切主题就得盯三条轨道（外壳类名 / 正文 css /
// 代码高亮 link）并监听 `data-theme`，三处漏一处就是「半亮半暗」而无人报错。
// 这里所有颜色都写成 `var(--color-…)`：站点切主题时 `:root` 上的变量一变，
// 编辑器（它与页面在同一个文档树里）**当帧就跟着变**，没有中间态、没有异步、
// 也不会出现「类名换了但样式没跟」的那种半死状态。少一条轨道就少一处静默失败。
//
// 唯一需要留意的是写错的变量名 —— `var(--x)` 不存在时整条声明**静默失效**，
// 不报错、不警告（frontend-styles.md 记着这条已经踩过六次）。下面用到的变量都在
// base/_root.scss 里有定义，加新变量前先去那边确认。
// ─────────────────────────────────────────────────────────────────────────────

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * 编辑器外壳。字号 / 行高刻意与正文的阅读排版接近：源码里怎么断行，与预览里断得
 * 像不像，直接决定「我在这里看到的换行是不是真换行」。
 */
export const editorTheme = EditorView.theme({
  '&': {
    fontSize: '0.95rem',
    color: 'var(--color-text-primary)',
    backgroundColor: 'var(--color-background-page)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.7',
  },
  '.cm-content': {
    // 当前使用原生光标；只设 .cm-cursor 不会覆盖 CM6 默认的黑色 caret。
    caretColor: 'var(--color-brand-primary)',
    // 底部留白比顶部大：写作时视线在下方，最后一行贴着边框很难受
    padding: '12px 16px 40px',
    // 长行折行（EditorView.lineWrapping）配上这个才不会在行尾露出半截字符
    overflowWrap: 'break-word',
  },
  '.cm-line': { padding: '0' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-background-subtle)',
    color: 'var(--color-text-secondary)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-background-subtle)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-background-subtle)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--color-brand-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand-primary) 40%, var(--color-background-page))',
  },
  '.cm-content ::selection, .cm-content::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand-primary) 40%, var(--color-background-page))',
    // 选中时统一文字色，避免标题 / 链接的蓝字融进蓝色选区。
    color: 'var(--color-text-primary)',
  },
  // 编辑器自身也要能给到聚焦反馈 —— 与全站字段同一条令牌（见 frontend-styles.md：
  // 聚焦一律用这个光晕，绝不改 border，否则字段会随焦点变高、下方内容跟着位移）
  '&.cm-editor.cm-focused': { boxShadow: 'var(--shadow-focus-brand)' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'var(--color-background-content)',
  },
});

/**
 * Markdown 语法高亮。
 *
 * 【只给「结构性」的记号上色】标题、强调、行内代码、链接、引用、列表记号 ——
 * 都是「这段在 Markdown 里有特殊含义」的地方。正文本身保持默认前景色：源码编辑
 * 模式下满屏花色的代码会让「读自己写的话」变难，而这里的主要工作恰恰是写字。
 */
export const markdownHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, color: 'var(--color-brand-primary)', fontWeight: 'bold' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--color-brand-primary)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--color-text-secondary)' },
    { tag: tags.monospace, color: 'var(--color-accent-amber)' },
    { tag: tags.quote, color: 'var(--color-text-secondary)', fontStyle: 'italic' },
    // tags.list 覆盖整段列表内容，正文用主文字色；列表记号由 processingInstruction 单独弱化。
    { tag: tags.list, color: 'var(--color-text-primary)' },
    { tag: tags.contentSeparator, color: 'var(--color-text-secondary)' },
    // 记号的颜色比正文淡一档：`##` `**` `>` 是脚手架，不该跟内容抢注意力
    { tag: tags.processingInstruction, color: 'var(--color-text-secondary)' },
  ])
);

/** 编辑器共用的基础扩展（与具体表单无关的那一份）。 */
export const editorBaseTheme = [editorTheme, markdownHighlightStyle];
