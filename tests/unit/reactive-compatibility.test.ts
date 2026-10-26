import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
