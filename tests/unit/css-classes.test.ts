// ─────────────────────────────────────────────────────────────────────────────
// css-classes.test.ts —— 静态检查：className 引用的类在 CSS 里必须有定义
//
// 【为什么要有】联系页的标题图标曾经渲染成一个黑方块：页面写的是 .icon-chat-dots，
// 而 CSS 里定义的是 .icon-chat-dots_new（少了 _new）。图标靠 mask-image 上色，
// 类名对不上就没有 --i 变量，.icon 基类的底色整块涂出来 → 纯黑方块。
//
// 这种错既不会让构建失败、也不会让任何单测转红，tsc 更管不着 —— className 是字符串。
// 只有肉眼看见才发现。故在此把「图标类必须有定义」钉成静态检查。
//
// 【范围】只查 icon-* 一类「mask-image 图标」——判定干净，不存在动态拼接
//   （来源是联系页那个黑方块）。
// 其余类名不查 —— 项目里有大量 JS 钩子类（.article-checkbox、.toggle-featured）
// 和纯语义包装类（.blog-detail）本就无样式，一并要求「必须有定义」只会制造噪音。
//
// 【CSS 从哪来】现编 src/styles-scss/main.scss（见 scripts/compiled-css.mjs），
//   不读任何入库产物。**也不能改成扫 SCSS 源** —— `&--has` 这类嵌套在源里没有
//   展开后的字面量，扫源会假阳性转红，理由详见那个 helper 的头部注释。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compiledCss } from '../../scripts/compiled-css.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = [], exts: string[] = ['.tsx']): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, exts);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

describe('图标类名与 CSS 定义一致', () => {
  const css = compiledCss();
  // 只认「作为选择器出现」的：.icon-x{...}。出现在注释或 url() 里的不算。
  const defined = new Set(Array.from(css.matchAll(/\.(icon-[\w-]+)\s*\{/g), (m) => m[1]));

  const used = new Map<string, Set<string>>();
  for (const file of walk(path.join(ROOT, 'src'))) {
    const txt = fs.readFileSync(file, 'utf8');
    // 只取纯字面量 className。带 ${} / 三元的跳过 —— 那是表达式，静态判不了。
    for (const m of txt.matchAll(/className=['"]([^'"{}$]*)['"]/g)) {
      for (const c of m[1].split(/\s+/)) {
        // icon-btn 是按钮容器（非图标本体），不参与 mask-image 那套
        if (c.startsWith('icon-') && c !== 'icon-btn') {
          if (!used.has(c)) used.set(c, new Set());
          used.get(c)!.add(path.relative(ROOT, file));
        }
      }
    }
  }

  it('CSS 里确实定义了一批 icon-*（自检：别因为正则失效而空过）', () => {
    expect(defined.size).toBeGreaterThan(10);
    expect(used.size).toBeGreaterThan(5);
  });

  it('每个用到的 icon-* 都有 CSS 定义（否则渲染成黑方块）', () => {
    const missing = [...used.entries()]
      .filter(([c]) => !defined.has(c))
      .map(([c, files]) => `.${c} ← ${[...files].join(', ')}`);
    expect(missing, `这些图标类没有 CSS 定义，会渲染成黑方块：\n${missing.join('\n')}`).toEqual([]);
  });
});
