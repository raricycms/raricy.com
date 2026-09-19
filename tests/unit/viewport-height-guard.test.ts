// ─────────────────────────────────────────────────────────────────────────────
// viewport-height-guard.test.ts —— 静态检查：量「整屏高度」的两处必须带 dvh 兜底
//
// 【为什么要有】手机端报告过：「讨论区有时候能上下滑，输入框下方一条黑条，
// 大约一个顶栏高」。病根是一个**在无头浏览器里完全看不出来**的事实：
//
//   手机上 `100vh` 量的是**地址栏收起时**的大视口，比眼前能看见的高度多出约一条
//   地址栏。于是 body（`height: 100%` → 也是那个大视口）与 `.chat-page` 都比可见区
//   高一截 → 页面平白能上下滑；而一滑，地址栏就收起、可见区随即变高，文档下沿之外
//   露出**通栏一条底色**（那条「黑条」）。
//
// `dvh` 跟着地址栏收放，永远等于当前可见高度。两处必须**成对**改成 dvh —— 只改一处
// 症状仍在：`.chat-page` 减掉 62px 之后要靠 body 那一档兜住剩下的，body 若还是
// 大视口，页脚位置之外那半截空白依旧会露出来。
//
// 【为什么只能静态盯着】Playwright 里没有地址栏，`vh` 与 `dvh` 恰好相等 ——
// 两种写法跑出来的用例**都是绿的**（chat-features.spec.ts 那条「整页没有滚动条」
// 抓不到这件事，它守的是文档里平地多出一块）。这种「改了也全绿、但手机上坏掉」的
// 约定，只能钉成静态检查。
//
// 【规则】两条都查「顺序」：dvh 必须**排在 vh 之后**。写成 dvh 在前、vh 在后是不会
// 报错的静默失效 —— 后面的声明胜出，现代浏览器照样拿到 vh，等于 dvh 那行不存在。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { compiledCss } from '../../scripts/compiled-css.mjs';

/** 去掉注释再解析：规则体内我们写了大段中文注释，注释里出现的 "height:" 不算声明。 */
const css = compiledCss().replace(/\/\*[\s\S]*?\*\//g, '');

/** 某个选择器的全部声明（选择器要完全一致；同名选择器有多条规则时按出现顺序拼起来）。 */
function declsOf(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/(?:^|\n)([^{}\n]+)\{([^}]*)\}/g)) {
    if (m[1].trim() !== selector) continue;
    for (const line of m[2].split('\n')) {
      const d = line.trim();
      if (/^[a-z-]+\s*:/.test(d)) out.push(d);
    }
  }
  return out;
}

/** 规则里某个属性的全部取值，按书写顺序。 */
function valuesOf(selector: string, prop: string): string[] {
  return declsOf(selector)
    .filter((d) => d.startsWith(`${prop}:`))
    .map((d) => d.slice(prop.length + 1).trim());
}

/** dvh 必须是最后一条（后者胜出），前一条要留着给不认 dvh 的老浏览器兜底。 */
function expectDvhLast(selector: string, prop: string) {
  const values = valuesOf(selector, prop);
  const last = values.at(-1) ?? '';
  expect(last, `${selector} 的 ${prop} 末条必须是 dvh 写法（现在：${JSON.stringify(values)}）`)
    .toContain('dvh');
  expect(values.length, `${selector} 的 ${prop} 只写了 dvh —— 老浏览器会拿不到值，先把原写法留成上一行`)
    .toBeGreaterThan(1);
}

describe('量视口高度的两处必须带 dvh 兜底', () => {
  // 页面骨架：body 与可见视口等高（页脚因此贴底）。src/styles-scss/base/_root.scss
  it('body 的高度用 dvh', () => {
    expectDvhLast('body', 'height');
    expectDvhLast('body', 'min-height');
  });

  // 讨论区整屏工作台：可见视口再减掉 62px 顶栏。src/styles-scss/pages/_chat.scss
  it('.chat-page 的高度用 dvh，并且真的减掉了顶栏', () => {
    expectDvhLast('.chat-page', 'height');
    expect(valuesOf('.chat-page', 'height').at(-1)).toContain('62px');
  });
});
