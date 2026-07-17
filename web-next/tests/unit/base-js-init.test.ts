// @vitest-environment jsdom
//
// public/static/js/core/base.js —— 顶栏交互初始化时序。
//
// 【回归测试】2026-07-16 线上事故：base.js 把顶栏交互初始化放在
// document.addEventListener('DOMContentLoaded', ...) 里，而 Next 用
// <Script strategy="afterInteractive"> 加载它 —— 此时 DOMContentLoaded 早已触发，
// 回调永远不会执行 → 移动端汉堡菜单、头像下拉、通知计数、签到指示全部失效。
// （原 Flask 由 base.html 内联 <script> 在解析期执行，赶得上该事件，故无此问题。）
// 修复：readyState === 'loading' 才等事件，否则立即初始化。
//
// 这个测试的关键在于：**必须在 DOM 已就绪之后再执行 base.js**，
// 才能复现 Next 的加载时序。若在 loading 阶段执行，bug 不会显现。

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BASE_JS = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../public/static/js/core/base.js'),
  'utf-8'
);

/** 还原 Navbar 渲染出的顶栏 DOM（类名对齐 src/app/components/Navbar.tsx）。 */
const NAVBAR_HTML = `
  <meta name="user-authenticated" content="true">
  <meta name="notification-api-url" content="/api/notifications">
  <meta name="logout-url" content="/logout">
  <nav class="site-navbar">
    <button class="site-navbar-toggler" aria-expanded="false"></button>
    <div class="site-user-dropdown">
      <button class="site-user-dropdown-toggle" aria-expanded="false"></button>
      <ul class="site-user-dropdown-menu"></ul>
    </div>
    <button id="themeToggle"></button>
  </nav>
`;

/** 模拟 Next <Script strategy="afterInteractive">：DOM 已 complete 后才执行脚本。 */
function loadBaseJsAfterInteractive() {
  document.body.innerHTML = NAVBAR_HTML;
  // jsdom 默认 readyState 即为 'complete'，正是 afterInteractive 的时序
  expect(document.readyState).not.toBe('loading');
  // fetch 会被 base.js 的通知计数调用，挡掉避免噪声
  (globalThis as any).fetch = () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
  const fn = new Function(BASE_JS);
  fn();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('回归：base.js 在 DOM 已就绪后加载时，仍须完成初始化', () => {
  it('✅ 汉堡菜单可切换 —— 这是 2026-07-16 事故的核心用例', () => {
    loadBaseJsAfterInteractive();

    const navbar = document.querySelector('.site-navbar')!;
    const toggler = document.querySelector('.site-navbar-toggler') as HTMLElement;

    expect(navbar.classList.contains('open')).toBe(false);

    toggler.click();
    expect(
      navbar.classList.contains('open'),
      '点击汉堡后 .site-navbar 未加上 open —— 说明监听器没绑上（线上事故重现）'
    ).toBe(true);
    expect(toggler.getAttribute('aria-expanded')).toBe('true');

    toggler.click();
    expect(navbar.classList.contains('open')).toBe(false);
    expect(toggler.getAttribute('aria-expanded')).toBe('false');
  });

  it('✅ 头像下拉可展开，点击外部自动关闭', () => {
    loadBaseJsAfterInteractive();

    const dropdown = document.querySelector('.site-user-dropdown')!;
    const toggle = document.querySelector('.site-user-dropdown-toggle') as HTMLElement;

    toggle.click();
    expect(dropdown.classList.contains('open'), '头像下拉点不开（监听器未绑）').toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // 点击页面其它地方应收起
    document.body.click();
    expect(dropdown.classList.contains('open'), '点击外部未关闭下拉').toBe(false);
  });

  it('主题切换按钮可用（顶层绑定，事故中未受影响 —— 守住不回退）', () => {
    loadBaseJsAfterInteractive();
    const btn = document.getElementById('themeToggle') as HTMLElement;
    const before = document.documentElement.getAttribute('data-theme');
    btn.click();
    const after = document.documentElement.getAttribute('data-theme');
    expect(after).not.toBe(before);
    expect(['light', 'dark']).toContain(after);
  });
});

describe('DOM 仍在解析时（原 Flask 的时序）也必须正常', () => {
  it('readyState=loading 时注册监听器，DOMContentLoaded 后完成初始化', () => {
    document.body.innerHTML = NAVBAR_HTML;
    (globalThis as any).fetch = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });

    // 伪造 loading 状态，模拟脚本在解析期执行
    Object.defineProperty(document, 'readyState', {
      value: 'loading',
      configurable: true,
    });
    new Function(BASE_JS)();

    const navbar = document.querySelector('.site-navbar')!;
    const toggler = document.querySelector('.site-navbar-toggler') as HTMLElement;

    // 此时还没触发 DOMContentLoaded，监听器尚未生效
    toggler.click();
    expect(navbar.classList.contains('open')).toBe(false);

    // 触发事件后应完成初始化
    Object.defineProperty(document, 'readyState', {
      value: 'complete',
      configurable: true,
    });
    document.dispatchEvent(new Event('DOMContentLoaded'));

    toggler.click();
    expect(navbar.classList.contains('open'), 'DOMContentLoaded 后仍未绑定').toBe(true);
  });
});

describe('健壮性：顶栏元素缺失时不应抛异常', () => {
  it('页面没有 navbar/dropdown 时（如全屏游戏页）加载 base.js 不报错', () => {
    document.body.innerHTML = '<div>no navbar here</div>';
    (globalThis as any).fetch = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
    expect(() => new Function(BASE_JS)()).not.toThrow();
  });
});
