import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileLocal } from 'reactive-md';

// 纯决策层：编译、快照、external 重验全部替身。不碰 prisma / React / 上游运行时。
vi.mock('@/lib/reactive/compile', () => ({ compileReactiveSource: vi.fn() }));
vi.mock('@/lib/reactive/snapshot-store', () => ({
  reactiveContentVersion: () => 'content-version',
  readReactiveSnapshot: vi.fn(),
}));
vi.mock('@/lib/reactive/prepare', () => ({ prepareReactiveDocument: vi.fn() }));

import { resolveReadRender, type ReadRenderInput } from '@/lib/reactive/read-render';
import { compileReactiveSource } from '@/lib/reactive/compile';
import { readReactiveSnapshot } from '@/lib/reactive/snapshot-store';
import { prepareReactiveDocument } from '@/lib/reactive/prepare';
import { hasLegacyMathDelimiters } from '@/lib/reactive/legacy-math';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';

const compileMock = vi.mocked(compileReactiveSource);
const snapshotMock = vi.mocked(readReactiveSnapshot);
const prepareMock = vi.mocked(prepareReactiveDocument);

const CLIP_ID = '12345678';
const CLIP_KEY = `clipboard:${CLIP_ID}`;
const CLIP_TOKEN = `[@${CLIP_ID}]`;

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    result: {
      ok: true,
      document: { kind: 'document', children: [] },
      diagnostics: [{ code: 'local.ok' }],
    },
    adaptedSource: 'adapted',
    hostData: {},
    segments: [],
    referenceSnapshotId: 'snap',
    sourceHash: 'source',
    adaptedHash: 'adapted',
    adapterVersion: 'test-adapter',
    compilerVersion: 'test-compiler',
    syntaxVersion: 'local-draft-2',
    cacheKey: 'key',
    cacheHit: false,
    compileMs: 7,
    ...overrides,
  } as never;
}

function clip(title: string, version: string) {
  return { kind: 'clipboard', ref: CLIP_ID, status: 'ready', title, format: 'markdown', version };
}

function readySnapshot(hostData: Record<string, unknown>) {
  snapshotMock.mockResolvedValue({
    status: 'ready',
    payload: {
      document: { kind: 'document', children: [] },
      hostData,
    },
  } as never);
}

function prepareReturns(hostData: Record<string, unknown>) {
  prepareMock.mockResolvedValue({
    adaptedSource: 'adapted',
    segments: [],
    hostData,
    referenceSnapshotId: 'snap',
    sourceHash: 'source',
    adaptedHash: 'adapted',
    adapterVersion: 'test-adapter',
  } as never);
}

function input(overrides: Partial<ReadRenderInput> = {}): ReadRenderInput {
  return {
    kind: 'blog',
    id: 'blog-1',
    source: 'hello',
    format: 'markdown',
    override: null,
    viewer: null,
    mode: 'external',
    ...overrides,
  };
}

beforeEach(() => {
  compileMock.mockReset();
  snapshotMock.mockReset();
  prepareMock.mockReset();
  snapshotMock.mockResolvedValue({ status: 'missing' } as never);
  process.env.REACTIVE_MD_MODE = 'off';
  process.env.REACTIVE_MD_PERCENT = '100';
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.REACTIVE_MD_MODE;
  delete process.env.REACTIVE_MD_PERCENT;
  vi.restoreAllMocks();
});

describe('persistent snapshot reference revalidation', () => {
  it('keeps the snapshot when current external data matches, without compiling', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareReturns({ [CLIP_KEY]: clip('旧标题', 'v1') });

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.choice.renderer).toBe('reactive-static');
    expect(result.snapshot).toBeDefined();
    expect(result.bundle).toBeUndefined();
    expect(result.log.snapshotStatus).toBe('ready');
    expect(compileMock).not.toHaveBeenCalled();
    // 重验固定按 external，与快照的生成范围一致（即使读者走 expand）。
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0][1]).toMatchObject({ mode: 'external' });
  });

  it('revalidates against external even for expand readers', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareReturns({});
    compileMock.mockResolvedValue(outcome());

    const result = await resolveReadRender(
      input({ format: 'reactive', source, mode: 'expand', viewer: { id: 'u1' } }),
    );

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0][1]).toMatchObject({ mode: 'external' });
    expect(result.snapshot).toBeUndefined();
  });

  const referenceChanges: Array<[string, () => Record<string, unknown>]> = [
    ['clipboard made private or soft-deleted', () => ({})],
    ['clipboard renamed', () => ({ [CLIP_KEY]: clip('新标题', 'v1') })],
    ['clipboard version changed', () => ({ [CLIP_KEY]: clip('旧标题', 'v2') })],
  ];

  it.each(referenceChanges)(
    '%s → recompiles external instead of showing the old snapshot',
    async (_label, current) => {
      const source = `正文 ${CLIP_TOKEN}`;
      readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
      prepareReturns(current());
      compileMock.mockResolvedValue(
        outcome({ hostData: current(), compileMs: 11, cacheHit: true }),
      );

      const result = await resolveReadRender(input({ format: 'reactive', source }));

      expect(result.choice.renderer).toBe('reactive-static');
      expect(result.snapshot).toBeUndefined();
      expect(result.bundle).toBeDefined();
      expect(result.log.snapshotStatus).toBe('stale-references');
      expect(compileMock).toHaveBeenCalledTimes(1);
      expect(compileMock.mock.calls[0][0]).toMatchObject({ mode: 'external' });
    },
  );

  it('lets a newly public clipboard appear by recompiling external', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    // 发布时公开数据为空（当时是私密），现在作者已公开。
    readySnapshot({});
    prepareReturns({ [CLIP_KEY]: clip('后来公开', 'v1') });
    compileMock.mockResolvedValue(outcome({ hostData: { [CLIP_KEY]: clip('后来公开', 'v1') } }));

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.snapshot).toBeUndefined();
    expect(result.bundle).toBeDefined();
    expect(result.log.snapshotStatus).toBe('stale-references');
  });

  it('takes the snapshot fast path when the source has no clipboard references', async () => {
    readySnapshot({ 'audio:abcdef': { kind: 'audio', ref: 'abcdef', status: 'ready' } });

    const result = await resolveReadRender(
      input({ format: 'reactive', source: '只有文字与 ![x](/api/images/1234567890/raw)' }),
    );

    expect(result.snapshot).toBeDefined();
    expect(result.log.snapshotStatus).toBe('ready');
    expect(prepareMock).not.toHaveBeenCalled();
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('does not use the snapshot when reference revalidation read fails', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareMock.mockRejectedValue(new Error('db down'));
    compileMock.mockResolvedValue(outcome());

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.snapshot).toBeUndefined();
    expect(result.bundle).toBeDefined();
    expect(result.log.snapshotStatus).toBe('untrusted-references');
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(compileMock.mock.calls[0][0]).toMatchObject({ mode: 'external' });
  });

  it('surfaces snapshot-references when revalidation fails and the replacement cannot compile', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareMock.mockRejectedValue(new Error('db down'));
    compileMock.mockRejectedValue(new Error('still down'));

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.choice.renderer).toBe('unavailable');
    expect(result.failure).toBe('snapshot-references');
    expect(result.snapshot).toBeUndefined();
  });
});

describe('shadow mode', () => {
  beforeEach(() => {
    process.env.REACTIVE_MD_MODE = 'shadow';
  });

  it('compiles the candidate but keeps legacy visible', async () => {
    compileMock.mockResolvedValue(outcome());

    const result = await resolveReadRender(input({ override: null }));

    expect(result.choice).toEqual({ renderer: 'legacy', reason: 'flag' });
    expect(result.bundle).toBeUndefined();
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(result.shadow).toMatchObject({
      renderer: 'reactive',
      reason: 'format',
      compatible: true,
      codes: ['local.ok'],
      compileMs: 7,
      cacheHit: false,
      legacyMath: false,
    });
    // 读者看到的日志仍是 legacy。
    expect(result.log.renderer).toBe('legacy');
    expect(result.log.codes).toEqual([]);
  });

  it('respects the percent gate and does not compile outside the cohort', async () => {
    process.env.REACTIVE_MD_PERCENT = '0';

    const result = await resolveReadRender(input());

    expect(result.choice.renderer).toBe('legacy');
    expect(result.shadow).toBeUndefined();
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('respects a per-document legacy override', async () => {
    const result = await resolveReadRender(input({ override: 'legacy' }));

    expect(result.choice).toEqual({ renderer: 'legacy', reason: 'flag' });
    expect(result.shadow).toBeUndefined();
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('records diagnostics-driven incompatibility without showing it', async () => {
    compileMock.mockResolvedValue(
      outcome({
        result: {
          ok: true,
          document: { kind: 'document', children: [] },
          diagnostics: [{ code: 'local.html' }],
        },
      }),
    );

    const result = await resolveReadRender(input());

    expect(result.choice.renderer).toBe('legacy');
    expect(result.shadow).toMatchObject({
      renderer: 'legacy',
      reason: 'fallback',
      compatible: false,
      codes: ['local.html'],
    });
  });

  it('marks a thrown shadow compile as an observation error only', async () => {
    compileMock.mockRejectedValue(new Error('boom'));

    const result = await resolveReadRender(input());

    expect(result.choice).toEqual({ renderer: 'legacy', reason: 'flag' });
    expect(result.shadow).toMatchObject({ compatible: false, error: 'compile' });
  });

  it('records backslash math without treating supported math as incompatible', async () => {
    compileMock.mockResolvedValue(outcome());

    const result = await resolveReadRender(input({ source: String.raw`行内 \(x_1+y_2\)` }));

    expect(result.choice.renderer).toBe('legacy');
    expect(result.shadow).toMatchObject({
      renderer: 'reactive',
      reason: 'format',
      compatible: true,
      legacyMath: true,
    });
  });
});

describe('HTML 局部回退的阅读决策', () => {
  it('相同的安全回退：Markdown 使用旧渲染器，Reactive 保持交互', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    const source = '<div style="color:red">{{ missing }}\n\n<counter bind="n" label="N" initial="2">';
    const result = compileLocal(source, reactiveCompileOptions('reactive'));
    expect(result.ok).toBe(true);
    compileMock.mockResolvedValue(outcome({ result }));

    const markdown = await resolveReadRender(input({ format: 'markdown', source }));
    expect(markdown.choice).toEqual({ renderer: 'legacy', reason: 'fallback' });
    const reactive = await resolveReadRender(input({ format: 'reactive', source }));
    expect(reactive.choice.renderer).toBe('reactive');
  });
});

describe('legacy backslash math', () => {
  const cases: Array<[string, boolean]> = [
    [String.raw`行内 \(x_1+y_2\)`, true],
    [String.raw`块级 \[x^2+y^2\]`, true],
    ['`\\(x\\)` 放在行内代码里', false],
    ['```\n\\(x\\)\n```', false],
    [String.raw`\\(x\\)`, false],
    [String.raw`孤立 \( 不算数学`, false],
    ['普通正文 $x^2$', false],
  ];

  it.each(cases)('%s → %s', (source, expected) => {
    expect(hasLegacyMathDelimiters(source)).toBe(expected);
  });

  it('renders a markdown candidate with supported backslash math', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    compileMock.mockResolvedValue(outcome());

    const result = await resolveReadRender(
      input({ override: 'reactive', source: String.raw`行内 \(x_1+y_2\)` }),
    );

    expect(result.choice.renderer).toBe('reactive');
    expect(result.log.legacyMath).toBe(true);
    expect(compileMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat math-shaped text inside code as math', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    compileMock.mockResolvedValue(outcome());

    const inline = await resolveReadRender(
      input({ override: 'reactive', source: '`\\(x\\)` 是示例' }),
    );
    expect(inline.choice.renderer).toBe('reactive');
    expect(inline.log.legacyMath).toBe(false);

    compileMock.mockClear();
    const fenced = await resolveReadRender(
      input({ override: 'reactive', source: '```\n\\(x\\)\n```' }),
    );
    expect(fenced.choice.renderer).toBe('reactive');
    expect(fenced.log.legacyMath).toBe(false);
  });
});
