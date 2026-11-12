import { compileSource } from './compile-source';
import { LOCAL_SYNTAX_VERSION, localCompileOptionsKey, type LocalCompileResult } from 'reactive-md';
import type { ContentFormat } from '../content-format';
import { ReactiveLruCache, reactiveCompileCacheKey } from './cache';
import { REACTIVE_COMPILER_VERSION, REACTIVE_COMPILE_OPTIONS } from './host-components';
import { ADAPTER_VERSION, expandDocumentReferences } from './ref-adapter';
import { createServiceReferenceReader } from './ref-reader';
import type { ReferenceMode, SiteHostData } from './ref-types';

export interface ReactiveCompileInput {
  source: string;
  format: ContentFormat;
  mode: ReferenceMode;
  viewer: { id: string; role?: string; archivedAt?: Date | null } | null;
  clientIp?: string;
}

export interface ReactiveCompileOutcome {
  result: LocalCompileResult;
  hostData: SiteHostData;
  compilerVersion: string;
  syntaxVersion: string;
  cacheKey: string;
  cacheHit: boolean;
  compileMs: number;
}

const globals = globalThis as typeof globalThis & {
  __raricyReactiveCompileCache?: ReactiveLruCache<LocalCompileResult>;
};

function getCache() {
  return globals.__raricyReactiveCompileCache ??= new ReactiveLruCache<LocalCompileResult>({
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 500,
  });
}

export function resetReactiveCompileCacheForTests(): void {
  delete globals.__raricyReactiveCompileCache;
}

export function stats() {
  return getCache().stats();
}

export async function compileReactiveSource(input: ReactiveCompileInput): Promise<ReactiveCompileOutcome> {
  const started = performance.now();
  const cacheKey = reactiveCompileCacheKey({
    adaptedSource: input.source,
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    compilerVersion: REACTIVE_COMPILER_VERSION,
    adapterVersion: ADAPTER_VERSION,
    optionsKey: localCompileOptionsKey(REACTIVE_COMPILE_OPTIONS),
  });
  const cache = getCache();
  const cached = cache.get(cacheKey);
  const compiled = cached ?? compileSource(input.source, REACTIVE_COMPILE_OPTIONS);
  if (!cached) cache.set(cacheKey, compiled);
  const compileMs = performance.now() - started;

  // The cached AST is shared. Resolve authorized reference data for this reader only.
  const expanded = compiled.ok ? await expandDocumentReferences(compiled.document, {
    mode: input.mode,
    resolve: input.mode === 'expand'
      ? createServiceReferenceReader('expand', input.viewer, input.clientIp)
      : undefined,
  }) : null;

  return {
    result: {
      ...compiled,
      ...(compiled.ok && expanded ? { document: expanded.document } : {}),
      diagnostics: [...compiled.diagnostics],
      ...(compiled.recoveries ? { recoveries: [...compiled.recoveries] } : {}),
    },
    hostData: expanded?.hostData ?? {},
    compilerVersion: REACTIVE_COMPILER_VERSION,
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    cacheKey,
    cacheHit: cached !== undefined,
    compileMs,
  };
}
