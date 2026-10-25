// ─────────────────────────────────────────────────────────────────────────────
// cache.ts — ReactiveMD 服务端编译缓存的**纯数据层**（Node only）
//
// 两件事：
//   1. 编译缓存的**完整版本键**。相同的键必须意味着「完全相同的一次编译」，
//      所以键里包含：适配后源码的 sha256、语法版本、编译器精确版本、适配器版本、
//      以及上游公开的 `localCompileOptionsKey(options)`。
//      ⚠️ 本文件**不实现** optionsKey —— 它是上游的公共签名；在这里重写一份等于
//      造了第二种「选项相等」的判断，上游一改就会静默命中错误的缓存。
//   2. 一个按**估算字节数**计容量的 LRU。容量要算进源码、AST、诊断与键本身，
//      不能只按条数 —— 一篇长文的编译产物可能抵得上几十篇短文。
//
// 只放**可序列化的不可变编译数据**：runtime、renderer 闭包、会话数据与
// `hostData` 都不进这里（它们随请求/视图变化，缓存它们等于把两名用户串在一起）。
// 所以默认的容量估算会拒绝非 JSON 值（函数、类实例、NaN、循环引用），而不是
// 让 `JSON.stringify` 悄悄把它们变成 `{}` / `null`。
// ─────────────────────────────────────────────────────────────────────────────

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/** 可安全跨请求复用的 JSON 值。 */
export type ReactiveJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ReactiveJsonValue[]
  | { readonly [key: string]: ReactiveJsonValue };

export interface ReactiveCacheKeyInput {
  /** 引用适配器处理后的源码（阅读页在服务端适配，编辑器在客户端适配）。 */
  adaptedSource: string;
  /** `LOCAL_SYNTAX_VERSION`（例如 `local-draft-2`）。 */
  syntaxVersion: string;
  /** 编译器包的精确版本（不是 semver 范围）。 */
  compilerVersion: string;
  /** 站点适配层自己的版本号 / 摘要。 */
  adapterVersion: string;
  /** 上游 `localCompileOptionsKey(options)` 的结果，由调用方传入。 */
  optionsKey: string;
}

/** 版本号字段必须无歧义：不含冒号/空白，键的各段才能稳定切分。 */
const VERSION_TOKEN = /^[A-Za-z0-9._+/-]+$/;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 适配后源码的摘要（缓存键的第一段，也用于语料报告/观测）。 */
export function reactiveContentHash(adaptedSource: string): string {
  if (typeof adaptedSource !== 'string') {
    throw new TypeError('adaptedSource 必须是字符串');
  }
  return sha256Hex(adaptedSource);
}

function requireVersionToken(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} 必须是非空字符串`);
  }
  if (!VERSION_TOKEN.test(value)) {
    throw new TypeError(`${name} 只能包含字母、数字、点、下划线、加号、斜杠与连字符`);
  }
  return value;
}

/**
 * 完整编译缓存键（格式与计划 §5.3 一致）。
 *
 * 各版本字段先收紧成无冒号 token，optionsKey 放在**最后一段**（它可能含冒号），
 * 于是键可以被唯一还原。不要为了「顺手」把 optionsKey 换成 JSON.stringify：
 * 上游签名变了，这里的键就没变，缓存会静默命中旧结果。
 */
export function reactiveCompileCacheKey(input: ReactiveCacheKeyInput): string {
  if (typeof input?.adaptedSource !== 'string') {
    throw new TypeError('adaptedSource 必须是字符串');
  }
  const syntaxVersion = requireVersionToken('syntaxVersion', input.syntaxVersion);
  const compilerVersion = requireVersionToken('compilerVersion', input.compilerVersion);
  const adapterVersion = requireVersionToken('adapterVersion', input.adapterVersion);
  if (typeof input.optionsKey !== 'string' || input.optionsKey.length === 0) {
    throw new TypeError('optionsKey 必须是非空字符串（由上游 localCompileOptionsKey 生成）');
  }
  return [
    sha256Hex(input.adaptedSource),
    syntaxVersion,
    compilerVersion,
    adapterVersion,
    input.optionsKey,
  ].join(':');
}

/** UTF-8 字节数（与容量单位一致）。 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 是否为可缓存的 JSON 值。
 *
 * 比 `JSON.stringify` 多拦三件会**静默失真**的事：
 *   · NaN / Infinity → JSON 变 `null`；
 *   · 类实例 / Date / Map → JSON 变 `{}`；
 *   · 函数 / undefined / Symbol / BigInt → 被丢弃或抛错。
 * 编译产物只应该有纯对象与数组，出现上面任何一种都是调用方接错了。
 */
export function isReactiveJsonValue(
  value: unknown,
  seen: Set<object> = new Set()
): value is ReactiveJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }

  const object = value as object;
  // 同一对象在非循环结构里出现两次是合法的；用「进栈/出栈」区分共享引用与环。
  if (seen.has(object)) return false;
  seen.add(object);
  let ok: boolean;
  if (Array.isArray(object)) {
    ok = object.every((item) => isReactiveJsonValue(item, seen));
  } else {
    const proto = Object.getPrototypeOf(object);
    const plain = proto === Object.prototype || proto === null;
    ok =
      plain &&
      Object.keys(object).every((key) =>
        isReactiveJsonValue((object as Record<string, unknown>)[key], seen)
      );
  }
  seen.delete(object);
  return ok;
}

/**
 * 是否为可缓存的 JSON 对象（排除 null / 数组 / 原始值）。
 * 用于 `publicData` 这类「必须是键值对象」的跨界数据。
 */
export function isReactiveJsonObject(
  value: unknown
): value is { readonly [key: string]: ReactiveJsonValue } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isReactiveJsonValue(value)
  );
}

/**
 * 估算一个值在缓存里占多少字节（JSON 文本的 UTF-8 长度）。
 *
 * 返回 null = 不是可缓存的 JSON 值。调用方（LRU）据此**拒绝**，不要退化成
 * `0` 或 `String(value).length` —— 那会让容量上限悄悄失效。
 */
export function estimateReactiveCacheBytes(value: unknown): number | null {
  if (!isReactiveJsonValue(value)) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;
  return utf8ByteLength(serialized);
}

export interface ReactiveLruCacheOptions {
  /** 容量上限（字节，含键与值）。 */
  maxBytes: number;
  /** 可选条数上限；默认只受字节容量约束。 */
  maxEntries?: number;
  /**
   * 自定义条目大小（不含键，键的字节会另外加上）。
   * 返回 null / 负数 / 非有限数 = 拒收。默认走 `estimateReactiveCacheBytes`。
   */
  sizeOf?: (value: unknown) => number | null;
}

export interface ReactiveLruCacheStats {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  rejectedOversized: number;
  rejectedInvalid: number;
  entries: number;
  bytes: number;
  maxBytes: number;
  hitRate: number;
}

interface CacheEntry<V> {
  value: V;
  /** 键 + 值的估算字节数。 */
  bytes: number;
}

/** Cache ownership starts with a copy; callers keep ownership of their input objects. */
function frozenJsonCopy<V>(value: V): V {
  const freeze = (item: unknown): unknown => {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(JSON.stringify(value))) as V;
}

/**
 * 按字节容量淘汰的 LRU。
 *
 * 语义：
 *   · `get` 命中会刷新最近使用顺序；`peek` / `has` 不会；
 *   · 单条**超过总容量**时直接拒收，而且**不清空已有条目**（先判大小再淘汰）；
 *   · 插入前按 LRU 淘汰，直到放得下且不超条数上限；
 *   · 非 JSON 值 / 负数大小拒收并计数，不抛错（缓存失败不该拖垮渲染）。
 */
export class ReactiveLruCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>();
  private readonly maxBytes: number;
  private readonly maxEntries: number | null;
  private readonly sizeOf: (value: unknown) => number | null;
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private evictions = 0;
  private rejectedOversized = 0;
  private rejectedInvalid = 0;

  constructor(options: ReactiveLruCacheOptions) {
    if (!Number.isFinite(options?.maxBytes) || options.maxBytes <= 0) {
      throw new TypeError('maxBytes 必须是正数');
    }
    if (
      options.maxEntries !== undefined &&
      (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)
    ) {
      throw new TypeError('maxEntries 必须是 >= 1 的整数');
    }
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries ?? null;
    this.sizeOf = options.sizeOf ?? estimateReactiveCacheBytes;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    // Map 的插入顺序就是 LRU 顺序：删了再插 = 移到队尾。
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /** 只看，不刷新最近使用顺序。 */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 返回是否真的写入。拒收时不会动已有条目。 */
  set(key: string, value: V): boolean {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('缓存键必须是非空字符串');
    }

    let cachedValue: V;
    let valueBytes: number | null;
    try {
      if (!isReactiveJsonValue(value)) {
        this.rejectedInvalid += 1;
        return false;
      }
      cachedValue = frozenJsonCopy(value);
      valueBytes = this.sizeOf(cachedValue);
    } catch {
      this.rejectedInvalid += 1;
      return false;
    }
    if (
      valueBytes === null ||
      typeof valueBytes !== 'number' ||
      !Number.isFinite(valueBytes) ||
      valueBytes < 0
    ) {
      this.rejectedInvalid += 1;
      return false;
    }

    const bytes = utf8ByteLength(key) + valueBytes;
    if (bytes > this.maxBytes) {
      this.rejectedOversized += 1;
      return false;
    }

    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.totalBytes -= existing.bytes;
    }

    while (
      this.totalBytes + bytes > this.maxBytes ||
      (this.maxEntries !== null && this.map.size >= this.maxEntries)
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const oldestEntry = this.map.get(oldest.value);
      this.map.delete(oldest.value);
      if (oldestEntry) this.totalBytes -= oldestEntry.bytes;
      this.evictions += 1;
    }

    this.map.set(key, { value: cachedValue, bytes });
    this.totalBytes += bytes;
    this.sets += 1;
    return true;
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.totalBytes -= entry.bytes;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** 当前已占用的估算字节数。 */
  get bytes(): number {
    return this.totalBytes;
  }

  stats(): ReactiveLruCacheStats {
    const lookups = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
      rejectedOversized: this.rejectedOversized,
      rejectedInvalid: this.rejectedInvalid,
      entries: this.map.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
    };
  }
}
