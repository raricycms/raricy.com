// @vitest-environment jsdom
//
// public/static/js/core/base.js —— 顶栏实时流（SSE）与两档兜底轮询。
//
// 【为什么单独一个文件】base-js-init.test.ts 的价值是「初始化时序 + 精确的调用计数」，
// 往里加流相关的用例会把那两件事搅在一起。这里只打流这一块，且**只看可观察行为**
// （建了几条连接、DOM 变没变、20s 里 fetch 了几次），不去读 window 上的私有状态。
//
// 【为什么每条用例都要注入 FakeEventSource】jsdom 不实现 EventSource。base.js 里那句
// `typeof window.EventSource === 'undefined'` 的早退就是为它（和真老浏览器）留的 ——
// 少了那一行，本文件与 base-js-init.test.ts 都会在 new Function 执行时同步抛 ReferenceError。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BASE_JS = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../public/static/js/core/base.js'),
  'utf-8'
);

/** 假 EventSource：记录实例、可手动驱动 open/message/error。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  readyState = 0; // 0 CONNECTING / 1 OPEN / 2 CLOSED
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  /** 测试驱动：连上 */
  fireOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 测试驱动：推来一帧 patch */
  fireMessage(patch: unknown) {
    this.onmessage?.({ data: JSON.stringify(patch) });
  }
}

const TOPBAR_HTML = `
  <meta name="user-authenticated" content="true">
  <meta name="notification-api-url" content="/api/notifications/count">
  <meta name="notification-stream-url" content="/api/notifications/stream">
  <span class="notification-badge" id="notificationBadge"></span>
  <span id="chatUnreadDot"></span>
`;

let fetches = 0;

/** 模拟 Next <Script strategy="afterInteractive">：DOM 已 complete 后才执行。 */
function loadBaseJs(html: string) {
  document.body.innerHTML = html;
  expect(document.readyState).not.toBe('loading');
  (globalThis as any).fetch = () => {
    fetches += 1;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ code: 200, count: 0, chatUnread: false }),
    });
  };
  new Function(BASE_JS)();
}

const badge = () => document.getElementById('notificationBadge')!;
const dot = () => document.getElementById('chatUnreadDot')!;

beforeEach(() => {
  vi.useFakeTimers();
  fetches = 0;
  FakeEventSource.instances = [];
  (window as any).EventSource = FakeEventSource;
  delete (window as any).__raricyTopbar; // 清掉上一轮的流/定时器状态
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as any).EventSource;
});

describe('顶栏流：连接的建立与否', () => {
  it('登录态 + 有 meta → 立刻建一条连接', () => {
    loadBaseJs(TOPBAR_HTML);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/notifications/stream');
  });

  it('没有 notification-stream-url meta → 不建连接（未登录态 / 老页面）', () => {
    loadBaseJs(`
      <meta name="user-authenticated" content="true">
      <meta name="notification-api-url" content="/api/notifications/count">
      <span id="notificationBadge"></span>
    `);

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('未登录（user-authenticated=false）→ 不建连接', () => {
    loadBaseJs(TOPBAR_HTML.replace('content="true"', 'content="false"'));

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('页面在后台时不开流（连接池跨标签页共享，隐藏的标签页不占坑）', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    loadBaseJs(TOPBAR_HTML);

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('浏览器没有 EventSource → 不抛错，纯靠轮询兜底', () => {
    delete (window as any).EventSource;

    expect(() => loadBaseJs(TOPBAR_HTML)).not.toThrow();
    // 兜底轮询照常：20s 后仍会拉一次快照
    vi.advanceTimersByTime(20 * 1000);
    expect(fetches).toBeGreaterThanOrEqual(1);
  });

  it('重复执行 base.js（HMR）→ 关掉旧的再建新的，不叠加连接', () => {
    loadBaseJs(TOPBAR_HTML);
    const first = FakeEventSource.instances[0];

    loadBaseJs(TOPBAR_HTML);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed, '旧连接没关 —— 每重跑一次就多一条长连接').toBe(true);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });
});

describe('顶栏流：补丁落到 DOM', () => {
  it('推来 count → 铃铛数字更新', () => {
    loadBaseJs(TOPBAR_HTML);
    FakeEventSource.instances[0].fireMessage({ count: 3 });

    expect(badge().textContent).toBe('3');
    expect(badge().style.display).toBe('flex');
  });

  it('超过 99 → 显示 99+；回落到 0 → 隐藏且清掉 class', () => {
    loadBaseJs(TOPBAR_HTML);
    const es = FakeEventSource.instances[0];

    es.fireMessage({ count: 150 });
    expect(badge().textContent).toBe('99+');
    expect(badge().classList.contains('large-count')).toBe(true);

    es.fireMessage({ count: 0 });
    expect(badge().style.display).toBe('none');
    expect(badge().classList.contains('large-count'), '缩回 0 却留着 99+ 的 class').toBe(false);
    expect(badge().classList.contains('has-notifications')).toBe(false);
  });

  it('推来 chatUnread → 只点讨论红点，不动铃铛', () => {
    loadBaseJs(TOPBAR_HTML);
    FakeEventSource.instances[0].fireMessage({ count: 5 });
    FakeEventSource.instances[0].fireMessage({ chatUnread: true });

    expect(dot().style.display).toBe('block');
    expect(badge().textContent, '补丁里没有 count，铃铛不该被抹掉').toBe('5');
  });

  it('{refresh:true} → 重拉一次快照（够不着计算函数的服务端只能推这个）', () => {
    loadBaseJs(TOPBAR_HTML);
    const before = fetches;

    FakeEventSource.instances[0].fireMessage({ refresh: true });

    expect(fetches).toBe(before + 1);
  });

  it('坏 JSON 不炸（safeJsonParse 兜底）', () => {
    loadBaseJs(TOPBAR_HTML);

    expect(() => FakeEventSource.instances[0].onmessage?.({ data: '{不是 JSON' })).not.toThrow();
  });
});

describe('顶栏流：两档兜底轮询', () => {
  it('流没连上 → 20s 一次；连上后 → 60s 一次', () => {
    loadBaseJs(TOPBAR_HTML);
    const es = FakeEventSource.instances[0];

    // 未连上：20s 档
    const afterInit = fetches;
    vi.advanceTimersByTime(20 * 1000);
    expect(fetches, '未连上时 20s 没兜底轮询').toBe(afterInit + 1);

    // 连上：切 60s 档
    es.fireOpen();
    vi.advanceTimersByTime(20 * 1000);
    expect(fetches, '流已连上，20s 那次不该再发（应降到 60s）').toBe(afterInit + 1);

    vi.advanceTimersByTime(40 * 1000);
    expect(fetches, '连上后 60s 没兜底轮询').toBe(afterInit + 2);
  });

  it('开流时不会额外拉一次快照（首帧快照由服务端推）', () => {
    loadBaseJs(TOPBAR_HTML);
    const es = FakeEventSource.instances[0];
    const before = fetches;

    es.fireOpen();

    expect(fetches).toBe(before);
  });
});

describe('顶栏流：可见性', () => {
  it('切到后台 → 断开连接并回到 20s 档', () => {
    loadBaseJs(TOPBAR_HTML);
    const es = FakeEventSource.instances[0];
    es.fireOpen();

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(es.closed).toBe(true);

    const afterHide = fetches;
    vi.advanceTimersByTime(20 * 1000);
    expect(fetches, '后台标签页应回到 20s 档（与没有 SSE 时一致）').toBe(afterHide + 1);
  });

  it('回到前台 → 重连 + 补一次快照', () => {
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);

    loadBaseJs(TOPBAR_HTML);
    expect(FakeEventSource.instances).toHaveLength(0);

    hidden = false;
    const before = fetches;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(FakeEventSource.instances, '回到前台没重连').toHaveLength(1);
    expect(fetches, '回到前台应补一次快照').toBe(before + 1);
  });
});
