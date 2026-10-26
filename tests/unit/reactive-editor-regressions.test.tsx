// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// reactive-editor-regressions.test.tsx —— 编辑器草稿的「格式」与预览的「刷新引用」
//
// 【为什么值得单测】这两组失败都**不报错**，页面上也看不出：
//   · 只切格式、正文没动时，CM6 的 updateListener 不会触发 —— 草稿里留着的还是旧
//     格式，下次恢复出来正文对上、格式对不上，保存时按旧格式写进服务端；
//   · 「刷新引用」只让预览重渲染是不够的：引用缓存（含失败）挂在会话级 reader 上，
//     不换 reader，同一份源码永远读到同一份旧数据，失败的那几条更是永不重试。
// 另外两条同样静默的边界：初次挂载不能拿当前正文覆盖正等用户选择的旧草稿；
// 自动恢复时不能拿表单原来的格式把刚恢复的草稿格式改回去。
//
// 【环境】jsdom + react-dom/client + React 19 的 act（仓库没有 @testing-library）。
// CodeMirror 6 在 jsdom 里缺少 Range 的布局方法，这里补两个零尺寸桩子 —— 编辑器
// 只拿它们量版面，本文件测的是草稿写入与刷新代次，不依赖任何真实布局。
// ─────────────────────────────────────────────────────────────────────────────

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentFormat } from '@/lib/content-format';
import { DRAFT_DEBOUNCE_MS, encodeDraftValue } from '@/lib/md-editor/draft';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// CodeMirror 的测量会调 Range#getClientRects / getBoundingClientRect；jsdom 没实现。
// 返回空/零尺寸即可 —— 它只影响「量出来多大」，不影响文档内容与事件。
if (typeof Range.prototype.getClientRects !== 'function') {
  Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  });
}

// ── 替身 ─────────────────────────────────────────────────────────────────────
// 调度器是替身：本文件只关心「谁在什么时候被排进调度器」，不关心真实编译。
// reader / 适配器也是替身：它们的返回值由每个用例摆布，用来分别验证成功、失败与
// 迟到结果三条路径。
const mocks = vi.hoisted(() => {
  class FakeScheduler {
    schedule = vi.fn();
    dispose = vi.fn();
    constructor(public options: { onResult: (outcome: unknown) => void }) {
      instances.push(this);
    }
  }
  const instances: FakeScheduler[] = [];
  return {
    instances,
    FakeScheduler,
    adaptReactivePreview: vi.fn(),
    createClientReferenceReader: vi.fn(),
  };
});

vi.mock('reactive-md', () => ({
  LocalCompileScheduler: mocks.FakeScheduler,
  compileLocal: vi.fn(),
  // export.ts 也从这个入口取 runtime（本文件不触发导出，给个空实现即可）。
  createLocalRuntime: vi.fn(),
  compileFailureDiagnostic: (error: unknown) => ({
    code: 'preview.failure',
    message: String(error),
    severity: 'error',
    line: 1,
    column: 1,
  }),
  formatLocalDiagnostic: (diagnostic: { message: string }) => diagnostic.message,
}));

vi.mock('@/lib/reactive/client-compile', () => ({
  adaptReactivePreview: mocks.adaptReactivePreview,
  createClientReferenceReader: mocks.createClientReferenceReader,
  compileReactivePreview: vi.fn(),
}));

// 文档渲染表面换成一行 JSON：预览刷新要验的是「拿哪一份 hostData 去渲染」。
vi.mock('@/app/components/reactive/ReactiveDocument', async () => {
  const React = await import('react');
  return {
    default: (props: { hostData?: unknown }) =>
      React.createElement(
        'div',
        { 'data-testid': 'reactive-doc' },
        JSON.stringify(props.hostData ?? {})
      ),
  };
});

// 编辑器测试不需要真的预览 / 工具条 —— 它们在别的用例里各自被测过。
vi.mock('@/app/components/reactive/ReactivePreview', () => ({ default: () => null }));
vi.mock('@/app/components/MarkdownRenderer', () => ({ default: () => null }));
vi.mock('@/app/components/markdown-editor/Toolbar', () => ({
  default: () => null,
  VIEW_MODES: [],
}));
vi.mock('@/app/components/markdown-editor/ResourcePanel', () => ({ default: () => null }));

import MarkdownEditor from '@/app/components/MarkdownEditor';

const KEY = 'reactive-regression-draft';

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  mocks.instances.length = 0;
  mocks.adaptReactivePreview.mockReset();
  mocks.createClientReferenceReader.mockReset();
  mocks.createClientReferenceReader.mockImplementation(() => ({}));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

// ── 编辑器：格式与草稿 ───────────────────────────────────────────────────────

interface HarnessProps {
  initialValue: string;
  initialFormat?: ContentFormat;
  draftKey?: string;
  /** false = 表单不采纳草稿格式（用来隔离「自动恢复时别拿旧格式回写」这条）。 */
  syncFormat?: boolean;
  onFormatRestored?: (format: ContentFormat) => void;
}

function EditorHarness({
  initialValue,
  initialFormat = 'markdown',
  draftKey,
  syncFormat = true,
  onFormatRestored,
}: HarnessProps) {
  const [format, setFormat] = useState<ContentFormat>(initialFormat);
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'format' }, format),
    createElement('button', { id: 'pick-reactive', onClick: () => setFormat('reactive') }, 'r'),
    createElement('button', { id: 'pick-markdown', onClick: () => setFormat('markdown') }, 'm'),
    createElement(MarkdownEditor, {
      initialValue,
      draftKey,
      format,
      onDraftFormatRestored: (restored: ContentFormat) => {
        onFormatRestored?.(restored);
        if (syncFormat) setFormat(restored);
      },
    })
  );
}

interface EditorHandle {
  container: HTMLElement;
  click(selector: string): Promise<void>;
  formatLabel(): string | null;
  unmount(): void;
}

async function mountEditor(props: HarnessProps): Promise<EditorHandle> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditorHarness, props));
  });
  return {
    container,
    async click(selector) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(selector)!.click();
      });
    },
    formatLabel: () => container.querySelector('[data-testid="format"]')?.textContent ?? null,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// ── 预览：刷新引用 ───────────────────────────────────────────────────────────

type RealPreview = typeof import('@/app/components/reactive/ReactivePreview').default;

async function loadRealPreview(): Promise<RealPreview> {
  // 编辑器那组把它替成了 null；这里要的是真身（它的依赖仍走本文件的替身）。
  const mod = await vi.importActual<typeof import('@/app/components/reactive/ReactivePreview')>(
    '@/app/components/reactive/ReactivePreview'
  );
  return mod.default;
}

interface PreviewHandle {
  container: HTMLElement;
  render(source: string, refreshToken: number): Promise<void>;
  scheduler(): (typeof mocks.instances)[number];
  unmount(): void;
}

async function mountPreview(source: string, refreshToken = 0): Promise<PreviewHandle> {
  const Preview = await loadRealPreview();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (src: string, token: number) => {
    await act(async () => {
      root.render(
        createElement(Preview, { source: src, debounceMs: 0, refreshToken: token })
      );
    });
  };
  await render(source, refreshToken);
  return {
    container,
    render,
    scheduler: () => mocks.instances[mocks.instances.length - 1],
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 替身调度器「编译完成」的那一下（hostData 已在适配完成时进了预览内部的表）。 */
function emitResult(
  scheduler: ReturnType<PreviewHandle['scheduler']>,
  source: string
) {
  act(() => {
    scheduler.options.onResult({
      source,
      result: { ok: true, document: {} },
      duration: 0,
      mode: 'fallback',
    });
  });
}

describe('刷新引用：同一份源码也要重取、重编译', () => {
  it('刷新会重建 reader、重新适配并把新结果渲染出来', async () => {
    mocks.adaptReactivePreview
      .mockResolvedValueOnce({ adaptedSource: 'SRC', hostData: { title: '旧标题' } })
      .mockResolvedValueOnce({ adaptedSource: 'SRC', hostData: { title: '新标题' } });

    const h = await mountPreview('[@AbCdEf123]');
    await tick(1);
    const scheduler = h.scheduler();
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.createClientReferenceReader).toHaveBeenCalledTimes(1);

    emitResult(scheduler, 'SRC');
    expect(h.container.textContent).toContain('旧标题');

    await h.render('[@AbCdEf123]', 1);
    await tick(1);

    expect(
      mocks.createClientReferenceReader,
      '刷新必须换一份 reader（成功与失败的缓存都跟着作废）'
    ).toHaveBeenCalledTimes(2);
    expect(scheduler.schedule, '同一份源码刷新后要重新编译').toHaveBeenCalledTimes(2);

    emitResult(scheduler, 'SRC');
    expect(h.container.textContent).toContain('新标题');
    h.unmount();
  });

  it('失败也随刷新重试：先报错，刷新后恢复', async () => {
    mocks.adaptReactivePreview
      .mockRejectedValueOnce(new Error('取数失败'))
      .mockResolvedValueOnce({ adaptedSource: 'SRC', hostData: {} });

    const h = await mountPreview('[@AbCdEf123]');
    await tick(1);
    expect(h.container.textContent).toContain('取数失败');

    await h.render('[@AbCdEf123]', 1);
    await tick(1);
    const scheduler = h.scheduler();
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);

    emitResult(scheduler, 'SRC');
    expect(h.container.textContent).not.toContain('取数失败');
    h.unmount();
  });

  it('刷新后迟到的旧适配结果不得覆盖新结果', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mocks.adaptReactivePreview
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ adaptedSource: 'NEW', hostData: { title: '新' } });

    const h = await mountPreview('原稿');
    await tick(1); // 第一轮适配在飞（旧 reader）
    const scheduler = h.scheduler();

    await h.render('原稿', 1); // 刷新：也换掉 reader
    await tick(1); // 第二轮适配完成并排进调度器
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule).toHaveBeenCalledWith('NEW', expect.anything());

    emitResult(scheduler, 'NEW');
    expect(h.container.textContent).toContain('新');

    // 旧一代的结果现在才回来（用旧 reader 取的数）—— 必须被代次守卫丢掉。
    await act(async () => {
      resolveFirst({ adaptedSource: 'OLD', hostData: { title: '旧' } });
    });
    await tick(1);

    expect(scheduler.schedule, '旧代次不得再排进调度器').toHaveBeenCalledTimes(1);
    expect(h.container.textContent, '旧结果不得覆盖已渲染的新结果').toContain('新');
    h.unmount();
  });
});
