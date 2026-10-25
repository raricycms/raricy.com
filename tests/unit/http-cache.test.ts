// http-cache.ts —— 原始字节路由共用的条件请求词汇（纯函数，不需要 DB / fs）。
//
// 这组用例钉的是**两条 raw 路由共同的缓存口径**：公开字节 no-cache + 弱 ETag，
// 私有字节 private, no-store。理由见 src/lib/http-cache.ts 文件头：
// raw 路由的「存在性」可变（软删 → 404），发 immutable 就等于让浏览器一年
// 不回来问，删掉的图/录音在访客屏幕上一直活着。

import { describe, it, expect } from 'vitest';
import {
  PRIVATE_BYTES_CACHE_CONTROL,
  PUBLIC_BYTES_CACHE_CONTROL,
  ifNoneMatchMatches,
  weakFileEtag,
} from '@/lib/http-cache';

describe('weakFileEtag', () => {
  const base = { size: 1234, mtimeMs: 1_699_999_999_123.456, ctimeMs: 1_699_999_998_000.789 };

  it('形状是 W/"<size>-<mtime 毫秒>-<ctime 毫秒>"，不带小数', () => {
    expect(weakFileEtag(base)).toBe('W/"1234-1699999999123-1699999998000"');
  });

  it('size / mtime / ctime 任一变化 → ETag 变化（换文件必须让旧 304 失效）', () => {
    const etag = weakFileEtag(base);
    expect(weakFileEtag({ ...base, size: 1235 })).not.toBe(etag);
    expect(weakFileEtag({ ...base, mtimeMs: base.mtimeMs + 1 })).not.toBe(etag);
    // ctime 这一格专治 `cp -p` / `rsync -t`：它们保留 mtime，却保留不了 ctime
    expect(weakFileEtag({ ...base, ctimeMs: base.ctimeMs + 1 })).not.toBe(etag);
  });

  it('同一份元信息 → 稳定的字符串（304 的前提）', () => {
    expect(weakFileEtag(base)).toBe(weakFileEtag({ ...base }));
  });
});

describe('ifNoneMatchMatches', () => {
  const etag = 'W/"100-1700000000000"';

  it('没有头 / 空串 → 不命中', () => {
    expect(ifNoneMatchMatches(null, etag)).toBe(false);
    expect(ifNoneMatchMatches('', etag)).toBe(false);
  });

  it('客户端原样回显 → 命中', () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
  });

  it('弱比较：强 / 弱写法都能对上（RFC 9110 §13.1.2）', () => {
    // 我们的 ETag 是弱的；客户端可能去掉 W/ 变成强形态再发回来。
    expect(ifNoneMatchMatches('"100-1700000000000"', etag)).toBe(true);
    expect(ifNoneMatchMatches('W/"100-1700000000000"', etag)).toBe(true);
  });

  it('逗号列表里任意一个命中即可', () => {
    expect(ifNoneMatchMatches('"other", W/"100-1700000000000"', etag)).toBe(true);
    expect(ifNoneMatchMatches('"other", "another"', etag)).toBe(false);
  });

  it('`*` 命中（RFC：代表「任何当前表示」）', () => {
    expect(ifNoneMatchMatches('*', etag)).toBe(true);
    expect(ifNoneMatchMatches('*, "other"', etag)).toBe(true);
  });

  it('不同的 ETag 不命中', () => {
    expect(ifNoneMatchMatches('W/"100-1700000000001"', etag)).toBe(false);
  });
});

describe('缓存口径常量', () => {
  it('公开字节：必须 no-cache，绝不能出现 immutable / max-age', () => {
    expect(PUBLIC_BYTES_CACHE_CONTROL).toBe('public, no-cache');
    expect(PUBLIC_BYTES_CACHE_CONTROL).not.toContain('immutable');
    expect(PUBLIC_BYTES_CACHE_CONTROL).not.toContain('max-age');
  });

  it('私有字节：private, no-store（共享缓存命中会绕过鉴权）', () => {
    expect(PRIVATE_BYTES_CACHE_CONTROL).toBe('private, no-store');
  });
});
