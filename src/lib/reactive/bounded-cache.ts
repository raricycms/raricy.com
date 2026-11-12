// ─────────────────────────────────────────────────────────────────────────────
// bounded-cache.ts — 有界 LRU（**零 Node 依赖**，客户端 / 服务端共用）
//
// 为什么不直接用 `cache.ts` 的 `ReactiveLruCache`：那份实现为了计算真实字节数
// import 了 `node:buffer` / `node:crypto`，而本模块要被 `ref-adapter` 带进
// 编辑器预览的客户端包。这里只做「按键 + 估算大小」的淘汰，**不复制任何编译
//
// 大小单位是 **UTF-16 码元近似值**（键长 + `sizeOf` 返回值），只用于有界性，
// 不用于精确内存核算。`sizeOf` 返回 null / 非法值 = 拒收该值，不会把容量上限
// 悄悄变成 0。
// ─────────────────────────────────────────────────────────────────────────────

export interface BoundedLruCacheOptions<V> {
  /** 最多保留多少条。 */
  maxEntries: number;
  /** 近似容量上限（键长 + 值大小）。 */
  maxBytes: number;
  /** 单值大小估算；返回 null / 负数 / 非有限数 = 拒收。 */
  sizeOf: (value: V) => number | null;
}

interface Entry<V> {
  value: V;
  bytes: number;
}

export class BoundedLruCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number | null;
  private totalBytes = 0;

  constructor(options: BoundedLruCacheOptions<V>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new TypeError('maxEntries 必须是 >= 1 的整数');
    }
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError('maxBytes 必须是正数');
    }
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.sizeOf = options.sizeOf;
  }

  /** 命中会刷新最近使用顺序；值由调用方视为不可变。 */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Map 的插入顺序就是 LRU 顺序：删了再插 = 移到队尾。
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** 返回是否真的写入；超容量 / 非 JSON 大小的值直接拒收。 */
  set(key: string, value: V): boolean {
    if (typeof key !== 'string' || key.length === 0) return false;

    let valueBytes: number | null;
    try {
      valueBytes = this.sizeOf(value);
    } catch {
      return false;
    }
    if (valueBytes === null || !Number.isFinite(valueBytes) || valueBytes < 0) {
      return false;
    }

    const bytes = key.length + valueBytes;
    if (bytes > this.maxBytes) return false;

    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.totalBytes -= existing.bytes;
    }

    while (
      this.totalBytes + bytes > this.maxBytes ||
      this.map.size >= this.maxEntries
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const oldestEntry = this.map.get(oldest.value);
      this.map.delete(oldest.value);
      if (oldestEntry) this.totalBytes -= oldestEntry.bytes;
    }

    this.map.set(key, { value, bytes });
    this.totalBytes += bytes;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}
