import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 纯决策层：编译、诊断与静态渲染全部替身，测试不碰 prisma / React / 上游包。
vi.mock('@/lib/reactive/compile', () => ({ compileReactiveSource: vi.fn() }));
vi.mock('@/lib/reactive/diagnostics', () => ({ shouldFallbackToLegacy: vi.fn(() => false) }));
vi.mock('@/lib/reactive/snapshot-store', () => ({
  reactiveContentVersion: () => 'content-version',
  readReactiveSnapshot: vi.fn(async () => ({ status: 'missing' })),
}));
import { resolveReadRender, type ReadRenderInput } from '@/lib/reactive/read-render';
import { compileReactiveSource } from '@/lib/reactive/compile';
import { shouldFallbackToLegacy } from '@/lib/reactive/diagnostics';

const compileMock = vi.mocked(compileReactiveSource);
const fallbackMock = vi.mocked(shouldFallbackToLegacy);

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
  fallbackMock.mockReset();
  fallbackMock.mockReturnValue(false);
  process.env.REACTIVE_MD_MODE = 'off';
  process.env.REACTIVE_MD_PERCENT = '100';
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.REACTIVE_MD_MODE;
  delete process.env.REACTIVE_MD_PERCENT;
  vi.restoreAllMocks();
});

describe('resolveReadRender', () => {
  it('flags off → legacy markdown without compiling', async () => {
    const result = await resolveReadRender(input());
    expect(result.choice).toEqual({ renderer: 'legacy', reason: 'flag' });
    expect(result.bundle).toBeUndefined();
    expect(result.log.format).toBe('markdown');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('markdown + override=legacy → legacy without compiling', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    const result = await resolveReadRender(input({ override: 'legacy' }));
    expect(result.choice).toEqual({ renderer: 'legacy', reason: 'override' });
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('reactive + compile failure → unavailable (never reactive)', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    compileMock.mockResolvedValue(outcome({ result: { ok: false, diagnostics: [{ code: 'local.syntax' }] } }));
    const result = await resolveReadRender(input({ format: 'reactive' }));
    expect(result.choice.renderer).toBe('unavailable');
    expect(result.failure).toBe('compile');
    expect(result.bundle).toBeDefined();
    expect(result.log.codes).toEqual(['local.syntax']);
  });

  it('reactive + fallback diagnostics → reactive-static with the current compile', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    compileMock.mockResolvedValue(outcome());
    fallbackMock.mockReturnValue(true);
    const result = await resolveReadRender(input({ format: 'reactive' }));
    expect(result.choice.renderer).toBe('reactive-static');
    expect(result.choice.reason).toBe('fallback');
    expect(result.bundle?.result.ok).toBe(true);
  });

  it('reactive + flag off → reactive-static, still never legacy', async () => {
    compileMock.mockResolvedValue(outcome());
    const result = await resolveReadRender(input({ format: 'reactive' }));
    expect(result.choice.renderer).toBe('reactive-static');
    expect(result.choice.reason).toBe('flag');
    expect(result.bundle?.result.ok).toBe(true);
  });

  it('invalid format → unavailable invalid-format without compiling', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    const result = await resolveReadRender(input({ format: 'html' }));
    expect(result.choice).toEqual({ renderer: 'unavailable', reason: 'invalid-format' });
    expect(result.failure).toBe('invalid-format');
    expect(result.log.format).toBeNull();
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('markdown candidate that fails compatibility → legacy (fallback), never reactive', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    compileMock.mockResolvedValue(outcome());
    fallbackMock.mockReturnValue(true);
    const result = await resolveReadRender(input({ override: 'reactive' }));
    expect(result.choice.renderer).toBe('legacy');
    expect(result.choice.reason).toBe('fallback');
    expect(compileMock).toHaveBeenCalledTimes(1);
  });

  it('markdown candidate that compiles cleanly → reactive', async () => {
    process.env.REACTIVE_MD_MODE = 'on';
    compileMock.mockResolvedValue(outcome());
    const result = await resolveReadRender(input({ override: 'reactive' }));
    expect(result.choice.renderer).toBe('reactive');
    expect(result.bundle?.result.ok).toBe(true);
    expect(result.log.compileMs).toBe(7);
  });
});
