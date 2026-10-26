// ─────────────────────────────────────────────────────────────────────────────
// compile.ts — 服务端 ReactiveMD 编译核心（适配 → 缓存 → compileLocal）
//
// 【只缓存编译产物】缓存里只放 `{ ok, document?, diagnostics }`。`hostData`、
// `segments`、`referenceSnapshotId` 都随**当前请求的权限上下文**变化（同一份源码
// 对成员与访客可以不同），放进来等于把两名用户串在一起。它们每次调用现算。
//
// 【缓存键 = 一次编译的完整身份】适配后源码 hash + 语法版本 + 编译包精确版本 +
// 适配器版本 + 选项键（计划 §5.3）。漏任一段都会静默命中「另一次编译」的结果。
//
// 【挂在 globalThis 上】Next 会把 `instrumentation.ts` 编进独立 compilation，
// 本模块可能在同一份产物里有多份实例。模块级变量 = 「一份在写、另一份在冻」，
// 不报任何错（与 market-price.ts 头部同一个理由）。
//
// 【缓存值不可变】`ReactiveLruCache` 写入时做 JSON 深拷贝并冻结；读取时再给出
// 一份新的 diagnostics 数组，调用方改自己的结果不会污染缓存。
//
// 服务端专用：不 import React / DOM。客户端只需要 `LocalDocument` 这份可序列化
// 产物（走 RSC payload），不要 import 本文件。
// ─────────────────────────────────────────────────────────────────────────────

import { compileLocal, localCompileOptionsKey, LOCAL_SYNTAX_VERSION } from 'reactive-md';
import type { Diagnostic, LocalCompileResult, LocalDocument } from 'reactive-md';

import { prepareReactiveDocument } from './prepare';
import { ReactiveLruCache, reactiveCompileCacheKey } from './cache';
import {
  REACTIVE_COMPILER_VERSION,
  REACTIVE_MAX_SYNTAX_NODES,
  reactiveCompileOptions,
} from './host-components';
import { reactiveDiagnosticCodes } from './diagnostics';
import type { AdaptedSourceSegment } from './source-map';
import type { ContentFormat } from '../content-format';
import type { ReferenceMode, SiteHostData } from './ref-types';

/**
 * 慢编译告警阈值（毫秒）。
 *
 * 只影响日志，不改变任何行为。取 250 ms：实测真实文章 250 KB 约 206 ms，所以正常
 * 内容不会触发；越过这条线就说明这份正文已经花到足以让同进程其它请求可感地排队。
 */
export const SLOW_COMPILE_WARN_MS = 250;

export interface ReactiveCompileOutcome {
  result: LocalCompileResult;
  adaptedSource: string;
  hostData: SiteHostData;
  segments: AdaptedSourceSegment[];
  referenceSnapshotId: string;
  sourceHash: string;
  adaptedHash: string;
  adapterVersion: string;
  compilerVersion: string;
  syntaxVersion: string;
  cacheKey: string;
  cacheHit: boolean;
  compileMs: number;
}

export interface ReactiveCompileInput {
  source: string;
  format: ContentFormat;
  mode: ReferenceMode;
  viewer: { id: string; role?: string; archivedAt?: Date | null } | null;
  clientIp?: string;
}

/** 缓存里允许出现的全部内容 —— 故意没有 hostData / segments / 会话数据。 */
interface CachedCompile {
  ok: boolean;
  document?: LocalDocument;
  diagnostics: Diagnostic[];
}

/** 按估算字节数计容（含 AST 与诊断），不是只数篇数。 */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 500;

interface ReactiveCompileGlobal {
  __raricyReactiveCompileCache?: ReactiveLruCache<CachedCompile>;
}

function getCache(): ReactiveLruCache<CachedCompile> {
  const g = globalThis as typeof globalThis & ReactiveCompileGlobal;
  if (!g.__raricyReactiveCompileCache) {
    g.__raricyReactiveCompileCache = new ReactiveLruCache<CachedCompile>({
      maxBytes: CACHE_MAX_BYTES,
      maxEntries: CACHE_MAX_ENTRIES,
    });
  }
  return g.__raricyReactiveCompileCache;
}

function toCacheEntry(result: LocalCompileResult): CachedCompile {
  return result.ok
    ? { ok: true, document: result.document, diagnostics: result.diagnostics }
    : { ok: false, diagnostics: result.diagnostics };
}

/**
 * 缓存产物 → 本次调用的结果。diagnostics 每次都复制一份，document 是缓存里的
 * 冻结副本（编译产物只读；要改就重新编译，不要就地改共享文档）。
 */
function fromCacheEntry(entry: CachedCompile): LocalCompileResult {
  if (entry.ok && entry.document) {
    return { ok: true, document: entry.document, diagnostics: [...entry.diagnostics] };
  }
  return { ok: false, diagnostics: [...entry.diagnostics] };
}

/** 清空编译缓存并重置计数（只给测试用；生产靠 LRU 自然淘汰）。 */
export function resetReactiveCompileCacheForTests(): void {
  const g = globalThis as typeof globalThis & ReactiveCompileGlobal;
  delete g.__raricyReactiveCompileCache;
}

/** 缓存观测值（测试 / 运维用）。 */
export function stats(): { hits: number; misses: number; entries: number; bytes: number } {
  const current = getCache().stats();
  return {
    hits: current.hits,
    misses: current.misses,
    entries: current.entries,
    bytes: current.bytes,
  };
}

/**
 * 编译一篇正文。
 *
 * 顺序固定：先适配（引用取数在请求权限上下文中发生），再查缓存，最后才编译。
 * 适配结果不缓存 —— 它的产物体积（segments / hostData）与会话数据同量级，而且
 * 缓存键本身已经用适配后源码的 hash 表达了「编译输入相同」。
 */
export async function compileReactiveSource(
  input: ReactiveCompileInput
): Promise<ReactiveCompileOutcome> {
  const startedAt = performance.now();

  const prepared = await prepareReactiveDocument(input.source, {
    mode: input.mode,
    viewer: input.viewer,
    clientIp: input.clientIp,
  });

  const options = reactiveCompileOptions(input.format);
  const cacheKey = reactiveCompileCacheKey({
    adaptedSource: prepared.adaptedSource,
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    compilerVersion: REACTIVE_COMPILER_VERSION,
    adapterVersion: prepared.adapterVersion,
    optionsKey: localCompileOptionsKey(options),
  });

  const cache = getCache();
  const cached = cache.get(cacheKey);
  let cacheHit: boolean;
  let result: LocalCompileResult;

  if (cached) {
    cacheHit = true;
    result = fromCacheEntry(cached);
  } else {
    cacheHit = false;
    result = compileLocal(prepared.adaptedSource, options);
    // 失败结果也缓存：同一份坏文档不必每次请求都重编译一遍。
    cache.set(cacheKey, toCacheEntry(result));
  }

  const compileMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  // 只记诊断码与耗时，绝不打印正文（源码可能含私有内容）。
  console.info(
    '[reactive]',
    JSON.stringify({ cacheHit, compileMs, codes: reactiveDiagnosticCodes(result) })
  );
  // 慢编译告警：`compileLocal` 是同步的，落在被 await 的渲染路径上，编译期间整个
  // 进程的其它请求一起排队（见 host-components.ts 的 REACTIVE_MAX_SYNTAX_NODES）。
  // 这条**只观测、不降级** —— 兜底交给编译器自己的 `local.budget`（预算超了直接
  // 判 ok:false），在这里把「编译慢但成功」改成 unavailable 等于让一篇合法长文
  // 永久打不开。留这条是为了让运维看得见真实分布，再决定要不要收紧预算。
  if (!cacheHit && compileMs >= SLOW_COMPILE_WARN_MS) {
    console.warn(
      '[reactive-slow]',
      JSON.stringify({
        compileMs,
        budget: REACTIVE_MAX_SYNTAX_NODES,
        format: input.format,
        mode: input.mode,
        codes: reactiveDiagnosticCodes(result),
      })
    );
  }

  return {
    result,
    adaptedSource: prepared.adaptedSource,
    hostData: prepared.hostData,
    segments: prepared.segments,
    referenceSnapshotId: prepared.referenceSnapshotId,
    sourceHash: prepared.sourceHash,
    adaptedHash: prepared.adaptedHash,
    adapterVersion: prepared.adapterVersion,
    compilerVersion: REACTIVE_COMPILER_VERSION,
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    cacheKey,
    cacheHit,
    compileMs,
  };
}
