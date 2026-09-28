// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// trade-chart-panel.test.ts —— 图上那根「末根」追不上当前桶时，会不会自己去补
//
// 【为什么值得单测】这件事的失败**完全静默**：图照常画、坐标全对、不报错、不写日志，
// 只是右端永远停在进页面那一刻 —— 用户看到的是「K 线不自动更新，要手动刷新」
// （2026-09-28 线上）。而它由两个环扣着：服务端那份缓存该不该认（单测在
// market-price.test.ts 的「末根停在上一桶」），以及这里 —— 客户端**补一次没补到
// 之后还补不补**。跨桶那一发**注定**补不到（交易所自己慢半拍，实测 1m 是 2.5 秒，
// 见 ROLLOVER_RETRY_MS 的注释），所以「还补不补」才是这张图会不会动的那一环。
// e2e 摆不出这个场景：替身给不出「末根停在上一桶」的 K 线，而且真等一个桶边界
// 要按分钟计、还得让客户端的钟与替身的钟错开。
//
// 【环境】照 sticker-picker.test.ts：jsdom + react-dom/client + React 19 的 act，
// 不引 @testing-library/react（本仓库没有这个依赖）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
// 补数据的间隔**从组件里 import**（而不是在这里抄一个数）：抄一份的话，哪天调了那个
// 常量，上面那几条「隔一会儿还补不补」的断言会静默地不再测它想测的东西。
import TradeChartPanel, { ROLLOVER_RETRY_MS } from '@/app/fish/trade/TradeChartPanel';
import { INTERVAL_MS, type CandleTuple } from '@/lib/market-candles';

// React 要求显式声明「这是测试环境」，否则 act 会警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IV = INTERVAL_MS['1m'];
const RETRY_MS = ROLLOVER_RETRY_MS;

/** 一串收在一根一根上的 K 线，末根的开桶时刻是 `lastBucket`。 */
function seriesEndingAt(lastBucket: number, n = 3): CandleTuple[] {
  const out: CandleTuple[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push([lastBucket - i * IV, 100, 105, 95, 101, 1]);
  }
  return out;
}

interface Handles {
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  onRolledOver: ReturnType<typeof vi.fn>;
  rerender(candles: CandleTuple[]): Promise<void>;
  unmount(): void;
}

async function mount(candles: CandleTuple[], livePrice = 100): Promise<Handles> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onRolledOver = vi.fn();
  const render = async (cs: CandleTuple[]) => {
    await act(async () => {
      root.render(
        createElement(TradeChartPanel, {
          symbol: 'BTCUSDT',
          display: 'BTC/USDT',
          interval: '1m',
          candles: cs,
          status: 'ready',
          livePrice,
          onIntervalChange: () => {},
          onRetry: () => {},
          onRolledOver,
        })
      );
    });
  };
  await render(candles);
  return {
    root,
    container,
    onRolledOver,
    rerender: render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 让假定时器往前走（回调在 act 里跑，React 的状态更新才会落地）。 */
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // 冻住时钟：桶边界是按 Date.now() 算的，真时间跑这条有「正好跨在边界上」的概率
  vi.setSystemTime(new Date('2026-09-28T12:34:56Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('图表：末根追不上当前桶时的补数据', () => {
  it('末根还停在上一桶 → 立刻补一次，之后每隔一会儿接着补', async () => {
    const now = Date.now();
    const nowBucket = Math.floor(now / IV) * IV;
    // 末根停在**上一桶**：展示价已经越过那条边界，图上会临时追加一根「当前桶」的
    const h = await mount(seriesEndingAt(nowBucket - IV));

    expect(h.onRolledOver, '落后了就该立刻去补').toHaveBeenCalledTimes(1);

    // 第一次补可能补不到（服务端那份缓存还没跨过去、上游抖了一下）——
    // 只要末根还落在过去，就必须**接着补**，不能停在「需要手动刷新」上
    await tick(RETRY_MS);
    expect(h.onRolledOver).toHaveBeenCalledTimes(2);
    await tick(RETRY_MS * 3);
    expect(h.onRolledOver, '一直没追上就一直补').toHaveBeenCalledTimes(5);

    h.unmount();
  });

  it('补上之后就不再补了 —— 它不是一个常驻轮询', async () => {
    const now = Date.now();
    const nowBucket = Math.floor(now / IV) * IV;
    const h = await mount(seriesEndingAt(nowBucket - IV));
    expect(h.onRolledOver).toHaveBeenCalledTimes(1);

    // 补回来的这批追上了当前桶（末根就是当前这一桶）→ 不再追加 → 循环停下
    await h.rerender(seriesEndingAt(nowBucket));
    const after = h.onRolledOver.mock.calls.length;
    await tick(RETRY_MS * 5);
    expect(h.onRolledOver, '追上了还接着补就是把上游打疼').toHaveBeenCalledTimes(after);

    h.unmount();
  });

  it('一开始就没落后（末根就是当前这一桶）→ 一次都不补', async () => {
    const now = Date.now();
    const nowBucket = Math.floor(now / IV) * IV;
    const h = await mount(seriesEndingAt(nowBucket));
    await tick(RETRY_MS * 3);
    expect(h.onRolledOver).not.toHaveBeenCalled();
    h.unmount();
  });

  it('跟上之后又跨了一桶 → 重新开始补（不是「一辈子只补一次」）', async () => {
    const now = Date.now();
    const nowBucket = Math.floor(now / IV) * IV;
    const h = await mount(seriesEndingAt(nowBucket - IV));
    await h.rerender(seriesEndingAt(nowBucket));
    const after = h.onRolledOver.mock.calls.length;

    // 时间往前走一个桶 → 手上这批又落在过去了
    vi.setSystemTime(now + IV + 5_000);
    await h.rerender(seriesEndingAt(nowBucket));
    expect(h.onRolledOver.mock.calls.length).toBeGreaterThan(after);

    h.unmount();
  });
});
