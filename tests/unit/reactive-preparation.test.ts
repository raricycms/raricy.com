// ─────────────────────────────────────────────────────────────────────────────
// reactive-preparation.test.ts —— ReactiveMD 预适配（P6/P7/P8）的纯行为用例
//
// 覆盖三块契约：
//   · 图片加载策略；
//   · 编译缓存键 + 按字节容量 LRU；
//   · 语料输入的校验与报告隐私边界（逐字段报告统计见 R4 报告，已清退）。
//
// 这里刻意全部用行为断言，不读源码字符串 —— 改实现时测试应该仍能表达「行为没变」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';

import { isAllowedReactiveImage } from '@/lib/reactive/url-policy';
import {
  ReactiveLruCache,
  estimateReactiveCacheBytes,
  reactiveCompileCacheKey,
  sha256Hex,
} from '@/lib/reactive/cache';
import {
  scanCorpusDocuments,
  validateCorpusDocuments,
} from '@/lib/reactive/corpus';

// ═══════════════════════════════════════════════════════════════════════════
// 一、URL 白名单
// ═══════════════════════════════════════════════════════════════════════════

describe('图片加载策略', () => {
  it('图片：站内相对 / 历史路径 / 历史 IP / 外链 http(s) 都放行', () => {
    const allowed = [
      '/api/images/AbCdEf1234/raw',
      '/image/i/AbCdEf1234',
      '/api/avatar/user-1',
      '/static/frames/ring.png',
      'images/a.png',
      'https://cdn.example.com/a.png',
      'http://cdn.example.com/a.png',
      'http://116.62.179.232:22822/image/i/AbCdEf1234',
      '//cdn.example.com/a.png',
    ];
    for (const url of allowed) {
      expect(isAllowedReactiveImage(url), url).toBe(true);
    }
  });

  it('拒绝危险或混淆协议', () => {
    const denied = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/x',
      'about:blank',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      ' javascript:alert(1)',
      'java\\script:alert(1)',
      'https://raricy.com@evil.example/a.png',
      'https://user:pass@evil.example/a.png',
    ];
    for (const url of denied) {
      expect(isAllowedReactiveImage(url), url).toBe(false);
    }
  });

  it('拒绝片段、空串与超长地址', () => {
    expect(isAllowedReactiveImage('#top')).toBe(false);
    expect(isAllowedReactiveImage('')).toBe(false);
    expect(isAllowedReactiveImage(`https://example.com/${'a'.repeat(9000)}`)).toBe(
      false
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、缓存键与按字节 LRU
// ═══════════════════════════════════════════════════════════════════════════

describe('编译缓存键', () => {
  const base = {
    adaptedSource: 'hello',
    syntaxVersion: 'local-draft-2',
    compilerVersion: '0.5.2',
    adapterVersion: '1',
    optionsKey: 'opts',
  };

  it('键由源码摘要与四段版本组成，且完全确定', () => {
    const expected = `${sha256Hex('hello')}:local-draft-2:0.5.2:1:opts`;
    expect(reactiveCompileCacheKey(base)).toBe(expected);
    expect(reactiveCompileCacheKey({ ...base })).toBe(expected);
  });

  it('任一输入变化都会换键', () => {
    const keys = new Set([
      reactiveCompileCacheKey(base),
      reactiveCompileCacheKey({ ...base, adaptedSource: 'hello ' }),
      reactiveCompileCacheKey({ ...base, syntaxVersion: 'local-draft-3' }),
      reactiveCompileCacheKey({ ...base, compilerVersion: '0.5.3' }),
      reactiveCompileCacheKey({ ...base, adapterVersion: '2' }),
      reactiveCompileCacheKey({ ...base, optionsKey: 'opts2' }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('版本段不得含冒号；optionsKey 可以（它固定在最后一段）', () => {
    expect(() => reactiveCompileCacheKey({ ...base, syntaxVersion: '' })).toThrow();
    expect(() => reactiveCompileCacheKey({ ...base, compilerVersion: 'a:b' })).toThrow();
    expect(() => reactiveCompileCacheKey({ ...base, optionsKey: '' })).toThrow();
    expect(reactiveCompileCacheKey({ ...base, optionsKey: '{"a":1}' })).toContain(
      '{"a":1}'
    );
  });
});

describe('容量估算与 LRU', () => {
  it('只接受 JSON 安全值（NaN / undefined / 类实例 / 环都不算）', () => {
    expect(estimateReactiveCacheBytes('abc')).toBe(5); // JSON 字符串带引号
    expect(estimateReactiveCacheBytes({ a: 1 })).toBe(7);
    expect(estimateReactiveCacheBytes([])).toBe(2);
    expect(estimateReactiveCacheBytes(NaN)).toBeNull();
    expect(estimateReactiveCacheBytes(Infinity)).toBeNull();
    expect(estimateReactiveCacheBytes(undefined)).toBeNull();
    expect(estimateReactiveCacheBytes({ a: undefined })).toBeNull();
    expect(estimateReactiveCacheBytes(new (class X {})())).toBeNull();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateReactiveCacheBytes(circular)).toBeNull();
  });

  it('命中刷新最近使用顺序，按字节淘汰最久未用', () => {
    const cache = new ReactiveLruCache<string>({ maxBytes: 15 });
    expect(cache.set('a', 'aaaa')).toBe(true); // 1 + 6 字节
    expect(cache.set('b', 'bbbb')).toBe(true);
    expect(cache.get('a')).toBe('aaaa'); // a 变成最近使用
    expect(cache.set('c', 'cccc')).toBe(true);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(14);

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.evictions).toBe(1);
    expect(stats.hitRate).toBe(1);
  });

  it('单条超过总容量时拒收，且不清空已有条目', () => {
    const cache = new ReactiveLruCache<string>({ maxBytes: 10 });
    expect(cache.set('a', 'aaaa')).toBe(true);
    expect(cache.set('big', 'x'.repeat(100))).toBe(false);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('big')).toBe(false);
    expect(cache.stats().rejectedOversized).toBe(1);
  });

  it('非 JSON 值拒收但计数，不抛错', () => {
    const cache = new ReactiveLruCache<unknown>({ maxBytes: 100 });
    expect(cache.set('bad', NaN)).toBe(false);
    expect(cache.set('fn', () => 1)).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.stats().rejectedInvalid).toBe(2);
  });

  it('条数上限独立于字节容量', () => {
    const cache = new ReactiveLruCache<string>({
      maxBytes: 1000,
      maxEntries: 2,
    });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.size).toBe(2);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('键本身也计入容量；peek / has 不刷新顺序（真淘汰下才可观测，R3-160）', () => {
    const small = new ReactiveLruCache<string>({ maxBytes: 6 });
    expect(small.set('k', 'a')).toBe(true); // 1 + 3
    expect(small.set('longkey', 'a')).toBe(false); // 7 + 3 > 6

    // 旧写法用 maxBytes:100 塞 3 条（容量充足、根本没有淘汰）→「peek/has 不刷新顺序」
    // 在「刷新了顺序」的实现上也会绿。改成条数上限 2 下造真实淘汰：若 peek/has 错误
    // 地刷新顺序，被淘汰的会是 b；正确实现淘汰最旧的 a。
    const cache = new ReactiveLruCache<string>({ maxBytes: 1000, maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.peek('a');
    cache.has('a');
    cache.set('c', '3');
    expect(cache.has('a'), 'peek/has 刷新了顺序 —— 被淘汰的应是 a').toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });
});
describe('语料输入校验', () => {
  it('非法项逐条报告，不静默丢弃', () => {
    const result = validateCorpusDocuments([
      { id: 'ok', kind: 'blog', content: 'x' },
      { id: '', kind: 'blog', content: 'x' },
      { id: 'x', kind: 'story', content: 'x' },
      { id: 'y', kind: 'clipboard' },
      { id: 'z', kind: 'blog', content: 'x', format: 'legacy' },
      { id: 'ok', kind: 'blog', content: 'y' },
    ]);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      id: 'ok',
      kind: 'blog',
      format: 'markdown',
      formatSource: 'default',
    });
    expect(result.errors.map((error) => error.code)).toEqual([
      'missing_id',
      'invalid_kind',
      'missing_content',
      'invalid_format',
      'duplicate_id',
    ]);
  });

  it('显式 format 会被保留；非数组整体报错', () => {
    const declared = validateCorpusDocuments([
      { id: 'r', kind: 'blog', content: 'x', format: 'reactive' },
    ]);
    expect(declared.documents[0]).toMatchObject({
      format: 'reactive',
      formatSource: 'declared',
    });

    const notArray = validateCorpusDocuments({ documents: [] });
    expect(notArray.documents).toHaveLength(0);
    expect(notArray.errors).toEqual([{ index: -1, code: 'not_array' }]);
  });
});
describe('语料静态风险扫描', () => {
  // R4 收敛：报告的逐字段计数（结构 / HTML / 数学 / 引用分档 / 图片来源 / 汇总）
  // 是迁移期一次性分析工具的输出格式，不是线上行为 —— 改坏了不会报错、不会 500、
  // 不会损坏用户数据，只会让一份内部报告的数字不准，靠跑一次工具复核即可。
  // 这里只保留**隐私边界**：报告与摘要不得夹带正文 / 标题（那是会静默外泄的那类）。
  // 逐篇隔离与失败记账（单篇失败不能记成成功）仍在 reactive-corpus-scan.test.ts。
  function scanOne(body: string, extra: Record<string, unknown> = {}) {
    const { documents, errors } = validateCorpusDocuments([
      { id: 'blog-1', kind: 'blog', content: body, ...extra },
    ]);
    expect(errors).toEqual([]);
    const report = scanCorpusDocuments(documents, {
      scannedAt: '2026-10-26T12:00:00+08:00',
    });
    return { report, scan: report.documents[0] };
  }

  it('报告与摘要不含正文 / 标题（隐私边界）', () => {
    const body = 'SECRET_BODY_TEXT\nSECRET_TITLE';
    const { report, scan } = scanOne(body, { title: 'SECRET_TITLE' });

    expect(scan.id).toBe('blog-1');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET_BODY_TEXT');
    expect(serialized).not.toContain('SECRET_TITLE');
    expect(serialized).not.toContain(body);
  });
});
