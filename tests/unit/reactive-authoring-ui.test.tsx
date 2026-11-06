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
  createRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type RefObject,
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
interface MockDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
  range: { start: number; end: number };
}

/** 分析结果的替身形状；author / fallback / mode 是后端合并后才会出现的可选字段。 */
interface MockAnalysisResult {
  effective: string;
  valid: boolean;
  publishable: boolean;
  evidence: string[];
  candidates: string[];
  codes: string[];
  diagnostics: MockDiagnostic[];
  declaredVersion: string | null;
  syntaxVersion: string | null;
  author?: unknown;
  fallback?: boolean;
  mode?: string;
}

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
    /** prepareSubmit 用的分析结果（每个用例可改）。 */
    analyzeResult: {
      effective: 'markdown' as string,
      valid: true,
      publishable: true,
      evidence: [] as string[],
      candidates: [] as string[],
      codes: [] as string[],
      diagnostics: [] as MockDiagnostic[],
      declaredVersion: null as string | null,
      syntaxVersion: null as string | null,
    } as MockAnalysisResult,
    /** 需要手动控制 resolve 时序的用例覆盖它。 */
    analyzeImpl: null as null | ((source: string, revision: number) => Promise<unknown>),
    /** 新建分析器时收到的选项（测 worker → fallback 的 UI 提示）。 */
    analyzerOptions: null as null | {
      onModeChange?: (mode: 'worker' | 'fallback' | 'unknown', detail?: string) => void;
    },
    applyReactiveAuthorAnalysis: vi.fn(),
    clearReactiveAuthorAnalysis: vi.fn(),
    /** 预览收到的 props（验证 format 真的传下去，而不是只接了类型）。 */
    previewProps: null as null | Record<string, unknown>,
  };
});

vi.mock('reactive-md', () => ({
  formatLocalDiagnostic: (diagnostic: { message: string }) => `译:${diagnostic.message}`,
}));

vi.mock('reactive-md/authoring', () => ({
  // Toolbar 打开「格式」菜单时会读一次当前格式状态（标题 / 列表 / 引用高亮）。
  readFormatState: () => ({
    headingLevel: 0,
    bold: false,
    italic: false,
    strike: false,
    inlineCode: false,
    list: null,
    quote: false,
  }),
}));

vi.mock('@/lib/md-editor/reactive-authoring', () => {
  const groups = [
    {
      id: 'input',
      label: '输入',
      entries: [
        {
          id: 'slider',
          title: '滑块',
          description: '拖动选择一个数字',
          category: 'input',
          categoryLabel: '输入',
          inline: false,
          paired: true,
          keywords: ['slider', '滑块', '范围'],
          help: '拖动选择一个数字',
        },
      ],
    },
    {
      id: 'data',
      label: '数据',
      entries: [
        {
          id: 'chart',
          title: '图表',
          description: '把表格画成图',
          category: 'data',
          categoryLabel: '数据',
          inline: false,
          paired: true,
          keywords: ['chart', '图表'],
          help: '把表格画成图',
        },
      ],
    },
  ];
  return {
    // 真实常量：MarkdownEditor 的补全 / 格式化上限直接读它；缺这个导出会让
    // 工具条事件在 vitest 的 mock 代理里抛「No export is defined」并让断言假红。
    AUTHOR_TOOL_LENGTH_LIMIT: 50_000,
    reactiveAuthoring: mocks.reactiveAuthoring,
    applyReactiveTemplate: mocks.applyReactiveTemplate,
    getReactiveCompletions: mocks.getReactiveCompletions,
    applyReactiveCompletion: mocks.applyReactiveCompletion,
    formatReactiveDocument: mocks.formatReactiveDocument,
    revealReactiveDiagnostic: mocks.revealReactiveDiagnostic,
    applyReactiveAuthorAnalysis: mocks.applyReactiveAuthorAnalysis,
    clearReactiveAuthorAnalysis: mocks.clearReactiveAuthorAnalysis,
    getComponentAncestors: vi.fn(() => []),
    getSiteComponentCatalog: () => groups,
    filterSiteComponents: (query: string) => {
      const term = query.trim().toLowerCase();
      if (!term) return groups;
      return groups
        .map((group) => ({
          ...group,
          entries: group.entries.filter((entry) =>
            [entry.id, entry.title, entry.description, ...entry.keywords].some((value) =>
              value.toLowerCase().includes(term)
            )
          ),
        }))
        .filter((group) => group.entries.length > 0);
    },
  };
});

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
vi.mock('@/app/components/reactive/ReactivePreview', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.previewProps = props;
    return null;
  },
}));
// 格式分析器是后端契约（worker）；单测里只要一个不排后台任务的替身 ——
// 无候选语法的正文根本不会调用它，需要结果的用例各自再覆盖。
vi.mock('@/lib/reactive/format-observer', () => ({
  createFormatAnalyzer: (options: NonNullable<typeof mocks.analyzerOptions>) => {
    mocks.analyzerOptions = options;
    return {
      analyze: async (source: string, revision = 1) =>
        mocks.analyzeImpl
          ? mocks.analyzeImpl(source, revision)
          : { revision, ...mocks.analyzeResult },
      dispose: () => {},
    };
  },
}));

vi.mock('@/app/components/markdown-editor/ResourcePanel', () => ({ default: () => null }));

import Toolbar from '@/app/components/markdown-editor/Toolbar';
import MarkdownEditor, { type MarkdownEditorHandle } from '@/app/components/MarkdownEditor';
import type { EditorSubmitSnapshot } from '@/lib/md-editor/format-mode';

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
  mocks.applyReactiveAuthorAnalysis.mockClear();
  mocks.clearReactiveAuthorAnalysis.mockClear();
  mocks.analyzerOptions = null;
  mocks.previewProps = null;
  window.localStorage.clear();
  mocks.reactiveAuthoring.mockImplementation(() => []);
  mocks.getReactiveCompletions.mockReturnValue([]);
  mocks.applyReactiveCompletion.mockReturnValue(true);
  mocks.formatReactiveDocument.mockReturnValue(true);
  mocks.analyzeResult = {
    effective: 'markdown',
    valid: true,
    publishable: true,
    evidence: [],
    candidates: [],
    codes: [],
    diagnostics: [],
    declaredVersion: null,
    syntaxVersion: null,
  };
  mocks.analyzeImpl = null;
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

describe('Toolbar：四入口不再随格式隐藏', () => {
  it('Markdown 正文里 Components 入口照旧在（插入组件就是开始写增强语法）', () => {
    const container = mount(createElement(Toolbar, toolbarProps({ reactive: false })));
    expect(container.querySelector('[aria-label="组件"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="格式"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="上传图片"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="插入引用"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="更多"]')).not.toBeNull();
    // 补全只对增强语法有意义：Markdown 正文的「更多」里不提供
    expect(container.querySelector('[aria-label="补全"]')).toBeNull();
  });

  it('Reactive 正文：「更多」菜单里提供补全与格式化', async () => {
    const container = mount(
      createElement(
        Toolbar,
        toolbarProps({
          reactive: true,
          onRequestCompletions: vi.fn(),
          onFormat: vi.fn(),
        })
      )
    );
    const more = container.querySelector<HTMLButtonElement>('[aria-label="更多"]')!;
    await act(async () => more.click());
    const items = Array.from(container.querySelectorAll('[role="menuitem"]'));
    expect(items.some((item) => item.textContent?.includes('补全'))).toBe(true);
    expect(items.some((item) => item.textContent?.includes('格式化'))).toBe(true);
  });
});

describe('组件挑选：搜索、分组、插入与焦点返回', () => {
  it('打开后搜索框获得焦点；按中文筛选后点击一次事务插入', async () => {
    const view = stubView();
    const container = mount(
      createElement(Toolbar, toolbarProps({ reactive: false, view }))
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="组件"]')!;
    await act(async () => trigger.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索组件"]')!;
    expect(document.activeElement).toBe(input);

    // 目录里的 group 标题在（来自站点编译配置派生的目录）
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
    const container = mount(createElement(Toolbar, toolbarProps({ reactive: false })));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="组件"]')!;
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

function EditorHarness({
  initialFormat,
  initialValue = '# 标题\n\n正文',
  initialSyntaxVersion = null,
  draftKey,
  handleRef,
}: {
  initialFormat: ContentFormat;
  initialValue?: string;
  initialSyntaxVersion?: string | null;
  draftKey?: string;
  handleRef?: RefObject<MarkdownEditorHandle | null>;
}) {
  const [format, setCurrentFormat] = useState<ContentFormat>(initialFormat);
  setFormat = setCurrentFormat;
  return createElement(MarkdownEditor, {
    initialValue,
    initialSyntaxVersion,
    draftKey,
    format,
    ref: handleRef,
  });
}

describe('MarkdownEditor：Reactive 诊断 / 补全 / 格式化', () => {
  const REACTIVE_DIAGNOSTICS = {
    effective: 'reactive',
    valid: true,
    publishable: true,
    evidence: ['component:slider'],
    candidates: ['component:slider'],
    codes: [],
    diagnostics: [
      {
        code: 'component.unknown',
        severity: 'error' as const,
        message: '未知组件 <slidr>',
        line: 2,
        column: 3,
        range: { start: 2, end: 8 },
      },
      {
        code: 'footnote.unsupported',
        severity: 'warning' as const,
        message: '脚注按原文显示',
        line: 4,
        column: 1,
        range: { start: 20, end: 24 },
      },
    ],
    declaredVersion: null,
    syntaxVersion: 'local-draft-3',
  };

  it('分析结果落地后显示计数；诊断可展开并点击定位', async () => {
    mocks.analyzeResult = REACTIVE_DIAGNOSTICS;
    const ref = createRef<MarkdownEditorHandle>();
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'markdown',
        initialValue: '<slider bind="a">',
        handleRef: ref,
      })
    );

    await act(async () => {
      await ref.current!.prepareSubmit();
    });

    expect(mocks.reactiveAuthoring).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.md-authoring')).not.toBeNull();
    expect(container.textContent).toContain('错误 1');
    expect(container.textContent).toContain('警告 1');

    await click(container, '.md-authoring__toggle');
    expect(container.textContent).toContain('未知组件 <slidr>');
    expect(container.textContent).toContain('第 2 行 3 列');

    await click(container, '.md-authoring__diagnostic');
    expect(mocks.revealReactiveDiagnostic).toHaveBeenCalledTimes(1);
    expect(mocks.revealReactiveDiagnostic.mock.calls[0][1]).toMatchObject({
      code: 'component.unknown',
    });
  });

  it('worker 的 author.tokens / 诊断交给 CM6 装饰（不在主线程重算）', async () => {
    const author = {
      tokens: [{ kind: 'tag', range: { start: 0, end: 8 } }],
      diagnostics: [
        {
          code: 'component.unknown',
          severity: 'error' as const,
          message: '未知组件 <slidr>',
          line: 1,
          column: 1,
          range: { start: 0, end: 8 },
        },
      ],
    };
    mocks.analyzeResult = { ...REACTIVE_DIAGNOSTICS, author };
    const ref = createRef<MarkdownEditorHandle>();
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'reactive',
        initialValue: '<slidr>',
        handleRef: ref,
      })
    );

    await act(async () => {
      await ref.current!.prepareSubmit();
    });

    expect(mocks.applyReactiveAuthorAnalysis).toHaveBeenCalledTimes(1);
    const [view, analysis] = mocks.applyReactiveAuthorAnalysis.mock.calls[0];
    expect(view).toBe(EditorView.findFromDOM(container.querySelector('.cm-content')!));
    expect(analysis).toEqual(author);
  });

  it('worker 回退主线程检查时，面板明确写「本地检查」', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    expect(mocks.analyzerOptions?.onModeChange).toBeTypeOf('function');

    await act(async () => {
      mocks.analyzerOptions!.onModeChange!('fallback');
    });
    expect(container.textContent).toContain('本地检查');

    await act(async () => {
      mocks.analyzerOptions!.onModeChange!('worker');
    });
    expect(container.textContent).not.toContain('本地检查');
  });

  it('工具条「更多 → 补全」出候选，选中后调用 applyReactiveCompletion', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));

    mocks.getReactiveCompletions.mockReturnValue(COMPLETIONS);
    await click(container, '[aria-label="更多"]');
    const completionItem = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((node) => node.textContent?.includes('补全'));
    expect(completionItem).toBeTruthy();
    await act(async () => completionItem!.click());

    expect(mocks.getReactiveCompletions).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.md-authoring__completion')).toHaveLength(2);
    expect(container.textContent).toContain('滑块');

    await click(container, '.md-authoring__completion');
    expect(mocks.applyReactiveCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.applyReactiveCompletion.mock.calls[0][1]).toBe(COMPLETIONS[0]);
    expect(container.querySelector('.md-authoring__completions')).toBeNull();
  });

  it('源码变化时立即丢弃旧候选', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    mocks.getReactiveCompletions.mockReturnValue(COMPLETIONS);
    await click(container, '[aria-label="更多"]');
    const completionItem = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((node) => node.textContent?.includes('补全'));
    await act(async () => completionItem!.click());
    expect(container.querySelector('.md-authoring__completions')).not.toBeNull();

    const view = EditorView.findFromDOM(container.querySelector('.cm-content')!)!;
    act(() => view.dispatch({ changes: { from: 0, insert: '新' } }));
    expect(container.querySelector('.md-authoring__completions')).toBeNull();
    expect(container.querySelector('.md-authoring__diagnostic')).toBeNull();
    expect(mocks.applyReactiveCompletion).not.toHaveBeenCalled();
  });

  it('没有候选时明确提示，而不是空白面板', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    await click(container, '[aria-label="更多"]');
    const completionItem = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((node) => node.textContent?.includes('补全'));
    await act(async () => completionItem!.click());
    expect(container.textContent).toContain('当前位置没有补全建议。');
  });

  it('「更多 → 格式化」调用 formatReactiveDocument 并给出结果', async () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    const openFormat = async () => {
      await click(container, '[aria-label="更多"]');
      const item = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((node) => node.textContent?.includes('格式化'));
      await act(async () => item!.click());
    };
    await openFormat();
    expect(mocks.formatReactiveDocument).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('已格式化');

    mocks.formatReactiveDocument.mockReturnValue(false);
    await openFormat();
    expect(container.textContent).toContain('没有需要格式化的内容');
  });

  it('预览始终走统一引擎，并把当前格式传下去（Markdown 子剪贴板内联一层）', () => {
    const markdown = mount(createElement(EditorHarness, { initialFormat: 'markdown' }));
    expect(mocks.previewProps?.format).toBe('markdown');
    expect(mocks.previewProps?.source).toBe('# 标题\n\n正文');
    markdown.remove();

    mount(createElement(EditorHarness, { initialFormat: 'reactive' }));
    expect(mocks.previewProps?.format).toBe('reactive');
  });

  it('Markdown 模式不启用作者扩展、不显示诊断面板；Components 入口仍在', () => {
    const container = mount(createElement(EditorHarness, { initialFormat: 'markdown' }));
    expect(mocks.reactiveAuthoring).not.toHaveBeenCalled();
    expect(container.querySelector('.md-authoring')).toBeNull();
    expect(container.querySelector('[aria-label="组件"]')).not.toBeNull();
  });
});

// ── 3. 格式切换：热替换，不重建 EditorState ──────────────────────────────────

describe('自动格式：热替换，正文与 DOM 原地不动', () => {
  it('分析升级 → reactive 热装扩展；分析回 markdown → 卸下，节点不重建', async () => {
    mocks.analyzeResult = {
      effective: 'reactive',
      valid: true,
      publishable: true,
      evidence: ['component:slider'],
      candidates: ['component:slider'],
      codes: [],
      diagnostics: [],
      declaredVersion: null,
      syntaxVersion: 'local-draft-3',
    };
    const ref = createRef<MarkdownEditorHandle>();
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'markdown',
        initialValue: '<slider bind="a">',
        handleRef: ref,
      })
    );
    const contentBefore = container.querySelector('.cm-content');
    expect(contentBefore).not.toBeNull();

    await act(async () => {
      await ref.current!.prepareSubmit();
    });
    expect(mocks.reactiveAuthoring).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.md-authoring')).not.toBeNull();

    mocks.analyzeResult = {
      effective: 'markdown',
      valid: true,
      publishable: true,
      evidence: [],
      candidates: [],
      codes: [],
      diagnostics: [],
      declaredVersion: null,
      syntaxVersion: null,
    };
    await act(async () => {
      await ref.current!.prepareSubmit();
    });

    // 新建的 Markdown 文档删光组件 → 回到 markdown；已保存 reactive 的下限另测
    expect(container.querySelector('.md-authoring')).toBeNull();
    expect(mocks.reactiveAuthoring).toHaveBeenCalledTimes(1);
    // 同一个 .cm-content 节点 = 没有重建 EditorState（重建会换掉整个 DOM）
    expect(container.querySelector('.cm-content')).toBe(contentBefore);
    expect(contentBefore!.textContent).toContain('<slider');
  });
});

// ── 4. 提交前的权威判定 ──────────────────────────────────────────────────────

describe('prepareSubmit：无效增强语法绝不静默按 Markdown 保存', () => {
  it('invalid-enhanced → blocked + 诊断，格式保留 reactive', async () => {
    mocks.analyzeResult = {
      effective: 'invalid-enhanced',
      valid: false,
      publishable: false,
      evidence: ['component:slider'],
      candidates: ['component:slider'],
      codes: ['local.tag.unclosed'],
      diagnostics: [
        {
          code: 'local.tag.unclosed',
          severity: 'error',
          message: '标签未闭合',
          line: 1,
          column: 1,
          range: { start: 0, end: 8 },
        },
      ],
      declaredVersion: null,
      syntaxVersion: 'local-draft-3',
    };
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '<slider bind="a"',
        format: 'markdown',
        ref,
      })
    );
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.blocked).not.toBeNull();
    expect(snapshot.blocked!.diagnostics).toHaveLength(1);
    expect(snapshot.format).toBe('reactive');
    expect(snapshot.content).toBe('<slider bind="a"');
  });

  it('有效增强语法 → reactive + 权威语法版本', async () => {
    mocks.analyzeResult = {
      effective: 'reactive',
      valid: true,
      publishable: true,
      evidence: ['component:slider'],
      candidates: ['component:slider'],
      codes: [],
      diagnostics: [],
      declaredVersion: null,
      syntaxVersion: 'local-draft-3',
    };
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '<slider bind="a">',
        format: 'markdown',
        ref,
      })
    );
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.blocked).toBeNull();
    expect(snapshot.format).toBe('reactive');
    expect(snapshot.syntaxVersion).toBe('local-draft-3');
  });

  it('已保存为 reactive 的文档即使删光组件也不降级', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '只剩普通正文了',
        format: 'reactive',
        ref,
      })
    );
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.format).toBe('reactive');
    expect(snapshot.blocked).toBeNull();
  });

  it('普通 Markdown 不排分析，直接按 markdown 提交', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '# 只有 Markdown',
        format: 'markdown',
        ref,
      })
    );
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot).toEqual({
      content: '# 只有 Markdown',
      format: 'markdown',
      syntaxVersion: null,
      blocked: null,
    });
  });

  it('解析器认识但不可发布（publishable=false）→ blocked + 诊断', async () => {
    mocks.analyzeResult = {
      effective: 'reactive',
      valid: true,
      publishable: false,
      evidence: ['component:slider'],
      candidates: ['component:slider'],
      codes: ['local.budget.exceeded'],
      diagnostics: [
        {
          code: 'local.budget.exceeded',
          severity: 'error',
          message: '超过节点预算',
          line: 1,
          column: 1,
          range: { start: 0, end: 8 },
        },
      ],
      declaredVersion: null,
      syntaxVersion: 'local-draft-3',
    };
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '<slider bind="a">',
        format: 'markdown',
        ref,
      })
    );
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.blocked).not.toBeNull();
    expect(snapshot.blocked!.diagnostics).toHaveLength(1);
    expect(snapshot.format).toBe('reactive');
  });

  it('effective=markdown 但 publishable=false → 同样 blocked（本地诊断不能丢给服务端 400）', async () => {
    // 典型：超预算的未闭合 `<` / `{{` —— 解析器判定「就是 markdown」，但发布闸门
    // 仍不接受。旧实现只在 effective==='reactive' 时拦，于是这类正文被当 markdown
    // 交给表单、服务端回通用 400，本地预算诊断丢失（R3-141）。
    mocks.analyzeResult = {
      effective: 'markdown',
      valid: true,
      publishable: false,
      evidence: [],
      candidates: [],
      codes: ['local.budget.exceeded'],
      diagnostics: [
        {
          code: 'local.budget.exceeded',
          severity: 'error',
          message: '超过预算',
          line: 1,
          column: 1,
          range: { start: 0, end: 4 },
        },
      ],
      declaredVersion: null,
      syntaxVersion: null,
    };
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '<未闭合',
        format: 'markdown',
        ref,
      })
    );
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.blocked).not.toBeNull();
    expect(snapshot.blocked!.diagnostics).toHaveLength(1);
    expect(snapshot.format, 'markdown 不可发布时不能伪装成 reactive').toBe('markdown');
  });

  it('等待分析期间正文又变了 → 重试并提交新正文', async () => {
    const calls: string[] = [];
    let release!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    mocks.analyzeImpl = (source, revision) => {
      calls.push(source);
      if (calls.length === 1) return first;
      return Promise.resolve({
        revision,
        effective: 'markdown',
        valid: true,
        publishable: true,
        evidence: [],
        candidates: [],
        codes: [],
        diagnostics: [],
        declaredVersion: null,
        syntaxVersion: null,
      });
    };

    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '<slider bind="a">',
        format: 'markdown',
        ref,
      })
    );

    let pending!: Promise<EditorSubmitSnapshot>;
    await act(async () => {
      pending = ref.current!.prepareSubmit();
    });

    const view = EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n后续' } });
    });

    await act(async () => {
      release({
        revision: 1,
        effective: 'reactive',
        valid: true,
        publishable: true,
        evidence: ['component:slider'],
        candidates: ['component:slider'],
        codes: [],
        diagnostics: [],
        declaredVersion: null,
        syntaxVersion: 'local-draft-3',
      });
    });

    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await pending;
    });
    expect(calls).toHaveLength(2);
    expect(snapshot.content).toContain('后续');
    expect(snapshot.format).toBe('markdown');
  });

  it('新建 Markdown 插入组件后是临时升级；删光后按最终解析事实保存为 markdown', async () => {
    mocks.analyzeResult = {
      effective: 'markdown',
      valid: true,
      publishable: true,
      evidence: [],
      candidates: [],
      codes: [],
      diagnostics: [],
      declaredVersion: null,
      syntaxVersion: null,
    };
    const ref = createRef<MarkdownEditorHandle>();
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'markdown',
        initialValue: '只剩普通正文了',
        handleRef: ref,
      })
    );
    await click(container, '[aria-label="组件"]');
    await click(container, '.md-component-picker__item');

    // 真实插入会改动正文 → 分析在飞，此时临时按增强文档预览 / 给工具。
    const view = EditorView.findFromDOM(container.querySelector('.cm-content')!)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n<slider bind="a">' } }));
    expect(ref.current!.getFormat()).toBe('reactive');

    // 删光组件：预筛直接判定没有增强候选，临时升级必须撤掉。
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '只剩普通正文了' } }));
    expect(ref.current!.getFormat()).toBe('markdown');

    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.format).toBe('markdown');
    expect(snapshot.blocked).toBeNull();
  });

  it('已保存为 reactive 的文档，正文删光增强语法也不降级，并带上权威版本', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '只剩普通正文了',
        format: 'reactive',
        initialSyntaxVersion: 'local-draft-3',
        ref,
      })
    );

    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.format).toBe('reactive');
    expect(snapshot.syntaxVersion).toBe('local-draft-3');
    expect(snapshot.blocked).toBeNull();
  });
});

// ── 5. 同页保存后的持久下限 / 草稿身份 / 回退提示 ───────────────────────────

describe('终审回归：F1 保存成功后抬下限、F4 回退提示、F5 草稿不写临时身份', () => {
  it('F1：pinSavedFormat 把 reactive 抬成持久下限，之后纯文字提交不降级；markdown 不会压低', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    mount(
      createElement(MarkdownEditor, {
        initialValue: '只剩普通正文了',
        format: 'markdown',
        ref,
      })
    );

    // 模拟「同页保存成功」：服务端已持有 reactive，表单回调抬下限。
    act(() => ref.current!.pinSavedFormat('reactive', 'local-draft-3'));
    expect(ref.current!.getFormat()).toBe('reactive');

    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.format).toBe('reactive');
    expect(snapshot.syntaxVersion).toBe('local-draft-3');

    // 再保存成 markdown（例如服务端归一化）也不能把已保存的增强身份压低。
    act(() => ref.current!.pinSavedFormat('markdown', null));
    expect(ref.current!.getFormat()).toBe('reactive');
  });

  it('F4：纯 Markdown（含 `<`）遇到 worker 回退时，语法检查条明示「本地检查」', async () => {
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'markdown',
        initialValue: '内嵌 <br> 的普通 Markdown',
      })
    );
    // 普通正文没有诊断面板 —— 回退前不占版面
    expect(container.querySelector('.md-authoring')).toBeNull();
    expect(mocks.analyzerOptions?.onModeChange).toBeTypeOf('function');

    await act(async () => {
      mocks.analyzerOptions!.onModeChange!('fallback');
    });
    expect(container.querySelector('.md-authoring')).not.toBeNull();
    expect(container.textContent).toContain('本地检查');
  });

  it('F5：插入组件后分析未落地就落盘，草稿不把临时升级写成 reactive', async () => {
    const KEY = 'ui-f5-draft';
    const ref = createRef<MarkdownEditorHandle>();
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'markdown',
        initialValue: '普通正文',
        draftKey: KEY,
        handleRef: ref,
      })
    );

    await click(container, '[aria-label="组件"]');
    await click(container, '.md-component-picker__item');
    const view = EditorView.findFromDOM(container.querySelector('.cm-content')!)!;
    act(() =>
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n<slider bind="a">' } })
    );

    // 此刻分析还在飞（analysisPending=true），临时身份是 reactive；
    // 草稿必须只记「已落地的解析事实」= markdown。
    act(() => ref.current!.flushDraft());
    expect(window.localStorage.getItem(KEY)).toContain('<slider');
    expect(window.localStorage.getItem(`${KEY}:meta`)).toBeNull();
  });

  it('F5：恢复一份没有格式元数据的含组件草稿时，重新分析能升级为 reactive', async () => {
    const KEY = 'ui-f5-restore';
    window.localStorage.setItem(KEY, '<slider bind="a">\n\n人数 {{ a }}');
    mocks.analyzeResult = {
      effective: 'reactive',
      valid: true,
      publishable: true,
      evidence: ['component:slider'],
      candidates: ['component:slider'],
      codes: [],
      diagnostics: [],
      declaredVersion: null,
      syntaxVersion: 'local-draft-3',
    };
    const ref = createRef<MarkdownEditorHandle>();
    const container = mount(
      createElement(EditorHarness, {
        initialFormat: 'markdown',
        initialValue: '空白',
        draftKey: KEY,
        handleRef: ref,
      })
    );

    await click(container, '.md-editor__draft-btn');
    let snapshot!: EditorSubmitSnapshot;
    await act(async () => {
      snapshot = await ref.current!.prepareSubmit();
    });
    expect(snapshot.format).toBe('reactive');
    expect(snapshot.syntaxVersion).toBe('local-draft-3');
  });
});
