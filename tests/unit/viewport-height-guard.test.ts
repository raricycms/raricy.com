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
// 症状仍在：`.chat-page` 减掉顶栏之后要靠 body 那一档兜住剩下的，body 若还是
// 大视口，页脚位置之外那半截空白依旧会露出来。
//
// 【为什么只能静态盯着】Playwright 里没有地址栏，`vh` 与 `dvh` 恰好相等 ——
// 两种写法跑出来的用例**都是绿的**（chat-features.spec.ts 那条「整页没有滚动条」
// 抓不到这件事，它守的是文档里平地多出一块）。这种「改了也全绿、但手机上坏掉」的
// 约定，只能钉成静态检查。
//
// 【规则】两条都查「顺序」：dvh 必须**排在 vh 之后**。写成 dvh 在前、vh 在后是不会
// 报错的静默失效 —— 后面的声明胜出，现代浏览器照样拿到 vh，等于 dvh 那行不存在。
//
// 【关于顶栏高度】「减掉顶栏」这个数（原先是写死的 62px）现已抽成共享变量
// `--navbar-height`（= 62px + 顶部安全区，定义在 base/_root.scss），body 与
// `.chat-page` 读**同一个**变量。所以这里不再断言字面量 `62px` 出现在两处规则里
// ——那正是要被消灭的「同一个数抄两遍」；改为断言：两条规则都引用 `var(--navbar-height)`，
// 且 `--navbar-height` 自身确实等于 62px 加安全区。
//
// 【关于软键盘那一档】`.chat-page` 的高度还有**第三条**：键盘弹起时由 useChatViewport
// 写入 `--chat-vv-bottom`，缺省回退 `100dvh`。本条必须 (a) 带 dvh 兜底，(b) 用的
// 自定义属性名与 JS 常量一致 —— 改名漏改一侧会静默退回 dvh（键盘又盖住输入框）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { compiledCss } from '../../scripts/compiled-css.mjs';
import { CHAT_VV_BOTTOM_VAR } from '../../src/lib/chat-viewport';

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

  // 讨论区整屏工作台：可见视口再减掉顶栏。src/styles-scss/pages/_chat.scss
  it('.chat-page 的高度用 dvh，并且减掉的是共享顶栏变量', () => {
    expectDvhLast('.chat-page', 'height');
    expect(
      valuesOf('.chat-page', 'height').at(-1),
      '.chat-page 必须减掉 var(--navbar-height)（共享顶栏高度），而不是再写一个 62px'
    ).toContain('var(--navbar-height)');
    // 也不能把顶栏那一次让位忘了：高度算式里必须真的出现减法与顶栏变量。
    expect(valuesOf('.chat-page', 'height').at(-1)).toMatch(/-\s*var\(--navbar-height\)/);
  });

  // 键盘弹起那一档：第三条高度。缺省回退 100dvh，故与 dvh 那一档等价。
  it('.chat-page 的键盘档带 100dvh 兜底，且属性名与 JS 常量一致', () => {
    const last = valuesOf('.chat-page', 'height').at(-1) ?? '';
    expect(last, '键盘覆盖档必须引用 useChatViewport 写的自定义属性').toContain(
      `var(${CHAT_VV_BOTTOM_VAR}`
    );
    expect(last, '键盘覆盖档缺省要回退 100dvh（否则未弹键盘时这条无值可算）').toContain(
      '100dvh'
    );
  });

  // body 给固定顶栏让位：读同一个共享变量。选择器是 `html body` —— 见 _header.scss
  // 里那条说明（_notifications.scss 还留着一份后置的 `body { padding-top: 62px }`）。
  it('body 的顶栏让位读共享变量 --navbar-height', () => {
    expect(
      valuesOf('body', 'padding-top').at(-1),
      'body 的 padding-top 必须读 var(--navbar-height)，不能写死 62px（加安全区后会对不上）'
    ).toContain('var(--navbar-height)');
  });

  // 共享变量自身的定义：62px（顶栏内容高）加顶部安全区。少任一项都会静默错位。
  it('--navbar-height = 62px + --safe-top', () => {
    const v = valuesOf(':root', '--navbar-height').at(-1) ?? '';
    expect(v).toContain('62px');
    expect(v).toContain('var(--safe-top)');
  });

  // 四个安全区变量都取 env()、带 0px 兜底（未声明 viewport-fit / 无刘海设备 → 0，
  // 于是所有消费点回到改版前数值）。少一个 0px 兜底，整条 calc() 会静默失效。
  it('四个安全区变量都取 env() 并带 0px 兜底', () => {
    const pairs: Array<[string, string]> = [
      ['--safe-top', 'safe-area-inset-top'],
      ['--safe-bottom', 'safe-area-inset-bottom'],
      ['--safe-left', 'safe-area-inset-left'],
      ['--safe-right', 'safe-area-inset-right'],
    ];
    for (const [name, inset] of pairs) {
      const v = valuesOf(':root', name).at(-1) ?? '';
      expect(v, `${name} 必须来自 env(${inset}, 0px)`).toContain(`env(${inset}`);
      expect(v, `${name} 缺 0px 兜底 —— 桌面 / 无刘海设备上整条 calc() 会失效`).toContain('0px');
    }
  });
});
