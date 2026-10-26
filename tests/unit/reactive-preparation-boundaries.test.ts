import { describe, expect, it } from 'vitest';
import { ADAPTER_VERSION } from '@/lib/reactive/ref-adapter';
import { ReactiveLruCache, reactiveCompileCacheKey } from '@/lib/reactive/cache';

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
});
