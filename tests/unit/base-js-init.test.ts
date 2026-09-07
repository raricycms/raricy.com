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

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('回归：登录后 Navbar 重渲染（user: null → user），新插入的 toggle 必须可点', () => {
  //
  // 【线上 bug】2026-07-29：登录页 router.refresh() 后，Navbar 里的
  // .site-user-dropdown-toggle 是 React 新插入的 DOM 节点。
  // base.js 是 <Script strategy="afterInteractive"> 加载的，仅执行一次；
  // 它原本用 userToggle.addEventListener('click', ...) 直接绑元素，
  // 所以初始化时若元素不存在，新插入的 toggle 永远点不开。
  // 修复：用 document 上的事件委托 —— 监听器一次绑好，后续插入的节点
  // 自动落入委托链。配合 AbortController 收口监听器，多次 init 互不污染。
  //
  it('✅ base.js 初始化时无下拉元素；之后插入的 toggle 点击可展开', () => {
    // 1) 登录页状态：navbar 已就绪，但 user=null —— 无下拉
    document.body.innerHTML = `
      <nav class="site-navbar">
        <button class="site-navbar-toggler" aria-expanded="false"></button>
        <a class="site-link" href="/login">登录</a>
      </nav>
    `;
    (globalThis as any).fetch = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
    new Function(BASE_JS)();

    // 2) 模拟 router.refresh() 后 server 返回 user —— React 插入下拉 DOM
    const navbar = document.querySelector('.site-navbar')!;
    const dropdown = document.createElement('div');
    dropdown.className = 'site-user-dropdown';
    dropdown.innerHTML = `
      <button class="site-user-dropdown-toggle" aria-expanded="false">me</button>
      <ul class="site-user-dropdown-menu"></ul>
    `;
    navbar.appendChild(dropdown);
    const toggle = dropdown.querySelector('.site-user-dropdown-toggle') as HTMLElement;

    // 3) 点新插入的 toggle —— 必须能展开
    toggle.click();
    expect(
      dropdown.classList.contains('open'),
      'login 后新插入的头像下拉点不开 —— base.js 未做事件委托（线上 bug 重现）'
    ).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('✅ 新插入下拉后，点击外部仍可关闭', () => {
    document.body.innerHTML = `<nav class="site-navbar"></nav>`;
    (globalThis as any).fetch = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
    new Function(BASE_JS)();

    const dropdown = document.createElement('div');
    dropdown.className = 'site-user-dropdown';
    dropdown.innerHTML = `
      <button class="site-user-dropdown-toggle" aria-expanded="false">me</button>
      <ul class="site-user-dropdown-menu"></ul>
    `;
    document.querySelector('.site-navbar')!.appendChild(dropdown);
    const toggle = dropdown.querySelector('.site-user-dropdown-toggle') as HTMLElement;

    toggle.click();
    expect(dropdown.classList.contains('open')).toBe(true);

    document.body.click();
    expect(dropdown.classList.contains('open'), '外部点击未关闭新插入的下拉').toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('通知未读数心跳：登录态下每 20s 自动轮询一次', () => {
  it('✅ 有徽标的登录页：每 20s 触发一次计数刷新；重复执行 base.js 不叠加定时器', () => {
    vi.useFakeTimers();
    try {
      // 登录态 Navbar 会渲染 #notificationBadge；未登录不渲染 → 心跳不应启动
      document.body.innerHTML = `
        <meta name="user-authenticated" content="true">
        <meta name="notification-api-url" content="/api/notifications/count">
        <meta name="checkin-api-url" content="/api/checkin">
        <span class="notification-badge" id="notificationBadge"></span>
      `;
      let fetches = 0;
      (globalThis as any).fetch = () => {
        fetches += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
      };

      // 首轮 init：updateNotificationCount + updateCheckinIndicator 各一次即时刷新
      new Function(BASE_JS)();
      const baseline = fetches;
      expect(baseline).toBeGreaterThanOrEqual(2);

      // 20s 后心跳 tick —— 恰好 +1（通知侧），签到无定时器
      vi.advanceTimersByTime(20 * 1000);
      expect(fetches, '20s 后未自动刷新通知数').toBe(baseline + 1);

      // 模拟 HMR / 测试反复执行：initSiteChrome 会重跑 —— 旧定时器必须被清掉再开，
      // 否则每重跑一次就多一条 20s 轮询，请求量随时间线性叠加
      new Function(BASE_JS)();
      const afterReinit = fetches; // = baseline + 1（心跳） + 2（重 init 的即时刷新）
      expect(afterReinit).toBe(baseline + 3);

      vi.advanceTimersByTime(20 * 1000);
      expect(fetches, '重复 init 后 20s 触发了多次刷新 —— 定时器叠加了').toBe(afterReinit + 1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('✅ 页面没有徽标（未登录 Navbar）时不启动心跳，不产生空轮询', () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <meta name="user-authenticated" content="false">
        <nav class="site-navbar">
          <a class="site-login-btn" href="/login">登录</a>
        </nav>
      `;
      let fetches = 0;
      (globalThis as any).fetch = () => {
        fetches += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
      };
      new Function(BASE_JS)();
      const baseline = fetches;
      vi.advanceTimersByTime(60 * 1000);
      expect(fetches).toBe(baseline);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('移动端：点击导航链接后 navbar 自动收起', () => {
  // jsdom 没有 window.matchMedia，base.js 会兜底成 isMobile()=false；
  // 这里桩成 matches:true 模拟手机端，才能走到移动端收起分支。
  function mockMobileMedia() {
    (globalThis as any).matchMedia = (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  const MOBILE_NAVBAR = `
    <nav class="site-navbar">
      <button class="site-navbar-toggler" aria-expanded="false"></button>
      <a class="site-link" href="/game">玩具</a>
      <a class="site-login-btn" href="/login"><span class="icon icon-person-circle"></span>登录</a>
      <div class="site-user-dropdown">
        <button class="site-user-dropdown-toggle" aria-expanded="false"></button>
        <ul class="site-user-dropdown-menu">
          <li><a class="site-dropdown-item" href="/fish">小鱼干</a></li>
        </ul>
      </div>
    </nav>
  `;

  function loadMobileNavbar() {
    mockMobileMedia();
    document.body.innerHTML = MOBILE_NAVBAR;
    (globalThis as any).fetch = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
    new Function(BASE_JS)();
  }

  it('✅ 点击 a.site-link 后 navbar 收起（原行为不回退）', () => {
    loadMobileNavbar();

    const navbar = document.querySelector('.site-navbar')!;
    const toggler = document.querySelector('.site-navbar-toggler') as HTMLElement;
    const link = navbar.querySelector('a.site-link') as HTMLElement;

    toggler.click();
    expect(navbar.classList.contains('open')).toBe(true);

    link.click();
    expect(navbar.classList.contains('open'), '点击 site-link 后 navbar 未收起').toBe(false);
    expect(toggler.getAttribute('aria-expanded')).toBe('false');
  });

  it('✅ 点击非 site-link 的链接（登录 / 用户下拉菜单项）同样收起', () => {
    loadMobileNavbar();

    const navbar = document.querySelector('.site-navbar')!;
    const toggler = document.querySelector('.site-navbar-toggler') as HTMLElement;
    const dropdown = document.querySelector('.site-user-dropdown')!;
    const loginLink = document.querySelector('.site-login-btn') as HTMLElement;
    const fishLink = document.querySelector('.site-dropdown-item') as HTMLElement;

    // 登录链接（图标 span 在 <a> 内部，target 是 span —— 验证 closest('a') 路径）
    toggler.click();
    loginLink.click();
    expect(navbar.classList.contains('open'), '点击登录链接未收起 navbar（线上 bug）').toBe(false);

    // 用户下拉菜单项 —— 应连下拉一并收起，避免 .open 跨页残留
    toggler.click();
    expect(navbar.classList.contains('open')).toBe(true);
    dropdown.classList.add('open');
    fishLink.click();
    expect(navbar.classList.contains('open'), '点击下拉菜单项未收起 navbar').toBe(false);
    expect(dropdown.classList.contains('open'), '点击下拉菜单项后下拉未收起').toBe(false);
  });

  it('✅ 点击汉堡按钮 / 头像下拉按钮（非 a）不会被误收起', () => {
    loadMobileNavbar();

    const navbar = document.querySelector('.site-navbar')!;
    const toggler = document.querySelector('.site-navbar-toggler') as HTMLElement;
    const ddToggle = document.querySelector('.site-user-dropdown-toggle') as HTMLElement;

    toggler.click();
    expect(navbar.classList.contains('open'), '点击汉堡应展开 navbar').toBe(true);

    // 点开用户下拉 —— 不应顺带收起 navbar
    ddToggle.click();
    expect(navbar.classList.contains('open'), '点击头像下拉按钮不应收起 navbar').toBe(true);
  });
});
