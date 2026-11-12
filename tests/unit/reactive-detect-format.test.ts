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
import { REACTIVE_COMPILE_OPTIONS } from '@/lib/reactive/host-components';
import { mightContainReactiveSyntax } from '@/lib/md-editor/format-mode';

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

  it('组件结构可恢复时保留 ReactiveMD 格式，发出可定位的警告', () => {
    const source = '<panel title="未闭合">\n\n正文';
    const detected = detectReactiveSyntax(source);
    expect(detected.format).toBe('reactive');
    expect(detected.reactive).toBe(true);
    expect(detected.valid).toBe(true);
    expect(detected.publishable).toBe(true);
    expect(detected.diagnostics.length).toBeGreaterThan(0);
    const diagnostic = detected.diagnostics[0];
    expect(diagnostic).toMatchObject({ code: 'local.recovery.unclosed', severity: 'warning' });
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
    expect(compileLocal(literal.source, REACTIVE_COMPILE_OPTIONS).ok).toBe(true);
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
    const options = REACTIVE_COMPILE_OPTIONS;
    const result = compileLocal(source, options);
    const analysis = analyzeLocalSource(source, options, { diagnostics: false });
    const detected = classifyReactiveSyntax(source, result, analysis);
    expect(detected.format).toBe('reactive');
    expect(detected.publishable).toBe(false);
  });

  it('编译失败但有 authoring 组件证据 → invalid-enhanced', () => {
    const source = '<counter bind="n" label="N" initial="oops" />';
    const options = REACTIVE_COMPILE_OPTIONS;
    const result = compileLocal(source, options);
    const analysis = analyzeLocalSource(source, options, { diagnostics: false });
    const detected = classifyReactiveSyntax(source, result, analysis);
    expect(detected.format).toBe('reactive');
    expect(detected.valid).toBe(false);
  });
});

describe('半截增强：未闭合标签 / 插值', () => {
  it('未闭合的组件开头可以降级成字面量，仍保留 ReactiveMD 格式', () => {
    const cases = [
      { source: '<panel title="x"', evidence: 'component:panel' },
      { source: '<section color="#000"', evidence: 'component:section' },
      { source: '<table page-size="5"', evidence: 'component:table' },
      { source: '<progress value="{{ 40 }}"', evidence: 'component:progress' },
    ];
    for (const { source, evidence } of cases) {
      const detected = detectReactiveSyntax(source);
      expect(detected.format, source).toBe('reactive');
      expect(detected.valid, source).toBe(true);
      expect(detected.publishable, source).toBe(true);
      expect(detected.literalized, source).toBeUndefined();
      expect(detected.evidence, source).toContain(evidence);
      expect(detected.diagnostics.length, source).toBeGreaterThan(0);
    }
  });

  it('代码 / 数学 / 未知普通 HTML 的半截写法不被误判', () => {
    for (const source of [
      '`<panel title="x"`',
      '```\n<panel title="x"\n```',
      '    <panel title="x"',
      '示例 <marquee 文本',
    ]) {
      const detected = detectReactiveSyntax(source);
      expect(detected.format, source).toBe('markdown');
      expect(detected.publishable, source).toBe(true);
    }
    // 同名历史 HTML 经上游恢复，仍按 Markdown 保存。
    const select = detectReactiveSyntax('<select 文本');
    expect(select.format).toBe('markdown');
    expect(select.publishable).toBe(true);
    expect(select.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning' }));
  });

  it('worker 结果区分可恢复的标签与阻断发布的插值', () => {
    const options = REACTIVE_COMPILE_OPTIONS;
    for (const [source, valid] of [['<panel title="x"', true], ['文字 {{ 未闭合', false]] as const) {
      const result = compileLocal(source, options);
      const analysis = analyzeLocalSource(source, options, { diagnostics: false });
      const detected = classifyReactiveSyntax(source, result, analysis);
      expect(detected.format, source).toBe('reactive');
      expect(detected.valid, source).toBe(valid);
      expect(detected.publishable, source).toBe(valid);
    }
  });
});

describe('键名示例 / 普通伪标签不误判（vimtutor 类正文）', () => {
  it('键名、大小写标签、命令范围都仍按 Markdown 可保存', () => {
    const snippets = [
      'Press <ESC> then :q! <ENTER>.',
      'Press <TAB>.',
      'Press <tab>.',
      'Press <Tab>.',
      '<Help> / <F1>',
      '箭头示意 < h l >',
      "命令范围 :'<,'>",
      'SVG 示例 <text>hello</text>',
      '```text\nPress <tab>.\n```',
    ];
    for (const source of snippets) {
      const detected = detectReactiveSyntax(source);
      expect(detected.format, source).toBe('markdown');
      expect(detected.publishable, source).toBe(true);
      expect(detected.literalized, source).toBeUndefined();
    }
  });

  it('插值及语义错误仍然阻断', () => {
    for (const source of ['<slider bind="a" label="N" initial="x" />', '{{ 1 +']) {
      const detected = detectReactiveSyntax(source);
      expect(detected.format, source).toBe('reactive');
      expect(detected.valid, source).toBe(false);
      expect(detected.publishable, source).toBe(false);
    }
  });
});

// ── 编辑器的预筛（原 md-editor-format-mode.test.ts 并入，R4）──────────────────
//
// `mightContainReactiveSyntax` 是编辑器格式判定的**预筛**，只有一条判据：「肯定不含」。
// 它不参与分类（分类在 @/lib/reactive/format-observer / detect-format，见上）。预筛
// 漏判的症状是静默的：增强语法正文按 markdown 保存 → 组件变成字面量文本，不报错。
// 所以「宁可多分析，绝不漏判」是它唯一的契约，和上面 detectReactiveSyntax 的三态
// 属于同一条决策链，放在一起维护。

describe('mightContainReactiveSyntax：只做「肯定不含」的排除', () => {
  it('纯文本 / 普通 Markdown 不触发分析', () => {
    expect(mightContainReactiveSyntax('')).toBe(false);
    expect(mightContainReactiveSyntax('# 标题\n\n**粗体** 与 [链接](https://x.y)')).toBe(false);
    expect(mightContainReactiveSyntax('单行公式 $x^2$ 与代码 `a + b`')).toBe(false);
  });

  it('组件、插值、声明、版本指令都算候选', () => {
    expect(mightContainReactiveSyntax('<slider bind="a">')).toBe(true);
    expect(mightContainReactiveSyntax('人数：{{ people }}')).toBe(true);
    expect(mightContainReactiveSyntax('<theme primary="#fff"></theme>')).toBe(true);
    expect(mightContainReactiveSyntax('<!-- reactive-md: local-draft-3 -->')).toBe(true);
  });

  it('代码块里的示例也会触发（宁可多分析，绝不漏判）', () => {
    expect(mightContainReactiveSyntax('```\n<slider bind="a">\n```')).toBe(true);
  });
});
