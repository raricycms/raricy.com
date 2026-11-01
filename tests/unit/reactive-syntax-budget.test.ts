// ─────────────────────────────────────────────────────────────────────────────
// reactive-syntax-budget.test.ts —— 编译前的资源闸门
//
// 上游 compileLocal 对海量未闭合 `<` / `{{` 是超线性的（隔离实测 25 万 `<`
// 约 30.7s）。这里钉住：超预算在**编译前**返回 `site.syntax-budget`，保留原文，
// 不进入上游；代码 / 数学里的同样字符不算；正常长文仍可编译。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { compileReactiveSource } from '@/lib/reactive/compile';
import {
  MAX_UNCLOSED_INTERPOLATIONS,
  MAX_UNCLOSED_TAGS,
  SYNTAX_BUDGET_CODE,
  checkSyntaxBudget,
} from '@/lib/reactive/syntax-budget';

describe('checkSyntaxBudget', () => {
  it('海量未闭合标签 / 插值在编译前被拒；原文长度不变', async () => {
    for (const source of ['<'.repeat(250_000), '{{ x '.repeat(50_000)]) {
      const budget = checkSyntaxBudget(source);
      expect(budget?.diagnostic.code).toBe(SYNTAX_BUDGET_CODE);
      const outcome = await compileReactiveSource({
        source,
        format: 'markdown',
        mode: 'external',
        viewer: null,
      });
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.diagnostics.map((d) => d.code)).toEqual([SYNTAX_BUDGET_CODE]);
      // 不截断、不吞正文：适配源码与原文等长。
      expect(outcome.adaptedSource).toBe(source);
      expect(outcome.compileMs).toBeLessThan(1_000);
    }
  });

  it('阈值边界：刚好未超预算不拒绝，超过才拒绝', () => {
    expect(checkSyntaxBudget('<'.repeat(MAX_UNCLOSED_TAGS))).toBeNull();
    expect(checkSyntaxBudget('<'.repeat(MAX_UNCLOSED_TAGS + 1))?.diagnostic.code).toBe(
      SYNTAX_BUDGET_CODE
    );
    expect(checkSyntaxBudget('{{ '.repeat(MAX_UNCLOSED_INTERPOLATIONS))).toBeNull();
    expect(
      checkSyntaxBudget('{{ '.repeat(MAX_UNCLOSED_INTERPOLATIONS + 1))?.diagnostic.code
    ).toBe(SYNTAX_BUDGET_CODE);
  });

  it('成对标签 / 代码块 / 数学里的同样字符不算（正常长文仍可编译）', async () => {
    const balanced = '<div>正文</div>'.repeat(10_000);
    expect(checkSyntaxBudget(balanced)).toBeNull();
    expect(checkSyntaxBudget('```\n' + '<'.repeat(10_000) + '\n```')).toBeNull();
    expect(checkSyntaxBudget('公式 $' + '<'.repeat(1_000) + '$ 结尾')).toBeNull();

    const normal = '普通段落。价格 $5 与 **加粗**。\n\n'.repeat(5_000).slice(0, 200_000);
    const outcome = await compileReactiveSource({
      source: normal,
      format: 'markdown',
      mode: 'external',
      viewer: null,
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.diagnostics).toEqual([]);
  });
});
