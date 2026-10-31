import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 纯决策层：编译 / 快照 / 引用重验全部替身，不碰 prisma / React / 上游包。
vi.mock('@/lib/reactive/compile-content', () => ({ compileContent: vi.fn() }));
vi.mock('@/lib/reactive/snapshot-store', () => ({
  reactiveContentVersion: () => 'content-version',
  readReactiveSnapshot: vi.fn(async () => ({ status: 'missing' })),
}));
vi.mock('@/lib/reactive/snapshot-revalidation', () => ({
  hasMutableExternalReferences: vi.fn(() => false),
  hostDataEqual: vi.fn(() => true),
}));
import { resolveReadRender, type ReadRenderInput } from '@/lib/reactive/read-render';
import { compileContent } from '@/lib/reactive/compile-content';
import { readReactiveSnapshot } from '@/lib/reactive/snapshot-store';
import { hasMutableExternalReferences, hostDataEqual } from '@/lib/reactive/snapshot-revalidation';

const compileMock = vi.mocked(compileContent);
const snapshotMock = vi.mocked(readReactiveSnapshot);
const mutableMock = vi.mocked(hasMutableExternalReferences);
const equalMock = vi.mocked(hostDataEqual);

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
  snapshotMock.mockReset().mockResolvedValue({ status: 'missing' });
  compileMock.mockReset();
  mutableMock.mockReset().mockReturnValue(false);
  equalMock.mockReset().mockReturnValue(true);
  delete process.env.REACTIVE_MD_MODE;
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.REACTIVE_MD_MODE;
  vi.restoreAllMocks();
});

describe('resolveReadRender（统一管线）', () => {
  it('★ 默认不设 flag：Markdown 也走新引擎并返回可交互路径 ★', async () => {
    compileMock.mockResolvedValue(outcome());
    const result = await resolveReadRender(input());
    expect(result.choice).toEqual({ renderer: 'reactive', reason: 'format' });
    expect(result.bundle?.result.ok).toBe(true);
    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({ format: 'markdown' }));
  });

  it('快照命中：访客不发编译，直接返回同版本静态 + 可交互外壳', async () => {
    snapshotMock.mockResolvedValue({
      status: 'ready',
      payload: { document: { syntax: 'local', nodes: [] }, hostData: {} },
    } as never);
    const result = await resolveReadRender(input());
    expect(result.choice.renderer).toBe('reactive');
    expect(result.snapshot).toBeDefined();
    expect(result.bundle).toBeUndefined();
    expect(compileMock).not.toHaveBeenCalled();
    expect(result.log.snapshotStatus).toBe('ready');
  });

  it('成员引用视图按本人权限现编译，不把访客快照当展开结果', async () => {
    snapshotMock.mockResolvedValue({
      status: 'ready',
      payload: { document: { syntax: 'local', nodes: [] }, hostData: {} },
    } as never);
    compileMock.mockResolvedValue(outcome({ hostData: { 'clipboard:AbCd1234': { kind: 'clipboard', ref: 'AbCd1234', status: 'ready', title: '成员片段' } } }));
    const result = await resolveReadRender(
      input({ source: '[@AbCd1234]', mode: 'expand', viewer: { id: 'member', role: 'core' } })
    );
    expect(result.choice.renderer).toBe('reactive');
    expect(result.bundle?.hostData['clipboard:AbCd1234'].title).toBe('成员片段');
    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'expand' }));
  });

  it('显式事故回退 REACTIVE_MD_MODE=off：Markdown 回旧引擎且不编译', async () => {
    process.env.REACTIVE_MD_MODE = 'off';
    const result = await resolveReadRender(input());
    expect(result.choice).toEqual({ renderer: 'legacy', reason: 'flag' });
    expect(result.bundle).toBeUndefined();
    expect(compileMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('reactive + 事故回退：用同版本快照静态渲染，绝不交给旧解析器', async () => {
    process.env.REACTIVE_MD_MODE = 'off';
    snapshotMock.mockResolvedValue({
      status: 'ready',
      payload: { document: { syntax: 'local', nodes: [] }, hostData: {} },
    } as never);
    const result = await resolveReadRender(input({ format: 'reactive' }));
    expect(result.choice).toEqual({ renderer: 'reactive-static', reason: 'format' });
    expect(result.snapshot).toBeDefined();
  });

  it('reactive 编译失败 → unavailable，绝不回旧 Markdown', async () => {
    compileMock.mockResolvedValue(outcome({ result: { ok: false, diagnostics: [{ code: 'local.syntax' }] } }));
    const result = await resolveReadRender(input({ format: 'reactive' }));
    expect(result.choice.renderer).toBe('unavailable');
    expect(result.failure).toBe('compile');
    expect(result.log.codes).toEqual(['local.syntax']);
  });

  it('Markdown 编译失败且没快照 → unavailable，失败原因归到 compile', async () => {
    compileMock.mockResolvedValue(outcome({ result: { ok: false, diagnostics: [{ code: 'local.budget' }] } }));
    const result = await resolveReadRender(input());
    expect(result.choice.renderer).toBe('unavailable');
    expect(result.failure).toBe('compile');
  });

  it('invalid format → unavailable invalid-format，不编译', async () => {
    const result = await resolveReadRender(input({ format: 'html' }));
    expect(result.choice).toEqual({ renderer: 'unavailable', reason: 'invalid-format' });
    expect(result.failure).toBe('invalid-format');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('旧快照引用数据变化 → 按 external 重新编译替代', async () => {
    mutableMock.mockReturnValue(true);
    equalMock.mockReturnValue(false);
    snapshotMock.mockResolvedValue({
      status: 'ready',
      payload: { document: { syntax: 'local', nodes: [] }, hostData: { old: true } },
    } as never);
    compileMock.mockResolvedValue(outcome());
    const result = await resolveReadRender(input({ source: '[@AbCd1234]' }));
    expect(result.choice.renderer).toBe('reactive');
    expect(result.log.snapshotStatus).toBe('stale-references');
    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'external' }));
  });
});
