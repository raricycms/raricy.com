// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// markdown-math.test.ts —— 公式「保护 / 还原」两个历史 bug 的回归。
//
// 【bug 1】还原用字符串替换时 `$$` 被 String.replace 的 `$` 语义吃掉：
//   `$$E=mc^2$$` 还原成 `$E=mc^2$`（块级降级为行内）；跨行块级公式还会让渲染层
//   的 hasMath 嗅探彻底失效 → 整页公式以原始文本显示。线上用户反馈的
//   「云剪贴板详情页公式完全不渲染」就是这个。
//
// 【bug 2】还原出的公式未转义，`<` `&` 被 HTML 解析器 + DOMPurify 吃掉：
//   `$$a<b$$` 只剩 `$$a`。断言一律走真实管线（restore → DOMPurify → 解析成 DOM），
//   不看中间字符串 —— 转义形式会骗过字符串比对。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import { BLOG_SANITIZE_OPTIONS } from '@/lib/blog-markdown';
import { protectMath, restoreMath } from '@/lib/markdown-math';

/** 走一遍真实管线：保护 → 还原 → 白名单净化 → 解析成 DOM，返回 textContent。 */
function roundTrip(markdown: string): { text: string; count: number } {
  const { text: protectedText, placeholders, count } = protectMath(markdown);
  const restored = restoreMath(`<p>${protectedText}</p>`, placeholders);
  const clean = DOMPurify.sanitize(restored, BLOG_SANITIZE_OPTIONS);
  const root = document.createElement('div');
  root.innerHTML = clean;
  return { text: root.textContent ?? '', count };
}

describe('protectMath', () => {
  it('抽出四组定界符，正文里不再残留公式', () => {
    const src = '行内 $x^2$ 与 \\(y_1\\)，块级 $$E=mc^2$$ 与 \\[z=1\\]。';
    const { text, count, placeholders } = protectMath(src);
    expect(count).toBe(4);
    expect(placeholders.size).toBe(4);
    expect(text).not.toContain('$');
    expect(text).not.toContain('\\(');
  });

  it('跨行块级公式也整段抽出', () => {
    const { count } = protectMath('$$\n\\begin{cases}\nu_1=a \\\\\nu_2=b\n\\end{cases}\n$$');
    expect(count).toBe(1);
  });

  it('孤立的 $ 不配对（价格写法不该被当成公式）', () => {
    expect(protectMath('这本书 $5 元。').count).toBe(0);
  });

  // R3-112：代码块 / 行内代码里的成对 `$$` 不是公式，是作者想展示的语法本身。
  // 抽走它们会让占位符流进 marked 的产物，再被 restoreMath 塞进复制按钮的
  // `data-code` 属性（见本文件头第 3 条）。
  it('围栏代码块里的成对 $$ 不被抽走（原文一个字都不变）', () => {
    const src = '```markdown\n$$E=mc^2$$\n```';
    const { text, count, placeholders } = protectMath(src);
    expect(count).toBe(0);
    expect(placeholders.size).toBe(0);
    expect(text).toBe(src);
  });

  it('行内代码里的成对 $ 也不抽', () => {
    const src = '写成 `$x$` 这样的行内公式';
    expect(protectMath(src)).toMatchObject({ count: 0, text: src });
  });

  it('代码块内外的公式互不影响：只抽代码外的那个', () => {
    const src = '```\n$a$ $$b$$\n```\n\n之后是 $c$';
    const { text, count } = protectMath(src);
    expect(count).toBe(1);
    // 代码块内三处定界符原样保留，代码外的 $c$ 变成占位符
    expect(text).toContain('```\n$a$ $$b$$\n```');
    expect(text).not.toContain('$c$');
  });
});

describe('restoreMath', () => {
  it('块级公式还原后 $$ 完整（回归 $ 语义吞并）', () => {
    const src = '$$E=mc^2$$';
    const { placeholders } = protectMath(src);
    const restored = restoreMath('MATHBLOCK0PLACEHOLDER', placeholders);
    expect(restored).toBe('$$E=mc^2$$');
  });

  it('跨行块级公式原样还原', () => {
    const src = '$$\n\\begin{cases}\nu_1=a \\\\\nu_2=b\n\\end{cases}\n$$';
    const { text, placeholders } = protectMath(src);
    expect(restoreMath(text, placeholders)).toBe(src);
  });

  it('公式里的 < & > 转义后仍能穿过 DOMPurify 与 HTML 解析', () => {
    // 特意用 `x<b`（< 后跟字母）：不转义时 `<b` 会被当成标签起始，
    // DOMPurify 一净化公式就只剩半截 —— `<0` 那种反而会被当普通文本放过去。
    const { text, count } = roundTrip(
      '$$\n\\begin{cases} x>b & \\text{大} \\\\ x<b & \\text{小} \\end{cases}\n$$'
    );
    expect(count).toBe(1);
    expect(text).toContain('x<b');
    expect(text).toContain('&');
    expect(text).toContain('$$');
  });

  it('代码块里的 $ 也原样保留（内容不被吞）', () => {
    const { text } = roundTrip('```\nconst a = $5;\n```');
    expect(text).toContain('const a = $5;');
  });

  it('公式里的引号转义后不会截断属性值（data-code 回归）', () => {
    const math = '$$a"b\'c$$';
    const restored = restoreMath(
      '<button type="button" class="copy-btn" data-code="MATHBLOCK0PLACEHOLDER">复制</button>',
      new Map([['MATHBLOCK0PLACEHOLDER', math]])
    );
    expect(restored).toContain('&quot;');
    // 关键判据：解析回来后属性值完整等于公式原文（提前结束会只剩 `$$a`）
    const root = document.createElement('div');
    root.innerHTML = restored;
    expect(root.querySelector('button')!.getAttribute('data-code')).toBe(math);
  });

  it('行内公式与行内 LaTeX 定界符保持原样', () => {
    expect(roundTrip('行内 $x^2$ 结束').text).toBe('行内 $x^2$ 结束');
    expect(roundTrip('行内 \\(y_1\\) 结束').text).toBe('行内 \\(y_1\\) 结束');
  });
});
