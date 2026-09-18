// ─────────────────────────────────────────────────────────────────────────────
// css-js-classes.test.ts —— 静态检查：JS 注入的类名在 CSS 里必须有定义
//
// 【为什么要有】收藏夹的「选择文件」按钮一直顶着浏览器默认样式。根因不是漏写一处 CSS：
// `.filepick` 一族的规则在 SCSS 拆分（02f6ab5）时随旧 rebuild.css 一起丢了，而那套 DOM
// 是 `public/static/js/core/base.js` 的 enhanceFileInputs **运行时注入**的 ——
// 于是全站没有任何东西会为此报警：
//   · 构建不失败（类名只是字符串）
//   · tsc 管不着（className 在 JS 里拼，不在 .tsx 里）
//   · tests/unit/css-classes.test.ts 只扫 .tsx 的 icon-*
// 结果就是静默地坏着，直到有人肉眼发现。这条守卫把那个盲区补上。
//
// 【范围】只查 public/static/js/ 下的**字面量**类名。判定干净：
//   · 模板字面量里的 `${...}` 是动态段，剥掉后再切词（`toast toast--${type}`）
//   · 以 `-` 收尾的词是拼接前缀（`toast--`），不是完整类名，跳过
//   · .tsx 里的类名**不查** —— 那里有大量 JS 钩子类（.article-checkbox、
//     .toggle-featured）与纯语义包装（.home-grid-item）本就无样式，
//     一并要求「必须有定义」只会制造噪音（见 css-classes.test.ts 开头的同类说明）
//
// 【与 scripts/check-links.mjs 的关系】那边 §4 查的是 icon-* 那一类（且还要并进组件内联
// `<style>`），不在本文件孪生。**但两边的 CSS 来自同一处** —— 现编 src/styles-scss/main.scss，
// 见 scripts/compiled-css.mjs。改取值逻辑改那个文件，别各写一份。
//
// 【CSS 从哪来】现编，不读入库产物；也**不能**改成扫 SCSS 源 —— 本文件正是那条判据的
// 反例：`public/static/js/core/base.js` 的 `.filepick__name--has`，其定义在
// src/styles-scss/components/_file-picker.scss 里是 `&--has` 嵌套，源里没有展开后的
// 字面量，扫源会把它假阳性报成「无定义」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compiledCss } from '../../scripts/compiled-css.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** base.js 里造 DOM 的三处写法：className =、classList.*()、innerHTML 里的 class="…" */
const PATTERNS = [
  /className\s*=\s*['"`]([^'"`]*)['"`]/g,
  /classList\.(?:add|remove|toggle|contains)\(\s*'([^']+)'/g,
  /class="([^"]*)"/g,
];

describe('JS 注入的类名与 CSS 定义一致', () => {
  const css = compiledCss();
  // 宽松判定：类名只要作为选择器出现过即可。**不能**要求紧跟 `{` ——
  // 选择器列表（`.form-hint, .file-hint { … }`）里只有最后一个后面才是 `{`，
  // 严格写法会把列表里靠前的那些全报成「无定义」。
  const defined = new Set(Array.from(css.matchAll(/\.([\w-]+)/g), (m) => m[1]));

  const used = new Map<string, Set<string>>();
  for (const file of jsFiles(path.join(ROOT, 'public/static/js'))) {
    const rel = path.relative(ROOT, file);
    const txt = fs.readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      for (const m of txt.matchAll(re)) {
        for (const raw of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
          if (!raw || raw.endsWith('-') || raw.includes('$') || raw.includes('{')) continue;
          if (!used.has(raw)) used.set(raw, new Set());
          used.get(raw)!.add(rel);
        }
      }
    }
  }

  it('确实扫到了一批类名（自检：别因为正则失效而空过）', () => {
    expect(defined.size).toBeGreaterThan(50);
    expect(used.size).toBeGreaterThan(5);
  });

  it('每个 JS 注入的类名都有 CSS 定义（否则渲染成浏览器默认样式）', () => {
    const missing = [...used.entries()]
      .filter(([c]) => !defined.has(c))
      .map(([c, files]) => `.${c} ← ${[...files].join(', ')}`);
    expect(missing, `这些类由 JS 注入但没有 CSS 定义：\n${missing.join('\n')}`).toEqual([]);
  });
});
