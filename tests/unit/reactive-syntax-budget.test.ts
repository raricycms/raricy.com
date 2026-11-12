import { describe, expect, it } from 'vitest';
import { compileSource } from '@/lib/reactive/compile-source';

describe('正文编译预算', () => {
  it('集中出现的未闭合插值返回预算诊断', () => {
    const result = compileSource('{{ '.repeat(10_000));
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'local.budget' }] });
  });

  it('代码示例里的花括号按字面量渲染', () => {
    const result = compileSource('\x60\x60\x60text\n' + '{{ '.repeat(2000) + '\n\x60\x60\x60');
    expect(result.ok).toBe(true);
  });
});
