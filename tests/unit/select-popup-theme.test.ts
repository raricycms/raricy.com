// ─────────────────────────────────────────────────────────────────────────────
// select-popup-theme.test.ts —— 静态检查：每个 <select> 的展开列表都自带主题配色
//
// 【为什么要有】原生 <select> 展开后的那层列表**不在字段的盒子里**，它由浏览器画，
// 但条目的 `color` 是从 <select> 继承下来的。于是暗色主题下会出现「近白的字 +
// 浏览器拍板的浅色底」——展开就是一片白，看着像没适配夜间模式。这条链条上
// **没有任何东西会报错**：构建过、单测过、tsc 过，只有肉眼能看见。
//
// 唯一的解法是在 CSS 里把 `option` / `optgroup` 的底色与字色一起钉成主题令牌
// （见 `src/styles-scss/components/_form-controls.scss`）。本文件守的就是那两条别被删。
// 容易被顺手删掉的理由很具体：「color-scheme 不是已经管原生控件了吗」
// —— 它管的是明暗基准，不足以保证底色与字色配对（`docs/frontend-styles.md` §8）。
//
// 【为什么扫 TSX 找类名，而不是写死 .form-select】写死就只能守住那两个类名，
// 新加一个 select 类（或某个 select 忘了挂类）照样静默溜过去。扫 TSX 是
// 「凡页面上真有的 select，它的类都得有配色规则」——这才是要守的命题。
// 代价：className 是表达式（`className={x}`）时静态判不了，那种情况**不计入**，
// 只由下面的自检断言数量不为 0 兜底（防止正则整体失效导致空过）。
//
// 【CSS 从哪来】现编 main.scss（见 `scripts/compiled-css.mjs`），与另外三条样式守卫同一份取值。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compiledCss } from '../../scripts/compiled-css.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** 页面上每个 <select> 及其字面量类名（className 是表达式的一律跳过）。
    按**元素**分组而不是按类名去重：一个 select 可以挂多个类（如
    `form-select category-select`），只要其中一个类提供了配色就算过关。 */
type SelectEl = { classes: string[]; file: string };

function selectElements(): SelectEl[] {
  const found: SelectEl[] = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const txt = fs.readFileSync(file, 'utf8');
    // className 通常紧跟 <select，但允许隔几行（多行属性写法），故取一段窗口
    for (const m of txt.matchAll(/<select\b([\s\S]{0,300}?)>/g)) {
      const cls = /className=(?:\{)?["'`]([^"'`}]*)["'`]/.exec(m[1]);
      if (!cls) continue;
      found.push({
        classes: cls[1].split(/\s+/).filter(Boolean),
        file: path.relative(ROOT, file),
      });
    }
  }
  return found;
}

type Rule = { selectors: string[]; body: string };

function rules(): Rule[] {
  return [...compiledCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean),
    body: m[2],
  }));
}

describe('<select> 展开列表的主题配色', () => {
  const all = rules();
  const selects = selectElements();

  it('自检：确实扫到了 select（否则下面的断言是空过）', () => {
    expect(selects.length).toBeGreaterThan(10);
  });

  // background-color 不继承：只给 optgroup 的话，它名下的选项仍然是透明底，
  // 所以两个都要各自成立，不能靠「父上有就行」
  const THEMED = /(?:^|;)\s*background-color:\s*var\(--color-[\w-]+\)/;
  const INKED = /(?:^|;)\s*color:\s*var\(--color-[\w-]+\)/;

  it.each(['option', 'optgroup'])('每个 <select> 都有带主题配色 %s 的类', (part) => {
    const missing = selects
      .filter(
        (el) =>
          !el.classes.some((cls) => {
            const esc = cls.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const classRe = new RegExp(`\\.${esc}(?![\\w-])`);
            return all.some(
              (r) =>
                r.selectors.some((s) => classRe.test(s) && new RegExp(`\\b${part}$`).test(s)) &&
                THEMED.test(r.body) &&
                INKED.test(r.body)
            );
          })
      )
      .map((el) => `[${el.classes.join(' ')}] ← ${el.file}`);

    expect(
      missing,
      `这些 <select> 没有任何一个类提供 ${part} 的主题配色` +
        `（暗色主题下展开会是白底白字）：\n${missing.join('\n')}`
    ).toEqual([]);
  });
});
