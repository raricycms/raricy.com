// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// blog-renderer.test.ts —— 整篇 Markdown → 安全 HTML 的唯一实现
//
// 【钉什么】公式保护回环（占位符不被 marked 吃掉、原文含定界符完整还原）、
// 代码块高亮 + 复制按钮形态、DOMPurify 白名单生效、GFM 扩展。引用预处理不在
// 这里（那是 content-ref-processor.ts 的事，入参应已过完它）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { renderBlogMarkdown } from '@/lib/blog-renderer';

describe('公式保护与还原', () => {
  it('块级公式含定界符完整还原，mathCount 正确', () => {
    const { html, mathCount } = renderBlogMarkdown('求和：$$x_1 + x_2$$');

    expect(mathCount).toBe(1);
    // `_` 没被 marked 吃成斜体，定界符完整放回（还原时已转义，见 markdown-math.ts）
    expect(html).toContain('$$x_1 + x_2$$');
  });

  it('行内公式里的 `*` 不触发强调', () => {
    const { html } = renderBlogMarkdown('注意 $a*b*c$ 的写法');

    expect(html).toContain('$a*b*c$');
    expect(html).not.toContain('<em>');
  });

  it('多个公式计数累加（>0 才跑 MathJax 的判据）', () => {
    const { mathCount } = renderBlogMarkdown('一 $a$ 二 $$b$$ 三 \\(c\\)');

    expect(mathCount).toBe(3);
  });
});

describe('代码块', () => {
  it('围栏代码块过 hljs 并附复制按钮（data-code 是 URI 编码的原文）', () => {
    const { html } = renderBlogMarkdown('```js\nconst a = 1 < 2;\n```');

    expect(html).toContain('class="hljs"');
    expect(html).toContain('copy-btn');
    // marked 交给 renderer 的 text 不含行尾换行
    expect(html).toContain(`data-code="${encodeURIComponent('const a = 1 < 2;')}"`);
  });

  // ★ 「复制」必须是 type="button" ★ 这段 HTML 会整块挂进**表单里**（编辑器的只读
  // 预览就在博客 / 剪贴板的 <form> 下面）：省略 type 的 <button> 默认是 submit，
  // 于是「预览里点一下复制」= 顺手提交整张表单。属性本身要过 DOMPurify 白名单，
  // 所以这里断的是**渲染完成之后**的那份 HTML —— 白名单哪天把 `type` 拿掉，
  // 这条当场红（真跑浏览器的那一遍在 editor-hardening.spec.ts）。
  it('复制按钮是 type="button"（默认的 submit 会顺手提交外层表单）', () => {
    const { html } = renderBlogMarkdown('```\ncode\n```');

    const btn = /<button\b[^>]*class="copy-btn"[^>]*>/.exec(html)?.[0];
    expect(btn, '没渲染出复制按钮，这条用例就测不到东西了').toBeDefined();
    expect(btn).toContain('type="button"');
  });

  it('未知语言回退 highlightAuto，不抛错', () => {
    const { html } = renderBlogMarkdown('```not-a-language\nhello\n```');

    expect(html).toContain('class="hljs"');
    expect(html).toContain('hello');
  });
});

describe('净化白名单', () => {
  it('脚本与事件属性被剥掉', () => {
    const { html } = renderBlogMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
  });

  it('任意 data-* 被剥，只放行白名单里的两个（data-code / data-vote-id）', () => {
    const { html } = renderBlogMarkdown('<span data-pwn="1">x</span>');

    expect(html).not.toContain('data-pwn');
  });
});

describe('GFM', () => {
  it('表格 / 删除线 / 任务列表按 GFM 渲染', () => {
    const { html } = renderBlogMarkdown(
      ['| a | b |', '| - | - |', '| 1 | 2 |', '', '~~旧~~', '', '- [x] 完成'].join('\n')
    );

    expect(html).toContain('<table>');
    expect(html).toContain('<del>旧</del>');
    expect(html).toContain('type="checkbox"');
  });
});
