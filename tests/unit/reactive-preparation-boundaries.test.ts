import { describe, expect, it } from 'vitest';
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import { ADAPTER_VERSION } from '@/lib/reactive/ref-adapter';
import { ReactiveLruCache, reactiveCompileCacheKey } from '@/lib/reactive/cache';
import { REACTIVE_COMPILER_VERSION } from '@/lib/reactive/host-components';

describe('preparation module boundaries', () => {
  it('accepts the actual adapter version in compile keys', () => {
    // R3-159：用**真实版本常量**组键，而不是写死的旧值 —— 版本升级后这条护栏会
    // 立刻跟着变；写死的 'local-draft-2' / '0.5.2' 只会让「真实常量能不能组键」
    // 这件事在升级后变成空断言。
    expect(() => reactiveCompileCacheKey({
      adaptedSource: 'text',
      syntaxVersion: LOCAL_SYNTAX_VERSION,
      compilerVersion: REACTIVE_COMPILER_VERSION,
      adapterVersion: ADAPTER_VERSION,
      optionsKey: 'default',
    })).not.toThrow();
    // 真值也必须能进键（含冒号/空串的版本段才该被拒 —— 见 cache 的用例）。
    expect(reactiveCompileCacheKey({
      adaptedSource: 'text',
      syntaxVersion: LOCAL_SYNTAX_VERSION,
      compilerVersion: REACTIVE_COMPILER_VERSION,
      adapterVersion: ADAPTER_VERSION,
      optionsKey: 'default',
    })).toContain(LOCAL_SYNTAX_VERSION);
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
