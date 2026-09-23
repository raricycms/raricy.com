'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  CANDLE_LIMIT,
  INTERVAL_LABELS,
  INTERVAL_MS,
  MARKET_INTERVALS,
  type CandleTuple,
  type MarketInterval,
} from '@/lib/market-candles';
import {
  clampWindow,
  drawCandles,
  formatPct,
  formatPrice,
  indexAtFraction,
  mergeLivePrice,
  priceDomain,
  resetWindow,
  zoomWindow,
  type ChartWindow,
} from '@/lib/market-chart';
import TradeChart from './TradeChart';
import type { CandleStatus } from './useCandles';

// 图表面板：工具条（图例 / 周期档 / K线-折线 / 缩放钮）+ 图表本体 + 装载与错误态。
//
// 【「窗口」与「光标」归这里】TradeChart 只管画与手势，把「指针在第几根」「缩放锚点」
// 这些事交给它自己的话，父组件就没法在切标的时把视野复位 —— 状态分两层最容易出的
// 就是「切了标的看着还是旧窗口」。
//
// 【win 为 null = 交给默认视野】切标的/周期时置 null，等数据到位自动落成
// 「最近 DEFAULT_VISIBLE_CANDLES 根」。比在切的那一瞬间算窗口好：那一刻数据往往
// 还没到，算出来的窗口会贴着空气。
//
// 【展示价并进最后一根】见 market-chart.ts 的 mergeLivePrice。**它只是展示** ——
// 成交价永远由服务端在下单那一刻现取，这条图上的线一根手指也碰不到它。

export interface TradeChartPanelProps {
  symbol: string;
  display: string;
  interval: MarketInterval;
  candles: CandleTuple[];
  status: CandleStatus;
  /** 该标的的展示价（1 秒轮询那份）。null = 这一轮没拿到 */
  livePrice: number | null;
  onIntervalChange(interval: MarketInterval): void;
  onRetry(): void;
  /** 展示价跨过了末根的桶边界 —— 该去补一次真数据了 */
  onRolledOver(): void;
}

const MODE_OPTIONS = [
  { value: 'candle', label: 'K 线' },
  { value: 'line', label: '折线' },
] as const;

export default function TradeChartPanel({
  symbol,
  display,
  interval,
  candles,
  status,
  livePrice,
  onIntervalChange,
  onRetry,
  onRolledOver,
}: TradeChartPanelProps) {
  const [mode, setMode] = useState<'candle' | 'line'>('candle');
  const [win, setWin] = useState<ChartWindow | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  // 切标的 / 切周期 → 视野与光标复位。**在渲染期同步做**（而不是塞进 useEffect）：
  // 用 effect 的话会先提交一帧「新标的数据 + 旧标的的窗口」，肉眼能看见那一下错位。
  const viewKey = `${symbol}:${interval}`;
  const [lastKey, setLastKey] = useState(viewKey);
  if (lastKey !== viewKey) {
    setLastKey(viewKey);
    setWin(null);
    setHover(null);
  }

  // 展示价并进最后一根。**刻意不用 useMemo**：它只碰最后一根（O(1)），而它要的
  // 是**这一次渲染的时刻** —— 挂起 memo 之后，行情冻住时「跨桶」永远不会被检测到，
  // 而那恰恰是它要处理的场景之一（币价冻住一秒很常见，冻住一整根不常见但会发生）。
  const merged = mergeLivePrice(
    candles,
    livePrice ?? NaN,
    Date.now(),
    INTERVAL_MS[interval],
    CANDLE_LIMIT
  );

  // 跨桶 → 静默补一次真数据。依赖只有那个布尔量，所以一次跨越只触一次；
  // 补回来的数据落地后它自己变回 false，下一根再跨时重新触发。
  const rolledRef = useRef(onRolledOver);
  useEffect(() => {
    rolledRef.current = onRolledOver;
  });
  useEffect(() => {
    if (merged.rolledOver) rolledRef.current();
  }, [merged.rolledOver]);

  const len = merged.candles.length;
  const view = useMemo(() => clampWindow(win ?? resetWindow(len), len), [win, len]);
  const { items, bucketSize } = useMemo(
    () => drawCandles(merged.candles, view),
    [merged.candles, view]
  );
  const domain = useMemo(() => priceDomain(items), [items]);

  const shown = hover != null && items[hover] ? items[hover] : items[items.length - 1] ?? null;
  const changePercent = shown ? ((shown.close - shown.open) / shown.open) * 100 : null;

  function zoomAt(factor: number, fraction: number) {
    setWin((prev) => zoomWindow(prev ?? resetWindow(len), factor, indexAtFraction(fraction, view), len));
  }

  return (
    <div className="trade-chart-panel">
      <div className="trade-chart__bar">
        <span className="trade-chart__symbol">
          {display}
          <span className="trade-chart__interval-tag">{INTERVAL_LABELS[interval]}</span>
        </span>

        {shown && (
          <span className="trade-chart__legend">
            <span className="trade-chart__legend-item">
              开 <b>{formatPrice(shown.open)}</b>
            </span>
            <span className="trade-chart__legend-item">
              高 <b>{formatPrice(shown.high)}</b>
            </span>
            <span className="trade-chart__legend-item">
              低 <b>{formatPrice(shown.low)}</b>
            </span>
            <span className="trade-chart__legend-item">
              收 <b>{formatPrice(shown.close)}</b>
            </span>
            {changePercent != null && (
              <span
                className={`trade-chart__legend-change trade-chart__legend-change--${
                  changePercent >= 0 ? 'up' : 'down'
                }`}
              >
                {formatPct(changePercent)}
              </span>
            )}
            {bucketSize > 1 && (
              <span className="trade-chart__legend-note">每根 = {bucketSize} 根聚合</span>
            )}
          </span>
        )}

        <div className="trade-chart__interval" role="group" aria-label="K 线周期">
          {MARKET_INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              className={`trade-chart__interval-btn${iv === interval ? ' is-active' : ''}`}
              onClick={() => onIntervalChange(iv)}
              aria-pressed={iv === interval}
            >
              {INTERVAL_LABELS[iv]}
            </button>
          ))}
        </div>

        {/* K线 / 折线：**同一个视图的两种呈现** —— 正是 docs/frontend-styles.md §6.8
            给 `.segmented` 划的那条判据。周期档反过来：6 选 1、且选项还可能变多，
            所以那边走切页档按钮。 */}
        <div
          className="segmented trade-chart__mode"
          role="group"
          aria-label="图表形态"
          style={
            {
              '--seg-i': MODE_OPTIONS.findIndex((o) => o.value === mode),
              '--seg-n': MODE_OPTIONS.length,
            } as CSSProperties
          }
        >
          <span className="segmented__thumb" aria-hidden="true" />
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`segmented__btn${o.value === mode ? ' is-active' : ''}`}
              aria-pressed={o.value === mode}
              onClick={() => setMode(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="trade-chart__zoom">
          <button
            type="button"
            className="trade-chart__zoom-btn"
            aria-label="放大"
            title="放大"
            onClick={() => zoomAt(1.4, 0.5)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="trade-chart__zoom-btn"
            aria-label="缩小"
            title="缩小"
            onClick={() => zoomAt(1 / 1.4, 0.5)}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {len === 0 && status === 'loading' ? (
        <p className="trade-chart__state">K 线加载中…</p>
      ) : len === 0 ? (
        <div className="trade-chart__state">
          <p>K 线暂不可用，稍后自动重试。行情本身照常刷新。</p>
          <button type="button" className="trade-chart__retry" onClick={onRetry}>
            重新加载
          </button>
        </div>
      ) : (
        <TradeChart
          display={display}
          items={items}
          win={view}
          candleMs={INTERVAL_MS[interval]}
          domain={domain}
          mode={mode}
          hover={hover}
          onHover={setHover}
          onZoom={zoomAt}
          onPanTo={(from) => setWin(clampWindow({ from, count: view.count }, len))}
          onReset={() => setWin(null)}
        />
      )}

      <p className="trade-chart__hint">
        滚轮缩放 · 拖动平移 · 双击复位 · 已加载 {len} 根
      </p>
    </div>
  );
}
