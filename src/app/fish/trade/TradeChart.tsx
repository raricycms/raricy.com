'use client';

import { useEffect, useRef } from 'react';
import {
  bodyWidthFraction,
  formatAxisPrice,
  formatCandleTime,
  formatPrice,
  itemIndexAtFraction,
  niceTicks,
  timeTicks,
  xFraction,
  yFraction,
  type ChartWindow,
  type DrawnCandle,
  type PlotDomain,
} from '@/lib/market-chart';

// 练手盘的蜡烛图。**纯展示 + 指针手势**：数据、窗口、纵轴范围都由外面算好传进来
// （算术全在 src/lib/market-chart.ts，那边能脱离 DOM 单测）。
//
// 【★ 为什么 SVG 里一个字都没有 ★】绘图区用 `viewBox="0 0 100 100"` +
// `preserveAspectRatio="none"` —— 它把横向与纵向各自拉伸到容器尺寸（这正是图表要的：
// 蜡烛随容器变宽），但**文字会跟着一起拉伸**，容器一扁就把字压成一张饼。所以轴标签、
// 十字光标、价/时徽标全是 HTML，用百分比定位叠在同一格网格上：与 SVG 共用同一个分数，
// 天然对齐，字号却由 CSS 说了算。线宽靠 `vector-effect="non-scaling-stroke"` 保住 1px
// （同改版前那根走势线的手法）。
//
// 【坐标】xFraction / yFraction 都是 0..1 的分数，乘 100 就是 viewBox 单位，
// 也是 HTML 那层的百分号 —— 两边本就是同一条式子，改一处必须改另一处。

const VB = 100; // viewBox 的逻辑边长

export interface TradeChartProps {
  display: string;
  /** 要画的图元（已按窗口聚合过） */
  items: DrawnCandle[];
  win: ChartWindow;
  /** 一根**原始** K 线有多长（毫秒）。时间轴的跨度按它算 —— **别从 items 上推**：
   *  聚合之后相邻两根图元差的是一个桶（6 小时、6 天…），跨度会被算大好几倍，
   *  刻度步长跟着跳档，最后整条轴上只剩一个标签。 */
  candleMs: number;
  domain: PlotDomain;
  mode: 'candle' | 'line';
  /** 指针下的图元下标（`items` 的下标），没指着就是 null */
  hover: number | null;
  onHover(index: number | null): void;
  /** 滚轮 / 缩放钮：factor > 1 = 放大；fraction 是锚点在视口里的位置（0..1） */
  onZoom(factor: number, fraction: number): void;
  /** 拖动：目标窗口的**左端绝对值**（按按下时那个窗口 + 位移算，避免逐帧累加误差） */
  onPanTo(from: number): void;
  onReset(): void;
}

export default function TradeChart({
  display,
  items,
  win,
  candleMs,
  domain,
  mode,
  hover,
  onHover,
  onZoom,
  onPanTo,
  onReset,
}: TradeChartProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);

  // 回调存进 ref：滚轮要挂**非被动**的原生监听（React 的 onWheel 是被动的，
  // preventDefault 会失效、页面会跟着一起滚），而那个 effect 不该每次渲染都重挂。
  const zoomRef = useRef(onZoom);
  useEffect(() => {
    zoomRef.current = onZoom;
  });

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15, r.width > 0 ? (e.clientX - r.left) / r.width : 0.5);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const fractionOf = (clientX: number): number => {
    const r = plotRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? (clientX - r.left) / r.width : 0;
  };

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, from: win.from };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const base = drag.current;
    const r = plotRef.current?.getBoundingClientRect();
    if (base) {
      if (!r || r.width <= 0) return;
      // 往左拖 = 看更早的行情（内容跟着手走，所以是「减位移」）
      onPanTo(base.from - ((e.clientX - base.x) / r.width) * win.count);
      return;
    }
    onHover(itemIndexAtFraction(items, win, fractionOf(e.clientX)));
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  const hoverItem = hover != null && items[hover] ? items[hover] : null;
  const hoverX = hoverItem ? xFraction((hoverItem.i0 + hoverItem.i1) / 2, win) : 0;
  const hoverY = hoverItem ? yFraction(hoverItem.close, domain) : 0;

  const spanMs = win.count * candleMs;
  const priceTicks = niceTicks(domain.min, domain.max, 5);
  const priceStep = priceTicks.length > 1 ? Math.abs(priceTicks[1] - priceTicks[0]) : 1;
  const ticks = timeTicks(items, spanMs);
  const maxVolume = Math.max(1, ...items.map((it) => it.volume));
  // 十字星（开=收）也要看得见：实体给一个最小高度（slot 的 12%）
  const minBody = (VB / win.count) * 0.12;
  const trendUp = items.length > 0 && items[items.length - 1].close >= items[0].open;

  return (
    <div className="trade-chart">
      <div
        className="trade-chart__plot"
        ref={plotRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(e) => {
          if (drag.current) endDrag(e);
          else onHover(null);
        }}
        onDoubleClick={onReset}
      >
        <svg
          className="trade-chart__svg"
          viewBox={`0 0 ${VB} ${VB}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${display} 价格走势（${items.length} 根 K 线）`}
        >
          {/* 网格：与轴上的刻度是同一批数 */}
          <g className="trade-chart__grid">
            {priceTicks.map((t) => (
              <line
                key={`h${t}`}
                x1={0}
                x2={VB}
                y1={yFraction(t, domain) * VB}
                y2={yFraction(t, domain) * VB}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {ticks.map((t) => {
              const it = items[t.index];
              if (!it) return null;
              const x = xFraction((it.i0 + it.i1) / 2, win) * VB;
              return (
                <line key={`v${t.index}`} x1={x} x2={x} y1={0} y2={VB} vectorEffect="non-scaling-stroke" />
              );
            })}
          </g>

          {mode === 'candle'
            ? items.map((it) => {
                const suffix = it.close >= it.open ? 'up' : 'down';
                const cx = xFraction((it.i0 + it.i1) / 2, win) * VB;
                const bw = bodyWidthFraction(it.i0, it.i1, win) * VB;
                const yOpen = yFraction(it.open, domain) * VB;
                const yClose = yFraction(it.close, domain) * VB;
                return (
                  <g key={it.i0}>
                    <line
                      className={`trade-chart__wick trade-chart__wick--${suffix}`}
                      x1={cx}
                      x2={cx}
                      y1={yFraction(it.high, domain) * VB}
                      y2={yFraction(it.low, domain) * VB}
                      vectorEffect="non-scaling-stroke"
                    />
                    <rect
                      className={`trade-chart__candle trade-chart__candle--${suffix}`}
                      x={cx - bw / 2}
                      y={Math.min(yOpen, yClose)}
                      width={bw}
                      height={Math.max(Math.abs(yClose - yOpen), minBody)}
                    />
                  </g>
                );
              })
            : (() => {
                const pts = items
                  .map(
                    (it) =>
                      `${xFraction((it.i0 + it.i1) / 2, win) * VB},${yFraction(it.close, domain) * VB}`
                  )
                  .join(' ');
                return (
                  <>
                    <polygon className="trade-chart__area" points={`0,${VB} ${pts} ${VB},${VB}`} />
                    <polyline
                      className={`trade-chart__line trade-chart__line--${trendUp ? 'up' : 'down'}`}
                      points={pts}
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                );
              })()}
        </svg>

        {/* 十字光标：HTML 的 1px 线（SVG 里那条会被 preserveAspectRatio 拉成非 1px） */}
        {hoverItem && (
          <>
            <div className="trade-chart__cursor trade-chart__cursor--x" style={{ left: `${hoverX * 100}%` }} />
            <div className="trade-chart__cursor trade-chart__cursor--y" style={{ top: `${hoverY * 100}%` }} />
          </>
        )}
      </div>

      <div className="trade-chart__price-axis">
        {priceTicks.map((t) => (
          <span
            key={t}
            className="trade-chart__axis-label trade-chart__axis-label--price"
            style={{ top: `${yFraction(t, domain) * 100}%` }}
          >
            {formatAxisPrice(t, priceStep)}
          </span>
        ))}
        {hoverItem && (
          <span
            className="trade-chart__badge trade-chart__badge--price"
            style={{ top: `${hoverY * 100}%` }}
          >
            {formatPrice(hoverItem.close)}
          </span>
        )}
      </div>

      <div className="trade-chart__volume">
        <svg className="trade-chart__svg" viewBox={`0 0 ${VB} ${VB}`} preserveAspectRatio="none" aria-hidden="true">
          {items.map((it) => {
            const cx = xFraction((it.i0 + it.i1) / 2, win) * VB;
            const bw = bodyWidthFraction(it.i0, it.i1, win) * VB;
            const h = (it.volume / maxVolume) * VB;
            return (
              <rect
                key={it.i0}
                className={`trade-chart__vol-bar trade-chart__vol-bar--${
                  it.close >= it.open ? 'up' : 'down'
                }`}
                x={cx - bw / 2}
                y={VB - h}
                width={bw}
                height={Math.max(h, 0.5)}
              />
            );
          })}
        </svg>
      </div>

      <div className="trade-chart__time-axis">
        {ticks.map((t, idx) => {
          const it = items[t.index];
          if (!it) return null;
          const edge =
            idx === 0 ? ' trade-chart__axis-label--first' : idx === ticks.length - 1 ? ' trade-chart__axis-label--last' : '';
          return (
            <span
              key={`${t.index}-${t.label}`}
              className={`trade-chart__axis-label trade-chart__axis-label--time${edge}`}
              style={{ left: `${xFraction((it.i0 + it.i1) / 2, win) * 100}%` }}
            >
              {t.label}
            </span>
          );
        })}
        {hoverItem && (
          <span
            className="trade-chart__badge trade-chart__badge--time"
            style={{ left: `${hoverX * 100}%` }}
          >
            {formatCandleTime(hoverItem.openTime, spanMs)}
          </span>
        )}
      </div>
    </div>
  );
}
