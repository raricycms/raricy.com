// ─────────────────────────────────────────────────────────────────────────────
// compiled-css.mjs —— 现编 src/styles-scss/main.scss，返回 CSS 文本
//
// 三条守卫共用这一份取值逻辑：
//   · tests/unit/css-classes.test.ts   （.tsx 里的 icon-* 必须有定义）
//   · tests/unit/css-js-classes.test.ts（JS 注入的类名必须有定义）
//   · scripts/check-links.mjs §4       （icon-* 那条的孪生实现）
//
// 【为什么不读文件】编译产物原先入库（src/styles-scss/compiled/flask.css），
// 三条守卫读的都是那一份。产物一旦 stale，守卫验的就是「上一版样式」——
// 而它恰恰是最容易忘记重编的东西。现编保证守卫看到的是当前 SCSS 真正编译出的
// 结果，与浏览器拿到的一致。
//
// 【为什么不扫 SCSS 源】源里没有 `&--has` 这类嵌套展开后的字面量。
// 实测：public/static/js/core/base.js 的 `.filepick__name--has` 在
// src/styles-scss/components/_file-picker.scss 里写成 `&--has` 嵌套，
// 扫源会把它报成「无定义」——纯假阳性，全仓有 211 处 `&__`/`&--` 嵌套。
//
// 【为什么是 .mjs】check-links.mjs 由 node 直接跑 ESM，import 不了 .ts（那要上 tsx）。
// 根 package.json 没有 "type": "module"，所以脚本只能是 .mjs，不能是 .js。
// TS 侧不需要 .d.mts：moduleResolution=bundler + allowJs 下 tsc 能从 JS 推断出类型。
//
// 【只共享「取到 CSS 文本」这一段】stripComments 与「拼 .tsx 内联 <style>」留在
// check-links.mjs 那一侧 —— 那里还要把组件内联样式（ATAMAS 整个游戏就是这么上样式的）
// 并进检查面，那是它对 css-classes.test.ts 唯一的增量价值，统一进本文件会把它弄丢。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sassNamespace from 'sass';

// vitest 会把 node_modules 依赖外部化，命名空间与 default 两种形态都兜一下。
const sass = sassNamespace.compile ? sassNamespace : sassNamespace.default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'styles-scss', 'main.scss');

/** @type {string | undefined} */
let cache;

/**
 * 编译 SCSS 入口，返回 CSS 文本（expanded）。
 *
 * 入口不存在或编译失败一律 **throw** —— 不返回空串。旧的实现是
 * `fs.existsSync(p) ? readFileSync(p) : ''`，文件不在时静默降级成空串，
 * 于是每一个 icon-* 都被报成「无定义」（check-links.mjs §4 的注释记着这 24 条假阳性）。
 * 响亮地失败才能让人看出是「编不出来」而不是「样式真的丢了」。
 *
 * @returns {string} CSS 文本
 */
export function compiledCss() {
  if (cache === undefined) {
    if (!fs.existsSync(ENTRY)) {
      throw new Error(`SCSS 入口不存在：${ENTRY}（守卫靠现编它拿 CSS）`);
    }
    cache = sass.compile(ENTRY, {
      style: 'expanded',
      loadPaths: [path.join(ROOT, 'src', 'styles-scss')],
    }).css;
  }
  return cache;
}
