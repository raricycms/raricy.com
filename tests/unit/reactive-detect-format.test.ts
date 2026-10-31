// ─────────────────────────────────────────────────────────────────────────────
// reactive-detect-format.test.ts —— 自动 format 的三态边界
//
// 同时钉住两组不能顾此失彼的行为：
//   · 普通旧 Markdown 里的未知角括号标签 / 历史 HTML → markdown，可读可保存；
//   · 已知增强组件 / 插值出错 → invalid-enhanced，保留身份、给出可定位诊断、
//     阻止静默按 Markdown 发布。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { analyzeLocalSource, compileLocal, LOCAL_SYNTAX_VERSION } from 'reactive-md';
import {
  classifyReactiveSyntax,
  detectReactiveSyntax,
  literalizeReactiveSyntax,
} from '@/lib/reactive/detect-format';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';

describe('detectReactiveSyntax —— 三态', () => {
  it('普通 Markdown / 历史 HTML / 未知角括号标签 → markdown 且可保存', () => {
    for (const source of [
      '# 标题\n\n普通 **加粗** 与 [链接](https://example.com)',
      '<div style="color:red" class="x">旧 HTML 正文</div>',
      '<TAB>教程里的占位标签</TAB>',
      '<marquee>老网页效果</marquee>',
      '<details><summary>折叠</summary>正文</details></details>',
    ]) {
      const detected = detectReactiveSyntax(source);
      expect(detected.format, source).toBe('markdown');
      expect(detected.publishable, source).toBe(true);
      expect(detected.syntaxVersion, source).toBeNull();
    }
  });

  it('代码块 / 行内代码 / 数学里的组件与插值不算', () => {
    for (const source of [
      '```html\n<counter bind="n" label="N" initial="1" />\n```',
      '行内 `<counter bind="n" />` 示例',
      '公式 $\{ { 1+1 } }$ 里的花括号',
    ]) {
      const detected = detectReactiveSyntax(source);
      expect(detected.format, source).toBe('markdown');
    }
  });

  it('有效组件 / 插值 / 声明 → reactive，写当前语法版本', () => {
    const component = detectReactiveSyntax('<counter bind="n" label="N" initial="1" />');
    expect(component).toMatchObject({
      format: 'reactive',
      reactive: true,
      valid: true,
      publishable: true,
      syntaxVersion: LOCAL_SYNTAX_VERSION,
    });

    const interpolation = detectReactiveSyntax('结果是 {{ 1 + 1 }}');
    expect(interpolation.format).toBe('reactive');
    expect(interpolation.evidence).toContain('interpolation');
  });

  it('★ 已知组件结构出错 → invalid-enhanced：保留身份、诊断可定位、不可发布 ★', () => {
    const source = '<panel title="未闭合">\n\n正文';
    const detected = detectReactiveSyntax(source);
    expect(detected.format).toBe('reactive');
    expect(detected.reactive).toBe(true);
    expect(detected.valid).toBe(false);
    expect(detected.publishable).toBe(false);
    expect(detected.diagnostics.length).toBeGreaterThan(0);
    const diagnostic = detected.diagnostics[0];
    expect(diagnostic.range.end).toBeGreaterThanOrEqual(diagnostic.range.start);
    expect(diagnostic.line).toBeGreaterThanOrEqual(1);
    expect(diagnostic.column).toBeGreaterThanOrEqual(1);
    expect(detected.evidence.some((item) => item.startsWith('component:'))).toBe(true);
  });

  it('普通 Markdown 的 Reactive 外形可走字面量降级（不吞掉正文）', () => {
    const source = '示例 {{ 1 + 1 }} 与 <counter> 文字';
    const literal = literalizeReactiveSyntax(source);
    expect(literal.changed).toBe(true);
    expect(literal.source).not.toBe(source);
    expect(compileLocal(literal.source, reactiveCompileOptions('markdown')).ok).toBe(true);
  });

  it('前导版本声明会影响 syntaxVersion 证据', () => {
    const source = `<!-- reactive-md: ${LOCAL_SYNTAX_VERSION} -->\n\n<counter bind="n" label="N" initial="1" />`;
    const detected = detectReactiveSyntax(source);
    expect(detected.declaredVersion).toBe(LOCAL_SYNTAX_VERSION);
    expect(detected.syntaxVersion).toBe(LOCAL_SYNTAX_VERSION);
  });
});

describe('classifyReactiveSyntax —— worker 结果分类（不重复编译）', () => {
  it('已知组件 + 未知属性 → reactive + 不可发布（不降成 Markdown）', () => {
    const source = '<counter extra="x" bind="n" label="N" initial="1" />';
    const options = reactiveCompileOptions('markdown');
    const result = compileLocal(source, options);
    const analysis = analyzeLocalSource(source, options, { diagnostics: false });
    const detected = classifyReactiveSyntax(source, result, analysis);
    expect(detected.format).toBe('reactive');
    expect(detected.publishable).toBe(false);
  });

  it('编译失败但有 authoring 组件证据 → invalid-enhanced', () => {
    const source = '<panel title="未闭合">\n\n正文';
    const options = reactiveCompileOptions('markdown');
    const result = compileLocal(source, options);
    const analysis = analyzeLocalSource(source, options, { diagnostics: false });
    const detected = classifyReactiveSyntax(source, result, analysis);
    expect(detected.format).toBe('reactive');
    expect(detected.valid).toBe(false);
  });
});
