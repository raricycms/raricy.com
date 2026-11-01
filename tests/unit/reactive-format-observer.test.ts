// ─────────────────────────────────────────────────────────────────────────────
// reactive-format-observer.test.ts —— 编辑器逐键分析的 worker 契约
//
// worker 本身无法在 jsdom 里起真实 Worker，所以这里覆盖**降级路径**：
//   · createWorker 抛错 → 上游改为主线程 compile，`mode/fallback` 必须如实回传；
//   · fallback 也必须先过 legacy compat（否则旧 HTML 在 fallback 下会冒未知标签）；
//   · author tokens 随结果返回，装饰不必再在主线程编译一遍；
//   · 旧 revision 的未完成观察以 superseded 结束。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { createFormatAnalyzer } from '@/lib/reactive/format-observer';

function fallbackAnalyzer(onMode?: (mode: string, detail?: string) => void) {
  return createFormatAnalyzer({
    createWorker: () => {
      throw new Error('worker-unavailable-in-test');
    },
    onModeChange: onMode,
  });
}

describe('FormatAnalysis：worker 降级与作者分析', () => {
  it('worker 起不来时回传 fallback / onFallback，并保留 author tokens', async () => {
    const modes: string[] = [];
    let fallbackDetail = '';
    const analyzer = createFormatAnalyzer({
      createWorker: () => {
        throw new Error('worker-unavailable-in-test');
      },
      onModeChange: (mode) => modes.push(mode),
      onFallback: (detail) => {
        fallbackDetail = detail ?? '';
      },
    });

    const result = await analyzer.analyze('<panel title="x">可见</panel>', 7);
    expect(result.revision).toBe(7);
    expect(result.effective).toBe('reactive');
    expect(result.mode).toBe('fallback');
    expect(result.fallback).toBe(true);
    expect(modes).toContain('fallback');
    expect(fallbackDetail).toContain('worker');
    // worker 没起来，但主线程回退仍算出了作者分析（着色用的 tokens）。
    expect(result.author?.tokens.length ?? 0).toBeGreaterThan(0);
    expect(result.analysis).not.toBeNull();
    analyzer.dispose();
  });

  it('fallback 与阅读 / worker 共用 legacy compat：旧 HTML 不产生未知标签诊断', async () => {
    const analyzer = fallbackAnalyzer();
    for (const source of ['<font color="red">旧标签</font>', '<marquee>滚动</marquee>']) {
      const result = await analyzer.analyze(source, 1);
      expect(result.effective, source).toBe('markdown');
      expect(result.codes, source).toEqual([]);
    }
    analyzer.dispose();
  });

  it('半截增强（未闭合组件 / 插值）回到 invalid-enhanced，不按 Markdown 放行', async () => {
    const analyzer = fallbackAnalyzer();
    for (const source of ['<panel title="x"', '文字 {{ 未闭合']) {
      const result = await analyzer.analyze(source, 9);
      expect(result.effective, source).toBe('invalid-enhanced');
      expect(result.publishable, source).toBe(false);
      expect(result.diagnostics.length, source).toBeGreaterThan(0);
    }
    analyzer.dispose();
  });

  it('新正文开始分析时，旧观察以 superseded 结束（调用方按 revision 丢弃）', async () => {
    const analyzer = fallbackAnalyzer();
    const first = analyzer.analyze('第一版正文', 1);
    const second = analyzer.analyze('第二版正文', 2);
    const [a, b] = await Promise.all([first, second]);
    expect(a.effective).toBe('superseded');
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    expect(b.effective).toBe('markdown');
    analyzer.dispose();
  });

  it('dispose 之后的新观察不再调度 worker', async () => {
    const analyzer = fallbackAnalyzer();
    analyzer.dispose();
    const result = await analyzer.analyze('之后', 3);
    expect(result.effective).toBe('superseded');
  });
});
