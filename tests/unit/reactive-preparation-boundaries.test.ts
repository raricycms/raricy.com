import { describe, expect, it, vi } from 'vitest';
import { ADAPTER_VERSION } from '@/lib/reactive/ref-adapter';
import { ReactiveLruCache, reactiveCompileCacheKey } from '@/lib/reactive/cache';
import { publishSnapshot, type SnapshotVersionRef } from '@/lib/reactive/snapshot';

describe('preparation module boundaries', () => {
  it('accepts the actual adapter version in compile keys', () => {
    expect(() => reactiveCompileCacheKey({
      adaptedSource: 'text', syntaxVersion: 'local-draft-2', compilerVersion: '0.5.2',
      adapterVersion: ADAPTER_VERSION, optionsKey: 'default',
    })).not.toThrow();
  });

  it('isolates cached compilation data from caller mutation and rejects runtime objects', () => {
    const cache = new ReactiveLruCache({ maxBytes: 1000, sizeOf: () => 1 });
    const source = { document: { source: 'original' } };
    expect(cache.set('doc', source)).toBe(true);
    source.document.source = 'changed';
    expect(cache.get('doc')).toEqual({ document: { source: 'original' } });
    expect(Object.isFrozen((cache.get('doc') as typeof source).document)).toBe(true);
    expect(cache.set('runtime', { dispose() {} })).toBe(false);
  });

  it('captures the publication version before waiting for the generator', async () => {
    const ref: SnapshotVersionRef = {
      contentId: 'blog:a', contentVersion: 'v1', syntaxVersion: 'local-draft-2',
      compilerVersion: '0.5.2', adapterVersion: ADAPTER_VERSION, optionsKey: 'default',
    };
    let release!: () => void;
    const generated = new Promise<void>((resolve) => { release = resolve; });
    const store = { commit: vi.fn(async () => {}), readLatest: async () => null };
    const pending = publishSnapshot({
      ref, store, generatedAt: '2026-10-26T01:00:00+08:00',
      generator: async () => { await generated; return '<p>v1</p>'; },
    });
    ref.contentVersion = 'v2';
    release();
    const result = await pending;
    expect(result.status).toBe('published');
    expect(store.commit).toHaveBeenCalledWith(
      expect.objectContaining({ contentVersion: 'v1', html: '<p>v1</p>' }),
      expect.objectContaining({ contentVersion: 'v1' }),
    );
  });
});
