// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-reactive-authoring.test.ts —— 作者工具接在 CM6 上的最小行为
//
// 【为什么用真 EditorView + 假计时器】分析是防抖的、装饰挂在 StateField 上，
// 「回调时机」与「span 上的类名」本身就是被实现的东西。只测纯函数会漏掉
// 「旧文档的计时器没清」「卸载后还回调」这类不报错的错。
//
// 【jsdom 缺布局 API】CodeMirror 只拿 Range#getClientRects / getBoundingClientRect
// 量版面，补两个零尺寸桩子即可（与 reactive-editor-regressions.test.tsx 同口径）。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  applyReactiveCompletion,
  applyReactiveTemplate,
  formatReactiveDocument,
  getReactiveCompletions,
  reactiveAuthoring,
  type AuthorAnalysis,
} from '@/lib/md-editor/reactive-authoring';

if (typeof Range.prototype.getClientRects !== 'function') {
  Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  });
}

let views: EditorView[] = [];

function makeView(
  doc: string,
  options: { anchor?: number; head?: number; extensions?: Extension[] } = {}
): EditorView {
  const anchor = options.anchor ?? 0;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head: options.head ?? anchor },
      extensions: [history(), ...(options.extensions ?? [])],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function destroyView(view: EditorView): void {
  view.destroy();
  views = views.filter((item) => item !== view);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  views = [];
});

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('applyReactiveTemplate', () => {
  it('从中文目录插入模板，选中占位内容，并且一步撤销', () => {
    const view = makeView('');
    expect(applyReactiveTemplate(view, 'card')).toBe(true);

    const text = view.state.doc.toString();
    expect(text).toBe('<card title="内容卡片">\n示例内容\n</card>');
    const start = text.indexOf('示例内容');
    const main = view.state.selection.main;
    expect([main.from, main.to]).toEqual([start, start + '示例内容'.length]);

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('原文已有同名绑定时自动取下一个可用名字', () => {
    const view = makeView('amount', { anchor: 6 });
    expect(applyReactiveTemplate(view, 'slider')).toBe(true);
    expect(view.state.doc.toString()).toContain('<slider bind="amount2"');
  });

  it('插入模板的撤销保留先前的编辑历史', () => {
    const view = makeView('前文', { anchor: 2 });
    view.dispatch({ changes: { from: 2, insert: '追加' }, userEvent: 'input.type' });
    const before = view.state.doc.toString();
    expect(applyReactiveTemplate(view, 'slider')).toBe(true);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('前文');
  });

  it('保留选中的文字（不落回模板占位）', () => {
    const view = makeView('正文', { anchor: 0, head: 2 });
    expect(applyReactiveTemplate(view, 'card')).toBe(true);
    const text = view.state.doc.toString();
    expect(text).toContain('正文');
    expect(text).not.toContain('示例内容');
  });
});

describe('补全', () => {
  it('替换范围覆盖已输入的词尾，不会写出重复字母', () => {
    const view = makeView('<num', { anchor: 4 });
    const number = getReactiveCompletions(view).find((item) => item.label === 'number');
    expect(number).toBeDefined();
    expect(number!.range).toEqual({ start: 1, end: 4 });

    expect(applyReactiveCompletion(view, number!)).toBe(true);
    expect(view.state.doc.toString()).toBe('<number');
    expect(view.state.selection.main.from).toBe(7);
    expect(view.state.selection.main.to).toBe(7);

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('<num');
  });
});

describe('reactiveAuthoring 分析', () => {
  it('按原文 UTF-16 区间交付错误并画出诊断下划线', () => {
    const source = '<input bind="a" label="A" bogus="x">';
    const seen: AuthorAnalysis[] = [];
    const view = makeView(source, {
      extensions: [reactiveAuthoring({ onAnalysis: (analysis) => seen.push(analysis) })],
    });

    vi.advanceTimersByTime(400);
    expect(seen).toHaveLength(1);

    const diagnostic = seen[0].diagnostics.find((item) => item.code === 'local.attribute.unknown');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.range.start).toBe(source.indexOf('bogus'));
    expect(source.slice(diagnostic!.range.start, diagnostic!.range.end)).toBe('bogus');

    const mark = view.dom.querySelector('.cm-reactive-diagnostic--error');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('bogus');
    expect(mark!.getAttribute('title')).toBe(diagnostic!.message);
  });

  it('光标移动不重新分析；改动后旧分析不再回调', () => {
    const seen: AuthorAnalysis[] = [];
    const view = makeView('<input bind="a" label="A">', {
      extensions: [reactiveAuthoring({ onAnalysis: (analysis) => seen.push(analysis) })],
    });
    vi.advanceTimersByTime(400);
    expect(seen).toHaveLength(1);

    view.dispatch({ selection: { anchor: 3 } });
    vi.advanceTimersByTime(400);
    expect(seen).toHaveLength(1);

    view.dispatch({ changes: { from: 25, insert: ' ' } });
    destroyView(view);
    vi.advanceTimersByTime(400);
    expect(seen).toHaveLength(1);
  });
});

describe('formatReactiveDocument', () => {
  it('整理标签空白但不碰围栏代码，且一步撤销', () => {
    const source = [
      '<input   label = "Seats"   bind = \'seats\'  >',
      '',
      '```',
      '<input   label = "code">',
      '```',
    ].join('\n');
    const view = makeView(source);

    expect(formatReactiveDocument(view)).toBe(true);
    const text = view.state.doc.toString();
    expect(text).toContain('<input label="Seats" bind=\'seats\'>');
    expect(text).toContain('```\n<input   label = "code">\n```');

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });
});
