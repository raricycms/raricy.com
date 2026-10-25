// ─────────────────────────────────────────────────────────────────────────────
// reactive-preparation.test.ts —— ReactiveMD 预适配（P6/P7/P8）的纯行为用例
//
// 覆盖四块新契约：
//   · URL 用途白名单（图片 / 音频 / 超链接）；
//   · 编译缓存键 + 按字节容量 LRU；
//   · 静态快照的发布 / 拒读 / 原子失败；
//   · 语料静态扫描（盖码、结构/语法风险、预算、隐私边界）。
//
// 这里刻意全部用行为断言，不读源码字符串 —— 改实现时测试应该仍能表达「行为没变」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';

import { isAllowedReactiveUrl } from '@/lib/reactive/url-policy';
import {
  ReactiveLruCache,
  estimateReactiveCacheBytes,
  reactiveCompileCacheKey,
  reactiveContentHash,
  sha256Hex,
} from '@/lib/reactive/cache';
import {
  SnapshotVersionConflictError,
  publishSnapshot,
  readSnapshot,
  type SnapshotStore,
  type SnapshotVersionRef,
  type StaticSnapshotRecord,
} from '@/lib/reactive/snapshot';
import {
  scanCorpusDocuments,
  validateCorpusDocuments,
} from '@/lib/reactive/corpus';

// ═══════════════════════════════════════════════════════════════════════════
// 一、URL 白名单
// ═══════════════════════════════════════════════════════════════════════════

describe('URL 用途白名单', () => {
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
      expect(isAllowedReactiveUrl(url, 'image'), url).toBe(true);
    }
  });

  it('音频只认本站受控路径（外链音频一律拒绝）', () => {
    expect(isAllowedReactiveUrl('/api/audio/AbCdEf1234/raw', 'audio')).toBe(true);
    expect(isAllowedReactiveUrl('/api/audio/AbCdEf1234/raw?x=1', 'audio')).toBe(false);
    expect(isAllowedReactiveUrl('/api/audio/AbCdEf1234', 'audio')).toBe(false);
    expect(isAllowedReactiveUrl('/api/images/AbCdEf1234/raw', 'audio')).toBe(false);
    expect(isAllowedReactiveUrl('/api/audio/../../etc/passwd', 'audio')).toBe(false);
    expect(isAllowedReactiveUrl('https://tracker.example.com/a.mp3', 'audio')).toBe(false);
    expect(isAllowedReactiveUrl('//tracker.example.com/a.mp3', 'audio')).toBe(false);
    expect(isAllowedReactiveUrl('audio/a.mp3', 'audio')).toBe(false);
  });

  it('超链接：相对 / 片段 / mailto / tel / http(s) 放行', () => {
    const allowed = [
      '/blog/1',
      'blog/1',
      '#section',
      '?page=2',
      'https://example.com/page',
      'http://example.com/page',
      'mailto:someone@example.com',
      'tel:+8613800000000',
      '//example.com/page',
    ];
    for (const url of allowed) {
      expect(isAllowedReactiveUrl(url, 'link'), url).toBe(true);
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
      'javascript%3Aalert(1)',
      '&#106;avascript&#58;alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      ' javascript:alert(1)',
      'java\\script:alert(1)',
      'https://raricy.com@evil.example/a.png',
      'https://user:pass@evil.example/a.png',
    ];
    for (const url of denied) {
      expect(isAllowedReactiveUrl(url, 'image'), url).toBe(false);
      expect(isAllowedReactiveUrl(url, 'link'), url).toBe(false);
      expect(isAllowedReactiveUrl(url, 'audio'), url).toBe(false);
    }
  });

  it('片段只对超链接有意义；空串与超长地址拒绝', () => {
    expect(isAllowedReactiveUrl('#top', 'image')).toBe(false);
    expect(isAllowedReactiveUrl('#top', 'link')).toBe(true);
    expect(isAllowedReactiveUrl('', 'image')).toBe(false);
    expect(isAllowedReactiveUrl(`https://example.com/${'a'.repeat(9000)}`, 'image')).toBe(
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
    expect(reactiveContentHash('hello')).toBe(sha256Hex('hello'));
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

  it('键本身也计入容量；peek / has 不刷新顺序', () => {
    const small = new ReactiveLruCache<string>({ maxBytes: 6 });
    expect(small.set('k', 'a')).toBe(true); // 1 + 3
    expect(small.set('longkey', 'a')).toBe(false); // 7 + 3 > 6

    const cache = new ReactiveLruCache<string>({ maxBytes: 100 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.peek('a');
    cache.has('a');
    cache.set('c', '3');
    // 没有刷新，a 仍是最旧的；但容量足够，不淘汰。
    expect(cache.has('a')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、静态快照契约
// ═══════════════════════════════════════════════════════════════════════════

const REF: SnapshotVersionRef = {
  contentId: 'blog-1',
  contentVersion: 'v1',
  syntaxVersion: 'local-draft-2',
  compilerVersion: '0.5.2',
  adapterVersion: '1',
  optionsKey: 'opts',
};
const GENERATED_AT = '2026-10-26T12:00:00+08:00';

function makeStore(initial: StaticSnapshotRecord | null = null) {
  const committed: StaticSnapshotRecord[] = [];
  const state = { latest: initial, conflict: false };
  const store: SnapshotStore = {
    async commit(record, expected) {
      if (state.conflict) {
        throw new SnapshotVersionConflictError(
          expected.contentId,
          expected.contentVersion,
          'v-other'
        );
      }
      committed.push(record);
      state.latest = record;
    },
    async readLatest(contentId) {
      return state.latest?.contentId === contentId ? state.latest : null;
    },
  };
  return { store, committed, state };
}

async function publishOk(html = '<article>ok</article>') {
  const { store, committed, state } = makeStore();
  const generator = vi.fn(async () => html);
  const result = await publishSnapshot({
    ref: REF,
    generator,
    store,
    generatedAt: GENERATED_AT,
  });
  if (result.status !== 'published') throw new Error(`expected published, got ${result.status}`);
  return { result, store, committed, state, generator, record: result.record };
}

describe('静态快照发布', () => {
  it('成功时只 commit 一次，记录带摘要 / 字节数 / external 范围', async () => {
    const { committed, generator, record } = await publishOk();
    expect(generator).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);
    expect(record.format).toBe('reactive');
    expect(record.scope).toBe('external');
    expect(record.htmlDigest).toBe(sha256Hex(record.html));
    expect(record.byteLength).toBe(Buffer.byteLength(record.html, 'utf8'));
    expect(record.generatedAt).toBe(GENERATED_AT);
  });

  it('生成器返回 null / 抛错 / 空 HTML：都不 commit', async () => {
    const nullStore = makeStore();
    const nullResult = await publishSnapshot({
      ref: REF,
      generator: async () => null,
      store: nullStore.store,
      generatedAt: GENERATED_AT,
    });
    expect(nullResult.status).toBe('unavailable');
    expect(nullStore.committed).toHaveLength(0);

    const throwStore = makeStore();
    const throwResult = await publishSnapshot({
      ref: REF,
      generator: async () => {
        throw new Error('compile failed');
      },
      store: throwStore.store,
      generatedAt: GENERATED_AT,
    });
    expect(throwResult).toMatchObject({ status: 'unavailable', reason: 'generator-error' });
    expect(throwStore.committed).toHaveLength(0);

    const emptyStore = makeStore();
    const emptyResult = await publishSnapshot({
      ref: REF,
      generator: async () => '',
      store: emptyStore.store,
      generatedAt: GENERATED_AT,
    });
    expect(emptyResult).toMatchObject({ status: 'rejected', reason: 'invalid-html' });
    expect(emptyStore.committed).toHaveLength(0);
  });

  it('非法版本 / 范围 / 时间 / 公开数据在生成前就拒绝', async () => {
    const store = makeStore();
    const generator = vi.fn(async () => '<article>ok</article>');

    await expect(
      publishSnapshot({
        ref: { ...REF, contentVersion: '' },
        generator,
        store: store.store,
        generatedAt: GENERATED_AT,
      })
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-input' });

    await expect(
      publishSnapshot({
        ref: REF,
        generator,
        store: store.store,
        generatedAt: GENERATED_AT,
        scope: 'internal',
      })
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-scope' });

    await expect(
      publishSnapshot({
        ref: REF,
        generator,
        store: store.store,
        generatedAt: '2026-10-26 12:00:00',
      })
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-input' });

    await expect(
      publishSnapshot({
        ref: REF,
        generator,
        store: store.store,
        generatedAt: GENERATED_AT,
        publicData: { bad: () => 1 } as never,
      })
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-public-data' });

    expect(generator).not.toHaveBeenCalled();
    expect(store.committed).toHaveLength(0);
  });

  it('存储发现版本已变：返回 conflict，不视为成功', async () => {
    const store = makeStore();
    store.state.conflict = true;
    const result = await publishSnapshot({
      ref: REF,
      generator: async () => '<article>ok</article>',
      store: store.store,
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('conflict');
    expect(store.committed).toHaveLength(0);
  });
});

describe('静态快照读取', () => {
  it('同版本且摘要一致才返回 ready', async () => {
    const { store, record } = await publishOk();
    const result = await readSnapshot(store, REF);
    expect(result).toEqual({ status: 'ready', record });
  });

  it('缺快照 / 内容版本不符 / 编译签名不符都拒读', async () => {
    const empty = makeStore();
    await expect(readSnapshot(empty.store, REF)).resolves.toEqual({ status: 'missing' });

    const { store } = await publishOk();
    await expect(
      readSnapshot(store, { ...REF, contentVersion: 'v2' })
    ).resolves.toEqual({ status: 'stale', reason: 'content-version' });
    await expect(
      readSnapshot(store, { ...REF, compilerVersion: '0.5.3' })
    ).resolves.toEqual({ status: 'stale', reason: 'compile-signature' });
    await expect(
      readSnapshot(store, { ...REF, optionsKey: 'other' })
    ).resolves.toEqual({ status: 'stale', reason: 'compile-signature' });
  });

  it('范围不是 external 视为 stale（公开快照边界）', async () => {
    const { record } = await publishOk();
    const store = makeStore({ ...record, scope: 'internal' as never });
    await expect(readSnapshot(store.store, REF)).resolves.toEqual({
      status: 'stale',
      reason: 'scope',
    });
  });

  it('摘要 / 字节数 / 内容 ID / 格式被改坏都拒读', async () => {
    const { record } = await publishOk();

    const badDigest = makeStore({
      ...record,
      htmlDigest: '0'.repeat(64),
    });
    await expect(readSnapshot(badDigest.store, REF)).resolves.toEqual({
      status: 'corrupt',
      reason: 'digest',
    });

    const badSize = makeStore({
      ...record,
      byteLength: record.byteLength + 1,
    });
    await expect(readSnapshot(badSize.store, REF)).resolves.toEqual({
      status: 'corrupt',
      reason: 'size',
    });

    const badIdStore: SnapshotStore = {
      async commit() {},
      async readLatest() {
        return { ...record, contentId: 'blog-2' };
      },
    };
    await expect(readSnapshot(badIdStore, REF)).resolves.toEqual({
      status: 'corrupt',
      reason: 'content-id',
    });

    const badFormat = makeStore({ ...record, format: 'markdown' as never });
    await expect(readSnapshot(badFormat.store, REF)).resolves.toEqual({
      status: 'corrupt',
      reason: 'format',
    });
  });

  it('版本信息不完整时按缺失处理，不猜当前版本', async () => {
    const { store } = await publishOk();
    await expect(
      readSnapshot(store, { ...REF, optionsKey: '' })
    ).resolves.toEqual({ status: 'missing' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、语料静态扫描
// ═══════════════════════════════════════════════════════════════════════════

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
  const content = [
    '# 标题',
    '',
    '第一行',
    '第二行',
    '',
    '```',
    '[@AbCdEf1234] <audio class="x" onerror="y">',
    '```',
    '',
    '正文 <span class="a" style="color:red">x</span> {{ 1 + 2 }}',
    '',
    '![图片](/api/images/AbCdEf1234/raw) ![](https://example.com/a.png)',
    '',
    '![历史](http://116.62.179.232:22822/image/i/abc)',
    '',
    '[@12345678] [@123456789] [@123456] [@音频/AbCdEf1234]',
    '',
    '$\\frac{1}{2}$ \\begin{cases} a \\end{cases} \\(x\\) $$y$$',
  ].join('\n');

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

  it('报告明确标为 provisional / compile 与文本 diff 均未运行', () => {
    const { report, scan } = scanOne(content);
    expect(report.provisional).toBe(true);
    expect(report.compile).toBe('not-run');
    expect(report.textDiff).toBe('not-run');
    expect(scan.bucket).toBe('provisional');
    expect(scan.compile).toBe('not-run');
    expect(scan.textDiff).toBe('not-run');
  });

  it('代码块里的引用 / HTML / 音频不参与扫描（盖码）', () => {
    const { scan } = scanOne(content);
    // 围栏里那个 10 位 token 不能算进图床引用。
    expect(scan.refs.counts.image).toBe(0);
    // 围栏里的 <audio onerror> 不能算进 HTML / 风险标签。
    expect(scan.html.openingTags).toBe(1);
    expect(scan.html.riskyTags).toEqual({});
    expect(scan.html.withEvent).toBe(0);
    expect(scan.structure.fencedBlocks).toBe(1);
  });

  it('结构：软换行、硬换行、表格 / 任务列表 / 脚注计数', () => {
    const { scan } = scanOne(content);
    expect(scan.structure.softLineBreaks).toBe(1); // 第一行 / 第二行

    const structured = scanOne(
      [
        'a  ',
        'b',
        '',
        '| h | v |',
        '| - | - |',
        '',
        '- [x] done',
        '',
        '脚注[^1]',
        '',
        '[^1]: 说明',
        '',
        '<br>',
      ].join('\n')
    ).scan;
    expect(structured.structure.hardBreaks).toBe(1);
    expect(structured.structure.tableRows).toBe(2);
    expect(structured.structure.taskListItems).toBe(1);
    expect(structured.structure.footnoteMarkers).toBe(2);
    expect(structured.structure.rawBrTags).toBe(1);
  });

  it('HTML：class / style / on* / 危险标签分别计数', () => {
    const { scan } = scanOne(
      [
        '<panel name="x"></panel>',
        '<audio controls></audio>',
        '<div class="a" onclick="x()"></div>',
      ].join('\n')
    );

    expect(scan.html.openingTags).toBe(3);
    expect(scan.html.withClass).toBe(1);
    expect(scan.html.withEvent).toBe(1);
    expect(scan.html.riskyTags).toEqual({ audio: 1 });
    expect(scan.syntaxCollisions.unknownLineStartTags).toEqual({ panel: 1 });
  });

  it('{{ }} 与行首未知标签单独成组', () => {
    const { scan } = scanOne('{{ 1 + 2 }} {{ 3 }}\n<slider value="1"></slider>');
    expect(scan.syntaxCollisions.braceExpressions).toBe(2);
    expect(scan.syntaxCollisions.braceOpenings).toBe(2);
    expect(scan.syntaxCollisions.unknownLineStartTags).toEqual({ slider: 1 });
  });

  it('数学只做清单与复核标记，不声称支持/不支持', () => {
    const { scan } = scanOne(content);
    expect(scan.math.commands).toEqual({ frac: 1 });
    expect(scan.math.environments).toEqual({ cases: 1 });
    expect(scan.math.macroDefinitions).toBe(0);
    expect(scan.math.legacyDelimiters).toBe(2); // \( 与 \)
    expect(scan.math.displayDollarMarkers).toBe(2);
    expect(scan.math.reviewNeeded).toBe(true);
  });

  it('五类引用按长度分流并计算各档预算', () => {
    const { scan } = scanOne(content);
    expect(scan.refs.counts).toEqual({
      image: 0,
      audio: 1,
      vote: 1,
      favorite: 1,
      clipboard: 1,
    });
    expect(scan.refs.unique).toEqual({
      image: 0,
      audio: 1,
      vote: 1,
      favorite: 1,
      clipboard: 1,
    });
    expect(scan.refs.replacementSlots).toBe(2); // 剪贴板 + 投票
    expect(scan.refs.fetchCandidates).toBe(3); // 剪贴板 + 投票 + 收藏夹
    expect(scan.refs.replacementOverBudget).toBe(false);
    expect(scan.refs.fetchOverBudget).toBe(false);
    expect(scan.refs.favoriteOverBudget).toBe(false);
    expect(scan.refs.audioOverBudget).toBe(false);
  });

  it('超出预算时逐项标出（替换 50 / 取数 50 / 收藏夹 3 / 音频 3）', () => {
    const clips = Array.from(
      { length: 60 },
      (_, index) => `[@${String(index).padStart(8, '0')}]`
    ).join(' ');
    const favorites = Array.from(
      { length: 5 },
      (_, index) => `[@${String(index).padStart(6, '0')}]`
    ).join(' ');
    const audios = Array.from(
      { length: 5 },
      (_, index) => `[@音频/${String(index).padStart(10, '0')}]`
    ).join(' ');
    const images = '[@AbCdEf1234] [@ZzYyXx9876]';

    const { scan } = scanOne([clips, favorites, audios, images].join('\n\n'));
    expect(scan.refs.counts.clipboard).toBe(60);
    expect(scan.refs.counts.favorite).toBe(5);
    expect(scan.refs.counts.audio).toBe(5);
    expect(scan.refs.counts.image).toBe(2);

    expect(scan.refs.replacementSlots).toBe(62);
    expect(scan.refs.replacementOverBudget).toBe(true);
    expect(scan.refs.fetchCandidates).toBe(65);
    expect(scan.refs.fetchOverBudget).toBe(true);
    expect(scan.refs.favoriteOverBudget).toBe(true);
    expect(scan.refs.audioOverBudget).toBe(true);
  });

  it('图片来源分桶：站内 API / 历史路径 / 历史 IP / 外链 / 相对 / data:', () => {
    const { scan } = scanOne(
      [
        '![a](/api/images/AbCdEf1234/raw)',
        '![b](/image/i/AbCdEf1234)',
        '![c](http://116.62.179.232:22822/image/i/abc)',
        '![d](https://example.com/d.png)',
        '![e](local/e.png)',
        '![f](data:image/png;base64,AAAA)',
      ].join('\n')
    );

    expect(scan.images).toMatchObject({
      total: 6,
      internalApi: 1,
      legacyPath: 1,
      legacyIpHost: 1,
      externalHttp: 1,
      relative: 1,
      dataUri: 1,
      otherScheme: 0,
    });
  });

  it('报告与摘要不含正文 / 标题（隐私边界）', () => {
    const body = 'SECRET_BODY_TEXT\nSECRET_TITLE';
    const { report, scan } = scanOne(body, { title: 'SECRET_TITLE' });

    expect(scan.id).toBe('blog-1');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET_BODY_TEXT');
    expect(serialized).not.toContain('SECRET_TITLE');
    expect(serialized).not.toContain(body);
  });

  it('整份报告汇总篇数、风险篇数与错误数', () => {
    const { documents } = validateCorpusDocuments([
      { id: 'b1', kind: 'blog', content },
      { id: 'c1', kind: 'clipboard', content: 'plain text' },
    ]);
    const report = scanCorpusDocuments(documents, {
      scannedAt: '2026-10-26T12:00:00+08:00',
      errors: [{ index: 2, code: 'missing_id' }],
    });

    expect(report.totals.documents).toBe(2);
    expect(report.totals.blogs).toBe(1);
    expect(report.totals.clipboards).toBe(1);
    expect(report.totals.documentsWithSoftLineBreaks).toBe(1);
    expect(report.totals.documentsWithHtml).toBe(1);
    expect(report.totals.documentsWithBraceExpressions).toBe(1);
    expect(report.totals.documentsWithMathReview).toBe(1);
    expect(report.totals.documentsWithReferences).toBe(1);
    expect(report.totals.documentsWithExternalImages).toBe(1);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.refs.clipboard).toBe(1);
    expect(report.totals.images.total).toBe(3);
  });
});
