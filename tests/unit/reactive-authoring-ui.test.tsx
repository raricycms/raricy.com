// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// reactive-authoring-ui.test.tsx —— Reactive 作者工具的三条静默边界
//
//   1. **格式门控**：作者工具只能活在 `format === 'reactive'`。Markdown 模式下
//      多出按钮 / 面板不报错，但会把「普通 Markdown」误认成另一种语言。
//   2. **切换格式不重建 EditorState**：用 Compartment 热替换，撤销历史与正文要
//      留在原地。重建也让页面看起来正常，只是历史没了。
//   3. **动作真的转发到 B 的接口**：挑组件 → `applyReactiveTemplate`；
//      点诊断 → `revealReactiveDiagnostic`；补全 → `applyReactiveCompletion`；
//      格式化 → `formatReactiveDocument`。UI 自己重写一份就等于两套行为。
//
// 【环境】jsdom + react-dom/client + React 19 的 act（仓库没有 testing-library）。
// CodeMirror 量版面要的 Range 方法在 jsdom 里缺，补两个零尺寸桩子即可。
// ─────────────────────────────────────────────────────────────────────────────

import {
  act,
  createElement,
  useState,
  type ComponentProps,
  type ReactElement,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import type { ContentFormat } from '@/lib/content-format';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof Range.prototype.getClientRects !== 'function') {
  Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  });
}

// ── 类型（只在本文件用，不 import B 的实现文件）──────────────────────────────
interface DiagnosticLike {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  range: { start: number; end: number };
  line: number;
  column: number;
}
interface AnalysisLike {
  tokens: unknown[];
  bindings: unknown[];
  diagnostics: DiagnosticLike[];
}
interface CompletionLike {
  label: string;
  insertText: string;
  range: { start: number; end: number };
  kind: 'tag' | 'attribute' | 'binding' | 'value';
  detail?: string;
}
interface AuthoringOptions {
  onAnalysis: (analysis: AnalysisLike) => void;
  onCompletions?: (items: CompletionLike[]) => void;
}

// ── 替身 ─────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const catalog = {
    groups: [
      { id: 'input', label: '输入' },
      { id: 'data', label: '数据' },
    ],
    components: [
      {
        id: 'slider',
        label: '滑块',
        description: '拖动选择一个数字',
        group: 'input',
        keywords: ['slider', '滑块', '范围'],
        template: '',
      },
      {
        id: 'chart',
        label: '图表',
        description: '把表格画成图',
        group: 'data',
        keywords: ['chart', '图表'],
        template: '',
      },
    ],
  };

  return {
    catalog,
    reactiveAuthoring: vi.fn((_options: AuthoringOptions) => [] as unknown[]),
    applyReactiveTemplate: vi.fn(() => true),
    getReactiveCompletions: vi.fn((): CompletionLike[] => []),
    applyReactiveCompletion: vi.fn((_view: EditorView, _item: CompletionLike) => true),
    formatReactiveDocument: vi.fn(() => true),
    revealReactiveDiagnostic: vi.fn(),
  };
});

vi.mock('reactive-md', () => ({
  formatLocalDiagnostic: (diagnostic: { message: string }) => `译:${diagnostic.message}`,
}));

vi.mock('reactive-md/authoring', () => ({
  getNativeComponentCatalog: () => mocks.catalog,
}));

vi.mock('@/lib/md-editor/reactive-authoring', () => ({
  reactiveAuthoring: mocks.reactiveAuthoring,
  applyReactiveTemplate: mocks.applyReactiveTemplate,
  getReactiveCompletions: mocks.getReactiveCompletions,
  applyReactiveCompletion: mocks.applyReactiveCompletion,
  formatReactiveDocument: mocks.formatReactiveDocument,
  revealReactiveDiagnostic: mocks.revealReactiveDiagnostic,
}));

// 预览 / 导出不是本文件的主题，替成空壳；否则它们会把真实渲染管线拖进来。
vi.mock('@/app/components/markdown-editor/export', () => ({
  REACTIVE_EXPORT_NOTE: '',
  absolutizeSiteUrls: vi.fn(),
  buildExportHtml: vi.fn(() => ''),
  downloadHtml: vi.fn(),
  localizeFragmentLinks: vi.fn(),
  printHtml: vi.fn(),
  renderStaticMarkup: vi.fn(async () => ''),
  safeFilename: vi.fn((value: string) => value),
  stripInteractiveShells: vi.fn(),
}));
vi.mock('@/app/components/reactive/ReactivePreview', () => ({ default: () => null }));
vi.mock('@/app/components/MarkdownRenderer', () => ({ default: () => null }));
vi.mock('@/app/components/markdown-editor/ResourcePanel', () => ({ default: () => null }));

import Toolbar from '@/app/components/markdown-editor/Toolbar';
import MarkdownEditor from '@/app/components/MarkdownEditor';

// ── 挂载工具 ─────────────────────────────────────────────────────────────────
const mounted: { root: Root; container: HTMLElement }[] = [];

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  const target = container.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`找不到 ${selector}`);
  await act(async () => {
    target.click();
  });
}

function stubView(doc = '正文'): EditorView {
  return {
    state: EditorState.create({ doc }),
    focus: vi.fn(),
  } as unknown as EditorView;
}

function toolbarProps(
  overrides: Partial<ComponentProps<typeof Toolbar>> = {}
): ComponentProps<typeof Toolbar> {
  return {
    view: stubView(),
    onPickFiles: vi.fn(),
    onOpenResources: vi.fn(),
    onExportHtml: vi.fn(),
    onPrint: vi.fn(),
    withMath: false,
    ...overrides,
  } as ComponentProps<typeof Toolbar>;
}

beforeEach(() => {
  mocks.reactiveAuthoring.mockClear();
  mocks.applyReactiveTemplate.mockClear();
  mocks.getReactiveCompletions.mockClear();
  mocks.applyReactiveCompletion.mockClear();
  mocks.formatReactiveDocument.mockClear();
  mocks.revealReactiveDiagnostic.mockClear();
  mocks.reactiveAuthoring.mockImplementation(() => []);
  mocks.getReactiveCompletions.mockReturnValue([]);
  mocks.applyReactiveCompletion.mockReturnValue(true);
  mocks.formatReactiveDocument.mockReturnValue(true);
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  document.body.innerHTML = '';
});

function lastAuthoringOptions(): AuthoringOptions {
  const calls = mocks.reactiveAuthoring.mock.calls;
  const options = calls[calls.length - 1]?.[0];
  if (!options) throw new Error('reactiveAuthoring 从未被调用');
  return options;
}

const ANALYSIS: AnalysisLike = {
  tokens: [],
  bindings: [],
  diagnostics: [
    {
      code: 'component.unknown',
      message: '未知组件 <slidr>',
      severity: 'error',
      range: { start: 2, end: 8 },
      line: 2,
      column: 3,
    },
    {
      code: 'footnote.unsupported',
      message: '脚注按原文显示',
      severity: 'warning',
      range: { start: 20, end: 24 },
      line: 4,
      column: 1,
    },
  ],
};

const COMPLETIONS: CompletionLike[] = [
  {
    label: 'slider',
    insertText: '<slider>',
    range: { start: 0, end: 3 },
    kind: 'tag',
    detail: '滑块',
  },
  {
    label: 'chart',
    insertText: '<chart>',
    range: { start: 0, end: 3 },
    kind: 'tag',
    detail: '图表',
  },
];

// ── 1. 格式门控 + 组件挑选 ───────────────────────────────────────────────────

describe('Toolbar：只有 Reactive 才渲染作者入口', () => {
  it('Markdown 模式没有「插入组件 / 补全 / 格式化」', () => {
    const container = mount(createElement(Toolbar, toolbarProps({ reactive: false })));
    expect(container.querySelector('[aria-label="插入组件"]')).toBeNull();
    expect(container.querySelector('[aria-label="补全"]')).toBeNull();
    expect(container.querySelector('[aria-label="格式化"]')).toBeNull();
  });

  it('Reactive 模式三颗入口都在', () => {
    const container = mount(createElement(Toolbar, toolbarProps({ reactive: true })));
    expect(container.querySelector('[aria-label="插入组件"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="补全"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="格式化"]')).not.toBeNull();
  });
});

describe('组件挑选：搜索、分组、插入与焦点返回', () => {
  it('打开后搜索框获得焦点；按中文筛选后点击一次事务插入', async () => {
    const view = stubView();
    const container = mount(
      createElement(Toolbar, toolbarProps({ reactive: true, view }))
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="插入组件"]')!;
    await act(async () => trigger.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索组件"]')!;
    expect(document.activeElement).toBe(input);

    // 目录里的 group 标题在（来自 getNativeComponentCatalog('zh')）
    expect(container.textContent).toContain('输入');
    expect(container.textContent).toContain('数据');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '图表');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const items = container.querySelectorAll('.md-component-picker__item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('图表');

    await act(async () => (items[0] as HTMLButtonElement).click());

    expect(mocks.applyReactiveTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.applyReactiveTemplate).toHaveBeenCalledWith(view, 'chart');
    expect(view.focus).toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Esc 关闭面板并把焦点还给触发按钮', async () => {
    const container = mount(createElement(Toolbar, toolbarProps({ reactive: true })));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="插入组件"]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.applyReactiveTemplate).not.toHaveBeenCalled();
  });
});

// ── 2. MarkdownEditor 集成 ───────────────────────────────────────────────────

let setFormat: (format: ContentFormat) => void = () => {};

function EditorHarness({ initialFormat }: { initialFormat: ContentFormat }) {
  const [format, setCurrentFormat] = useState<ContentFormat>(initialFormat);
  setFormat = setCurrentFormat;
  return createElement(MarkdownEditor, {
    initialValue: '# 标题\n\n正文',
    format,
  });
}

describe('MarkdownEditor：Reactive 分析 / 诊断 / 补全 / 格式化', () => {
  it('初始加载就启用扩展并显示计数；诊断可点击定位', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    expect(mocks.reactiveAuthoring).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.md-authoring')).not.toBeNull();

    const options = lastAuthoringOptions();
    await act(async () => options.onAnalysis(ANALYSIS));

    expect(container.textContent).toContain('错误 1');
    expect(container.textContent).toContain('警告 1');
    // 优先 formatLocalDiagnostic(d, 'zh')
    expect(container.textContent).toContain('译:未知组件 <slidr>');
    expect(container.textContent).toContain('第 2 行 3 列');

    await click(container, '.md-authoring__diagnostic');
    expect(mocks.revealReactiveDiagnostic).toHaveBeenCalledTimes(1);
    const [view, diagnostic] = mocks.revealReactiveDiagnostic.mock.calls[0];
    expect((view as EditorView).state).toBeTruthy();
    expect(diagnostic).toBe(ANALYSIS.diagnostics[0]);
  });

  it('补全：扩展回调与工具条按钮都能出候选，选中后调用 applyReactiveCompletion', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    const options = lastAuthoringOptions();

    await act(async () => options.onCompletions?.(COMPLETIONS));
    expect(container.querySelectorAll('.md-authoring__completion')).toHaveLength(2);
    expect(container.textContent).toContain('滑块');

    await click(container, '.md-authoring__completion');
    expect(mocks.applyReactiveCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.applyReactiveCompletion.mock.calls[0][1]).toBe(COMPLETIONS[0]);
    // 选中后面板收起
    expect(container.querySelector('.md-authoring__completions')).toBeNull();

    // 工具条「补全」走 getReactiveCompletions
    mocks.getReactiveCompletions.mockReturnValue([COMPLETIONS[1]]);
    await click(container, '[aria-label="补全"]');
    expect(mocks.getReactiveCompletions).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.md-authoring__completion')).toHaveLength(1);
    expect(container.textContent).toContain('图表');
  });

  it('源码变化时立即丢弃旧候选和诊断，避免把旧范围应用到新正文', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    const options = lastAuthoringOptions();
    await act(async () => {
      options.onAnalysis(ANALYSIS);
      options.onCompletions?.(COMPLETIONS);
    });
    expect(container.querySelector('.md-authoring__completions')).not.toBeNull();
    const view = EditorView.findFromDOM(container.querySelector('.cm-content')!)!;
    act(() => view.dispatch({ changes: { from: 0, insert: '新' } }));
    expect(container.querySelector('.md-authoring__completions')).toBeNull();
    expect(container.querySelector('.md-authoring__diagnostic')).toBeNull();
    expect(mocks.applyReactiveCompletion).not.toHaveBeenCalled();
  });

  it('没有候选时明确提示，而不是空白面板', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    await click(container, '[aria-label="补全"]');
    expect(container.textContent).toContain('当前位置没有补全建议。');
  });

  it('格式化按钮调用 formatReactiveDocument 并给出结果', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    await click(container, '[aria-label="格式化"]');
    expect(mocks.formatReactiveDocument).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('已格式化');

    mocks.formatReactiveDocument.mockReturnValue(false);
    await click(container, '[aria-label="格式化"]');
    expect(container.textContent).toContain('没有需要格式化的内容');
  });

  it('Markdown 模式不启用扩展、不显示面板', () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'markdown' }));
    expect(mocks.reactiveAuthoring).not.toHaveBeenCalled();
    expect(container.querySelector('.md-authoring')).toBeNull();
    expect(container.querySelector('[aria-label="插入组件"]')).toBeNull();
  });
});

// ── 3. 格式切换：热替换，不重建 EditorState ──────────────────────────────────

describe('格式切换：Compartment 热替换，正文与 DOM 原地不动', () => {
  it('reactive → markdown → reactive 不重建编辑区，分析状态被清空', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    const options = lastAuthoringOptions();
    await act(async () => options.onAnalysis(ANALYSIS));
    expect(container.textContent).toContain('错误 1');

    const contentBefore = container.querySelector('.cm-content');
    expect(contentBefore).not.toBeNull();
    expect(contentBefore!.textContent).toContain('正文');

    await act(async () => setFormat('markdown'));

    // 扩展被取下来、作者面板与入口退场
    expect(container.querySelector('.md-authoring')).toBeNull();
    expect(container.querySelector('[aria-label="插入组件"]')).toBeNull();
    expect(mocks.reactiveAuthoring).toHaveBeenCalledTimes(1);

    // 同一个 .cm-content 节点 = 没有重建 EditorState（重建会换掉整个 DOM）
    expect(container.querySelector('.cm-content')).toBe(contentBefore);
    expect(contentBefore!.textContent).toContain('# 标题');

    // 切回来：重新装扩展；旧分析不得复活
    await act(async () => setFormat('reactive'));
    expect(mocks.reactiveAuthoring).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.md-authoring')).not.toBeNull();
    expect(container.textContent).toContain('错误 0');
    expect(container.textContent).not.toContain('译:未知组件 <slidr>');
    expect(container.querySelector('.cm-content')).toBe(contentBefore);
  });
});
