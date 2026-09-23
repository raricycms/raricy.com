'use client';

import { formatPct, formatPrice } from '@/lib/market-chart';

// 自选列表（标的选择）。**它同时是标的选择器与行情卡** —— 改版前这两件事分在两处
//（一排 .trade-symbol 按钮决定买什么，另一张行情卡显示两张走势线），点下去只影响下单、
// 对图毫无作用。
//
// 【窄屏是同一份 DOM】≤991px 时 CSS 把行摊成横向条（见 _fish-trade.scss），
// **不另写一套 JSX** —— 两套 DOM 的代价是两份状态与两处会 drift 的类名。
//
// 【加一个标的只改 MARKET_SYMBOLS 一处】行是 rows.map 出来的，这里不认币名。
// 短名走服务端给的 display（displaySymbol）。

export interface WatchRow {
  symbol: string;
  display: string;
  /** null = 这一轮没拿到价，显示「—」而不是编一个 */
  price: number | null;
  changePercent: number | null;
  /** 这份报价超过 QUOTE_STALE_MS（40 秒）—— 页面要明说「可能不是最新的」 */
  stale: boolean;
  /** 最近 72 根收盘价（服务端从同一批 K 线里切出来的那份） */
  closes: number[];
}

/** 价格走势线。手写 SVG：站内没有图表库，也不该为一张曲线引一个进来。 */
function Sparkline({ closes, label }: { closes: number[]; label: string }) {
  if (closes.length < 2) return null;
  const W = 160;
  const H = 40;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const points = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * W;
      const y = H - ((c - min) / span) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const up = closes[closes.length - 1] >= closes[0];
  return (
    <svg
      className="trade-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline
        className={`trade-spark__line trade-spark__line--${up ? 'up' : 'down'}`}
        points={points}
        // 没有它，preserveAspectRatio="none" 会把描边横向拉粗
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function TradeWatchlist({
  rows,
  symbol,
  disabled,
  onSelect,
}: {
  rows: WatchRow[];
  symbol: string;
  /** 下单/确认弹窗开着时不让切标的（那两屏的文案是按当前标的算好的） */
  disabled: boolean;
  onSelect(symbol: string): void;
}) {
  // 「一个价都没有」= 行情源这一轮整个挂了。此时**禁掉下单**（TradePanel 那边读同一个
  // 判断），而不是显示一堆「—」让人照着按。
  const down = rows.length === 0 || rows.every((r) => r.price == null);
  const anyStale = rows.some((r) => r.stale);

  return (
    /* trade-card--quote 是**给 e2e 的钩子**（fish-trade.spec.ts 用它断言「行情卡在不在」），
       不带样式 —— 外观全由 .trade-card 给。登记在 tests/unit/css-tsx-classes.test.ts
       的 CONSUMED 里，别顺手删。 */
    <div className="trade-card trade-card--quote trade-watch">
      <h2 className="trade-card__title">自选</h2>
      {down ? (
        <p className="trade-watch__down">行情暂不可用，稍后自动重试。此时无法下单。</p>
      ) : (
        <ul className="trade-watch__list">
          {rows.map((r) => {
            const active = r.symbol === symbol;
            return (
              <li key={r.symbol}>
                <button
                  type="button"
                  className={`trade-watch__row${active ? ' is-active' : ''}`}
                  onClick={() => onSelect(r.symbol)}
                  disabled={disabled}
                  aria-pressed={active}
                >
                  <span className="trade-watch__head">
                    <span className="trade-watch__name">{r.display}</span>
                    {r.changePercent != null && (
                      <span
                        className={`trade-watch__change trade-watch__change--${
                          r.changePercent >= 0 ? 'up' : 'down'
                        }`}
                      >
                        {formatPct(r.changePercent)}
                      </span>
                    )}
                  </span>
                  <span className="trade-watch__price">
                    {r.price == null ? '—' : formatPrice(r.price)}
                    <span className="trade-watch__unit">USDT</span>
                  </span>
                  <Sparkline closes={r.closes} label={`${r.display} 近 72 小时价格走势`} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!down && anyStale && (
        <p className="trade-watch__stale">行情更新有延迟，数据可能不是最新的。</p>
      )}
    </div>
  );
}
