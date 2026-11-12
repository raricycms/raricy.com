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
import {
  DRAFT_DEBOUNCE_MS,
  draftMetaKey,
  encodeDraftMeta,
  encodeDraftValue,
  type DraftEntry,
} from '@/lib/md-editor/draft';

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
    constructor(
      public options: {
        onResult: (outcome: unknown) => void;
        onModeChange?: (mode: 'worker' | 'fallback', detail?: string) => void;
      }
    ) {
      instances.push(this);
    }
  }
  const instances: FakeScheduler[] = [];
  return {
    instances,
    FakeScheduler,
    expandClientReferences: vi.fn(),
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
  expandClientReferences: mocks.expandClientReferences,
  createClientReferenceReader: mocks.createClientReferenceReader,
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
vi.mock('@/app/components/markdown-editor/Toolbar', () => ({
  default: () => null,
  VIEW_MODES: [],
}));
// 格式分析器是后端契约（worker）；单测里只要一个不排后台任务的替身 ——
// 无候选语法的正文根本不会调用它，需要结果的用例各自再覆盖。
vi.mock('@/lib/reactive/format-observer', () => ({
  createFormatAnalyzer: () => ({
    analyze: async (_source: string, revision = 1) => ({
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
    }),
    dispose: () => {},
  }),
}));

vi.mock('@/app/components/markdown-editor/ResourcePanel', () => ({ default: () => null }));

import MarkdownEditor from '@/app/components/MarkdownEditor';

const KEY = 'reactive-regression-draft';

/** 按新存储形态播种：主键原文 + 旁路元数据（格式 / 版本）。 */
function seedDraft(entry: DraftEntry): void {
  window.localStorage.setItem(KEY, encodeDraftValue(entry));
  const meta = encodeDraftMeta(entry);
  if (meta === null) window.localStorage.removeItem(draftMetaKey(KEY));
  else window.localStorage.setItem(draftMetaKey(KEY), meta);
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  mocks.instances.length = 0;
  mocks.expandClientReferences.mockReset();
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

describe('草稿：只切格式也要把正文与新格式一起存下', () => {
  it('正文没动、只改格式 → 落盘的是当前正文 + 新格式', async () => {
    const h = await mountEditor({ initialValue: '正文一个字都没动', draftKey: KEY });
    // 初次挂载**不落盘**：没有改动就没有草稿。
    expect(window.localStorage.getItem(KEY)).toBeNull();

    await h.click('#pick-reactive');
    await tick(DRAFT_DEBOUNCE_MS + 50);

    expect(window.localStorage.getItem(KEY)).toBe('正文一个字都没动');
    expect(window.localStorage.getItem(draftMetaKey(KEY))).toContain('"format":"reactive"');
    h.unmount();
  });

  it('连续切两次 → 排队中的旧格式被替换，只落最后一份', async () => {
    const h = await mountEditor({ initialValue: '正文', draftKey: KEY });
    await h.click('#pick-reactive');
    await h.click('#pick-markdown');
    await tick(DRAFT_DEBOUNCE_MS + 50);

    // markdown 的落盘形态是裸正文（老草稿续用同一把键）。
    expect(window.localStorage.getItem(KEY)).toBe('正文');
    h.unmount();
  });

  it('初次挂载不覆盖正等用户选择的旧草稿', async () => {
    seedDraft({ format: 'reactive', text: '上次没发出去的草稿', syntaxVersion: null });
    const oldDraft = window.localStorage.getItem(KEY);

    const h = await mountEditor({
      initialValue: '服务端那一版正文',
      draftKey: KEY,
      onFormatRestored: vi.fn(),
    });
    // 横幅在等选择 —— 这时一个字节都不该写回，否则旧草稿就被覆盖掉了。
    expect(h.container.querySelector('.md-editor__draft-btn')).toBeTruthy();
    await tick(DRAFT_DEBOUNCE_MS * 4);
    expect(window.localStorage.getItem(KEY)).toBe(oldDraft);
    h.unmount();
  });
});

describe('草稿恢复按钮：最终正文与格式保持一致', () => {
  it('恢复一份 reactive 草稿 → 表单格式跟着变，落盘的也是 reactive', async () => {
    seedDraft({ format: 'reactive', text: '草稿里的正文', syntaxVersion: null });
    const onFormatRestored = vi.fn();
    const h = await mountEditor({
      initialValue: '当前正文',
      draftKey: KEY,
      onFormatRestored,
    });

    await h.click('.md-editor__draft-btn');
    expect(onFormatRestored).toHaveBeenCalledWith('reactive');
    expect(h.formatLabel()).toBe('reactive');

    await tick(DRAFT_DEBOUNCE_MS + 50);
    expect(window.localStorage.getItem(KEY)).toBe('草稿里的正文');
    expect(window.localStorage.getItem(draftMetaKey(KEY))).toContain('"format":"reactive"');
    h.unmount();
  });

  it('自动恢复时不拿表单原来的格式回写（草稿格式才是真相）', async () => {
    seedDraft({ format: 'reactive', text: '草稿正文', syntaxVersion: null });
    const draft = window.localStorage.getItem(KEY);

    const onFormatRestored = vi.fn();
    // 新建页没有服务端初值 → 直接自动恢复；这里刻意让表单**不采纳**恢复的格式，
    // 好把「挂载时若按表单旧格式 schedule 一次，草稿就被改成裸 markdown」暴露出来。
    const h = await mountEditor({
      initialValue: '',
      draftKey: KEY,
      syncFormat: false,
      onFormatRestored,
    });
    expect(onFormatRestored).toHaveBeenCalledWith('reactive');

    await tick(DRAFT_DEBOUNCE_MS + 50);
    expect(window.localStorage.getItem(KEY)).toBe(draft);
    h.unmount();
  });
});

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
async function emitResult(scheduler: ReturnType<PreviewHandle['scheduler']>, source: string) {
  await act(async () => {
    scheduler.options.onResult({
      source, result: { ok: true, document: {} }, duration: 0, mode: 'worker',
    });
  });
}

describe('编译后展开预览引用', () => {
  it('刷新引用会重建 reader，同一份源码也会重新展开', async () => {
    mocks.expandClientReferences
      .mockResolvedValueOnce({ document: {}, hostData: { title: '旧标题' } })
      .mockResolvedValueOnce({ document: {}, hostData: { title: '新标题' } });
    const source = '[@AbCdEf123]';
    const view = await mountPreview(source);
    await emitResult(view.scheduler(), source);
    expect(view.container.textContent).toContain('旧标题');

    await view.render(source, 1);
    expect(mocks.createClientReferenceReader).toHaveBeenCalledTimes(2);
    expect(view.scheduler().schedule).toHaveBeenCalledWith(source, expect.anything());
    await emitResult(view.scheduler(), source);
    expect(view.container.textContent).toContain('新标题');
    view.unmount();
  });

  it('旧取数迟到时保留新源码的预览', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    mocks.expandClientReferences
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ document: {}, hostData: { title: '新引用' } });
    const view = await mountPreview('原稿');
    await emitResult(view.scheduler(), '原稿');
    await view.render('新版', 0);
    await emitResult(view.scheduler(), '新版');
    await act(async () => { resolveOld({ document: {}, hostData: { title: '旧引用' } }); });
    expect(view.container.textContent).toContain('新引用');
    expect(view.container.textContent).not.toContain('旧引用');
    view.unmount();
  });

  it('Worker 回退时显示本地检查状态', async () => {
    const view = await mountPreview('正文');
    act(() => view.scheduler().options.onModeChange?.('fallback'));
    expect(view.container.textContent).toContain('本地检查');
    view.unmount();
  });
});
