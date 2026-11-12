// ─────────────────────────────────────────────────────────────────────────────
// reactive-corpus-scan.test.ts —— 全量语料扫描的逐篇隔离与失败记账
//
// 扫描跑在业务库副本上，最怕两件事：一篇病态输入拖垮整批（没有报告）、
// 或者把超时/崩溃记成“成功”。这里钉住：
//   · 上游拒绝巨型 data 位图时仍生成报告；
//   · 单篇失败仍产出带 ID / 类别 / 诊断码的行，且 totals.scanFailures 计数。
// 报告不含正文 —— 断言输出 JSON 里没有夹具正文。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  buildCorpusTotals,
  failedCorpusScan,
  scanCorpusDocuments,
  type CorpusDocument,
} from '@/lib/reactive/corpus';

const scannedAt = '2026-11-01T00:00:00+08:00';
const PNG_PREFIX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg';

function document(id: string, content: string): CorpusDocument {
  return { id, kind: 'blog', content, format: 'markdown', formatSource: 'declared' };
}

describe('scanCorpusDocuments：逐篇隔离', () => {
  it('超预算的 data 位图产生失败记录，且报告不含正文', () => {
    const big = `data:image/png;base64,${PNG_PREFIX}${'A'.repeat(400_000)}`;
    const source = `<p>前</p><img src="${big}" alt="大图"><p>后</p>`;
    const report = scanCorpusDocuments([document('blog-big-image', source)], {
      scannedAt,
      compile: true,
    });
    expect(report.totals.scanFailures).toBe(0);
    expect(report.totals.compile).toBeUndefined(); // 汇总由 CLI 写，模块只给逐篇结果
    expect(report.documents[0].scanError).toBeNull();
    expect(report.documents[0].compileResult?.status).toBe('failed');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('A'.repeat(200));
  });

  it('单篇失败有 ID / 类别 / 诊断码，并计入 scanFailures（不记成功）', () => {
    const failed = failedCorpusScan(
      document('blog-boom', 'PRIVATE_BODY_DO_NOT_EXPORT'),
      new RangeError('boom'),
      true,
      'site.scan.timeout'
    );
    expect(failed.id).toBe('blog-boom');
    expect(failed.kind).toBe('blog');
    expect(failed.bucket).toBe('error');
    expect(failed.scanError).toBe('site.scan.timeout');
    expect(failed.compileResult).toMatchObject({
      status: 'failed',
      codes: ['site.scan.timeout'],
    });
    const totals = buildCorpusTotals([failed], 0);
    expect(totals.scanFailures).toBe(1);
    expect(totals.documents).toBe(1);
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_BODY_DO_NOT_EXPORT');
  });
});
