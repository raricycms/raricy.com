import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 纯决策层：编译、快照、external 重验全部替身。不碰 prisma / React / 上游运行时。
vi.mock('@/lib/reactive/compile-content', () => ({ compileContent: vi.fn() }));
vi.mock('@/lib/reactive/snapshot-store', () => ({
  reactiveContentVersion: () => 'content-version',
  readReactiveSnapshot: vi.fn(),
}));
vi.mock('@/lib/reactive/prepare', () => ({ prepareReactiveDocument: vi.fn() }));

import { resolveReadRender, type ReadRenderInput } from '@/lib/reactive/read-render';
import { compileContent } from '@/lib/reactive/compile-content';
import { readReactiveSnapshot } from '@/lib/reactive/snapshot-store';
import { prepareReactiveDocument } from '@/lib/reactive/prepare';
import { hasLegacyMathDelimiters } from '@/lib/reactive/legacy-math';

const compileMock = vi.mocked(compileContent);
const snapshotMock = vi.mocked(readReactiveSnapshot);
const prepareMock = vi.mocked(prepareReactiveDocument);

const CLIP_ID = '12345678';
const CLIP_KEY = `clipboard:${CLIP_ID}`;
const CLIP_TOKEN = `[@${CLIP_ID}]`;

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    outcome: {
      result: {
        ok: true,
        document: { syntax: 'local', nodes: [], bindings: {}, initialState: {} },
        diagnostics: [],
      },
      adaptedSource: 'adapted',
      hostData: {},
      segments: [],
      referenceSnapshotId: 'snap',
      sourceHash: 'source',
      adaptedHash: 'adapted',
      adapterVersion: 'test-adapter',
      compilerVersion: 'test-compiler',
      syntaxVersion: 'local-draft-3',
      compatCounts: {},
      cacheKey: 'key',
      cacheHit: false,
      compileMs: 7,
      ...overrides,
    },
  } as never;
}

function clip(title: string, version: string) {
  return { kind: 'clipboard', ref: CLIP_ID, status: 'ready', title, format: 'markdown', version };
}

function readySnapshot(hostData: Record<string, unknown>) {
  snapshotMock.mockResolvedValue({
    status: 'ready',
    payload: { document: { syntax: 'local', nodes: [] }, hostData },
  } as never);
}

function prepareReturns(hostData: Record<string, unknown>) {
  prepareMock.mockResolvedValue({ hostData } as never);
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
  delete process.env.REACTIVE_MD_MODE;
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.REACTIVE_MD_MODE;
  vi.restoreAllMocks();
});

describe('persistent snapshot reference revalidation', () => {
  it('keeps the snapshot when current external data matches, without compiling', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareReturns({ [CLIP_KEY]: clip('旧标题', 'v1') });

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.choice.renderer).toBe('reactive');
    expect(result.snapshot).toBeDefined();
    expect(result.bundle).toBeUndefined();
    expect(result.log.snapshotStatus).toBe('ready');
    expect(compileMock).not.toHaveBeenCalled();
    // 重验固定按 external，与快照的生成范围一致。
    expect(prepareMock.mock.calls[0][1]).toMatchObject({ mode: 'external' });
  });

  it('recompiles under external scope when the old snapshot references changed', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareReturns({ [CLIP_KEY]: clip('新标题', 'v2') });
    compileMock.mockResolvedValue(outcome());

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.choice.renderer).toBe('reactive');
    expect(result.snapshot).toBeUndefined();
    expect(result.bundle).toBeDefined();
    expect(result.log.snapshotStatus).toBe('stale-references');
    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'external' }));
  });

  it('reports unavailable when revalidation throws and replacement compilation fails', async () => {
    const source = `正文 ${CLIP_TOKEN}`;
    readySnapshot({ [CLIP_KEY]: clip('旧标题', 'v1') });
    prepareMock.mockRejectedValue(new Error('db down'));
    compileMock.mockRejectedValue(new Error('still down'));

    const result = await resolveReadRender(input({ format: 'reactive', source }));

    expect(result.choice.renderer).toBe('unavailable');
    expect(result.failure).toBe('compile');
    expect(result.snapshot).toBeUndefined();
  });

  it('成员引用视图专用：编译失败时用访客快照兜底静态显示', async () => {
    snapshotMock.mockResolvedValue({
      status: 'ready',
      payload: { document: { syntax: 'local', nodes: [] }, hostData: {} },
    } as never);
    compileMock.mockResolvedValue(
      outcome({ result: { ok: false, diagnostics: [{ code: 'local.budget' }] } })
    );
    const result = await resolveReadRender(
      input({
        format: 'reactive',
        source: `正文 ${CLIP_TOKEN}`,
        mode: 'expand',
        viewer: { id: 'member', role: 'core' },
      })
    );
    expect(result.choice.renderer).toBe('reactive-static');
    expect(result.snapshot).toBeDefined();
    expect(result.log.snapshotStatus).toBe('ready-fallback');
  });
});

describe('legacy backslash math observation', () => {
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
});
