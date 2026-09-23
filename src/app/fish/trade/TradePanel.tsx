'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AMOUNT_ERROR, fmtFish, parseFishAmount, roundFish } from '@/lib/fish-amount';
import { FISH_UNIT_SCALE, unitsToFish } from '@/lib/fish-units';
import { settleClose, formatFeeRate } from '@/lib/market-math';
// 只取类型：`import type` 在编译期被擦掉，不会把 market-price（它 import 了 db-time）
// 拖进客户端包。**别改成值导入**，也别在本地重抄一份同样的联合类型（两份必然 drift）。
import type { QuoteSource } from '@/lib/market-price';

// 练手盘面板：行情 + 买入 + 持仓 + 平仓。
//
// 【三个不显然的地方】
//
// ① **前端不传价。** 提交的 body 里只有标的与金额 —— 成交价由服务端在下单那一刻
//    向行情源现取（见 src/lib/market-price.ts）。界面上那个价是**展示值**（15 秒
//    一轮的缓存），确认弹窗必须如实说明「实际成交价以下单那一刻为准」。把展示价
//    当成成交价显示，就是在骗用户。
//
// ② **幂等键在打开确认弹窗那一刻生成**，成功后才换。失败（含 503）保留弹窗与已填
//    内容，重试复用同一个键 —— 于是「响应丢包后重试」不会买成两笔。开仓要键是因为
//    同额分批建仓是正常操作，服务端没法靠参数判重；平仓不需要（仓位一旦平掉，
//    再平就是重放）。
//
// ③ **平仓没有「卖一半」。** 一个批次就是一个仓位，整进整出 —— 部分平仓会把幂等
//    做成一件难事（同一请求重放时要认出「这是同一笔」而不是「又一次部分平仓」）。
//
// 【为什么成功后 router.refresh() 而不是 setState】持仓列表是**服务端渲染**的
//（它要读库），与 TransferPanel 那种「余额在手里、setState 就够」的场景不同。

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

/**
 * 行情轮询间隔。
 *
 * 【为什么从 15 秒降到 1 秒】服务端那份展示缓存现在由一条常驻 WebSocket 喂
 *（market-stream.ts，实测 ~50ms 一帧），前端这一跳于是成了唯一的瓶颈 —— 还按 15 秒
 * 读的话，屏幕上的价照样是 15 秒旧的。降到 1 秒后页面上的价每秒跳一次。
 * 代价是每标签页 1 请求/秒，而那个接口读的是进程内存里的缓存（只多一次用户行读），
 * 且隐藏标签页不轮（见下面的 tick）。
 */
const POLL_MS = 1_000;

export interface QuoteView {
  symbol: string;
  display: string;
  /** null = 这一轮没拿到价（行情源抖动），页面显示「—」而不是编一个 */
  price: number | null;
  changePercent: number | null;
  stale: boolean;
  /** 这个价是 WS 实时流给的还是 15 秒轮询给的。**不渲染** —— 只让首屏与轮询同形 */
  source: QuoteSource;
}

export interface PositionProp {
  id: string;
  symbol: string;
  display: string;
  stake: number;
  entryPrice: number;
  openedAt: string;
}

/** 价格展示：保留 2 位小数并加千分位。**不用 toLocale***（见 db-time-guard 规则 4）。 */
function fmtPrice(n: number): string {
  const [int, frac] = n.toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** 涨跌幅：带符号，2 位小数。 */
function fmtPct(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 开仓时刻。库内是 UTC+8 墙上时间，读它必须用 getUTC*（db-time-guard 规则 5）。 */
function fmtOpenedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
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

export default function TradePanel({
  balance: initialBalance,
  positions,
  initialQuotes,
  candles,
  feeRate,
  minStake,
}: {
  balance: number;
  positions: PositionProp[];
  initialQuotes: QuoteView[];
  candles: Record<string, number[]>;
  feeRate: number;
  minStake: number;
}) {
  const router = useRouter();
  const [balance, setBalance] = useState(initialBalance);
  const [quotes, setQuotes] = useState<QuoteView[]>(initialQuotes);
  const [symbol, setSymbol] = useState<string>(initialQuotes[0]?.symbol ?? 'BTCUSDT');
  const [amount, setAmount] = useState('');
  const [buyOpen, setBuyOpen] = useState(false);
  const [sellTarget, setSellTarget] = useState<PositionProp | null>(null);
  const [busy, setBusy] = useState(false);
  // 幂等键：打开弹窗那一刻生成，成功后才换（失败重试复用同一个 → 不会买成两笔）
  const idemRef = useRef<string>('');

  // 行情轮询。隐藏标签页不轮（HTTP/1.1 每源 6 连接且跨标签页共享），
  // 回前台先补一次（照 ChatApp 的做法）。轮询失败静默等下一轮 —— 页面上已经有
  // stale 标记告诉用户「数据可能不是最新的」，不需要再弹 toast。
  useEffect(() => {
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/fish/trade/quote', { credentials: 'same-origin' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.code === 200 && Array.isArray(data.quotes)) {
          setQuotes(
            data.quotes.map((q: Record<string, unknown>) => ({
              symbol: String(q.symbol),
              display: String(q.display),
              price: typeof q.price === 'number' ? q.price : null,
              changePercent: typeof q.change_percent === 'number' ? q.change_percent : null,
              stale: !!q.stale,
              // 只认白名单里的两个值：接口多回什么都不会漏进类型
              source: q.source === 'stream' ? ('stream' as const) : ('poll' as const),
            }))
          );
        }
      } catch {
        /* 下一轮再说 */
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const current = quotes.find((q) => q.symbol === symbol) ?? quotes[0];
  const priceOf = (sym: string) => quotes.find((q) => q.symbol === sym)?.price ?? null;
  const displayOf = (sym: string) => quotes.find((q) => q.symbol === sym)?.display ?? sym;

  const trimmed = amount.trim();
  const parsed = parseFishAmount(trimmed) ?? NaN;
  const amountError =
    trimmed === ''
      ? ''
      : !Number.isFinite(parsed)
        ? AMOUNT_ERROR
        : parsed <= 0
          ? '金额需大于 0'
          : parsed < minStake
            ? `单笔最少 ${minStake} 条小鱼干`
            : parsed > balance
              ? '小鱼干不足'
              : '';
  const amountOk = Number.isFinite(parsed) && parsed >= minStake && parsed <= balance;
  const canBuy = amountOk && current != null;
  const afterBalance = amountOk ? roundFish(balance - parsed) : balance;

  // 某一笔持仓按**展示价**估的卖出细则。真实结算价以下单那一刻为准（见文件头 ①）。
  //
  // 算术全部来自 settleClose（market-math.ts）—— **服务端真结算用的是同一个函数**，
  // 所以「预计到手」与真到账必然一致。别把公式抄进这里：两份就会 drift，而用户正是
  // 看着这个数决定要不要平仓。
  //
  // ⚠️ 单位换算必须走 FISH_UNIT_SCALE，**别写死 10**：精度提到 0.0001 之后写死的 10
  // 会**静默错 1000 倍**（投 1 条的仓位估算「可卖」显示约 1.0 而不是约 999）。
  // 走 Math.round 而不是 fishToUnits 也是刻意的：后者对超精度**抛错**，而这里是渲染
  // 路径 —— 一个脏数据不该把整页打崩，四舍五入到最近的单位即可。
  function estimate(p: PositionProp) {
    const px = priceOf(p.symbol);
    if (px == null) return null;
    const stakeUnits = Math.round(p.stake * FISH_UNIT_SCALE);
    const s = settleClose({ stakeUnits, entryPrice: p.entryPrice, exitPrice: px, feeRate });
    return {
      px,
      /** 实发（到手） */
      payout: unitsToFish(s.payoutUnits),
      /** 毛额（未扣手续费的卖出金额） */
      gross: unitsToFish(s.grossUnits),
      profit: unitsToFish(s.payoutUnits - stakeUnits),
      /** 手续费 + floor 零头 —— 弹窗里「毛额 − 手续费 = 到手」要对得上（见 market-math.ts） */
      fee: unitsToFish(s.feeUnits),
      /** 较开仓价的涨跌幅（不含手续费）。行情卡上那个是 24 小时涨跌，两者不是一回事 */
      changePercent: s.changePercent,
      /** 盈亏率（含手续费与 floor） */
      profitPercent: s.profitPercent,
    };
  }

  function openBuy() {
    idemRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `mrk-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
        : `mrk-${Math.random().toString(36).slice(2, 22)}`;
    setBuyOpen(true);
  }

  async function submitBuy() {
    if (!amountOk || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/trade/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          symbol,
          amount: parsed,
          idempotency_key: idemRef.current,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        window.showToast?.(data.message ?? '买入成功', 'success');
        setBalance(typeof data.balance === 'number' ? data.balance : balance);
        setAmount('');
        setBuyOpen(false);
        idemRef.current = '';
        router.refresh();
      } else {
        // 失败保留弹窗与已填内容、**保留幂等键** —— 503 这类瞬时故障原样重试一次就好
        window.showToast?.(data?.message ?? '买入失败，请稍后再试', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitSell() {
    if (!sellTarget || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/trade/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ position_id: sellTarget.id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        window.showToast?.(data.message ?? '已卖出', 'success');
        setBalance(typeof data.balance === 'number' ? data.balance : balance);
        setSellTarget(null);
        router.refresh();
      } else {
        window.showToast?.(data?.message ?? '卖出失败，请稍后再试', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  const anyStale = quotes.some((q) => q.stale);
  const quoteDown = quotes.length === 0 || quotes.every((q) => q.price == null);
  // 弹窗里的那一整套估算算一次就好（下面要用到六七个数，逐个 estimate() 是六七次重算，
  // 且两处调用之间行情刷新会让同一个数在弹窗里显示成两个值）
  const sellEst = sellTarget ? estimate(sellTarget) : null;

  return (
    <>
      {/* trade-card--quote 是**给 e2e 的钩子**（fish-trade.spec.ts 用它断言行情卡在不在），
          不带样式 —— 外观全由 .trade-card 给。登记在 tests/unit/css-tsx-classes.test.ts
          的 CONSUMED 里，别顺手删。 */}
      <div className="trade-card trade-card--quote">
        {quoteDown ? (
          <p className="trade-quote__down">行情暂不可用，稍后自动重试。此时无法下单。</p>
        ) : (
          <>
            {quotes.map((q) => (
              <div className="trade-quote" key={q.symbol}>
                <div className="trade-quote__head">
                  <span className="trade-quote__name">{q.display}</span>
                  <span className="trade-quote__price">
                    {q.price == null ? '—' : fmtPrice(q.price)}
                    <span className="trade-quote__unit">USDT</span>
                  </span>
                  {q.changePercent != null && (
                    <span
                      className={`trade-quote__change trade-quote__change--${
                        q.changePercent >= 0 ? 'up' : 'down'
                      }`}
                    >
                      {fmtPct(q.changePercent)}
                    </span>
                  )}
                </div>
                <Sparkline
                  closes={candles[q.symbol] ?? []}
                  label={`${q.display} 近 72 小时价格走势`}
                />
              </div>
            ))}
            {anyStale && (
              <p className="trade-quote__stale">行情更新有延迟，数据可能不是最新的。</p>
            )}
          </>
        )}
      </div>

      <div className="trade-card">
        <div className="trade-card__head">
          <span className="trade-card__balance-label">我的余额</span>
          <span className="trade-card__balance-number">{fmtFish(balance)}</span>
          <span className="trade-card__balance-unit">小鱼干</span>
        </div>

        <div className="trade-field">
          <span className="trade-field__label">标的</span>
          {/* 用「切页档」按钮而不是 .segmented 胶囊滑块 —— 见 docs/frontend-styles.md §6.8：
              滑块只给「2 选 1 的互斥**视图**切换」，而这里选项可能变多（加币），
              且点下去决定了买什么。两条都踩在「不要用」的判据上。 */}
          <div className="trade-symbol" role="group" aria-label="选择标的">
            {quotes.map((q) => (
              <button
                key={q.symbol}
                type="button"
                className={`trade-symbol__btn${q.symbol === symbol ? ' is-active' : ''}`}
                onClick={() => setSymbol(q.symbol)}
                disabled={busy}
                aria-pressed={q.symbol === symbol}
              >
                {q.display}
              </button>
            ))}
          </div>
        </div>

        <div className="trade-field">
          <label className="trade-field__label" htmlFor="trade-amount">
            投入
          </label>
          <div className="trade-amount">
            <input
              id="trade-amount"
              className="trade-amount__input"
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
            <span className="trade-amount__unit">小鱼干</span>
          </div>
          {current?.price != null && (
            <p className="trade-field__hint">
              当前 {current.display} ≈ {fmtPrice(current.price)} USDT
            </p>
          )}
          {amountError && <p className="trade-field__hint trade-field__hint--error">{amountError}</p>}
        </div>

        <div className="trade-summary">
          <span>
            单笔最少 <strong>{minStake}</strong> 条鱼干
          </span>
          <span>
            手续费 <strong>{formatFeeRate(feeRate)}</strong>
            <span className="trade-summary__note">（卖出时收）</span>
          </span>
        </div>

        <button
          type="button"
          className="trade-submit"
          disabled={!canBuy || busy || quoteDown}
          onClick={openBuy}
        >
          买入
        </button>
      </div>

      <div className="trade-card">
        <h2 className="trade-card__title">我的持仓</h2>
        {positions.length === 0 ? (
          <p className="trade-empty">还没有持仓。买入后会出现在这里，价格涨跌随时可卖。</p>
        ) : (
          <ul className="trade-positions">
            {positions.map((p) => {
              const est = estimate(p);
              return (
                <li className="trade-position" key={p.id}>
                  <div className="trade-position__main">
                    <span className="trade-position__name">{p.display}</span>
                    <span className="trade-position__stake">{fmtFish(p.stake)} 鱼干</span>
                    <span className="trade-position__entry">
                      开仓 {fmtPrice(p.entryPrice)}
                      <span className="trade-position__time"> · {fmtOpenedAt(p.openedAt)}</span>
                    </span>
                    {/* 「较开仓」而不是光写一个百分数：行情卡上那个百分数是**24 小时**涨跌，
                        两个数会在同一屏里各说各话。取不到价就整行不渲染（不是显示 0.00%）。 */}
                    {est && (
                      <span className="trade-position__now">
                        现价 {fmtPrice(est.px)}
                        <span
                          className={`trade-position__change trade-position__change--${
                            est.changePercent >= 0 ? 'up' : 'down'
                          }`}
                        >
                          较开仓 {fmtPct(est.changePercent)}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="trade-position__pnl">
                    {est ? (
                      <>
                        <span
                          className={`trade-position__profit trade-position__profit--${
                            est.profit >= 0 ? 'up' : 'down'
                          }`}
                        >
                          {est.profit > 0 ? '+' : ''}
                          {fmtFish(est.profit)}
                        </span>
                        <span className="trade-position__payout">
                          可卖 {fmtFish(est.payout)} 鱼干
                        </span>
                      </>
                    ) : (
                      <span className="trade-position__payout">—</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="trade-position__sell"
                    onClick={() => setSellTarget(p)}
                    disabled={busy}
                  >
                    卖出
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {buyOpen && current && (
        <div className="modal-overlay show" onClick={() => !busy && setBuyOpen(false)}>
          <div
            className="modal-dialog trade-confirm"
            role="dialog"
            aria-label="确认买入"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">确认买入</h3>
              </div>
              <div className="modal-body">
                <dl className="trade-confirm__rows">
                  <div className="trade-confirm__row">
                    <dt>标的</dt>
                    <dd>{current.display}</dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>投入</dt>
                    <dd>{fmtFish(parsed)} 小鱼干</dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>参考价</dt>
                    <dd>{current.price == null ? '—' : fmtPrice(current.price)} USDT</dd>
                  </div>
                  <div className="trade-confirm__row trade-confirm__row--total">
                    <dt>买入后余额</dt>
                    <dd>{fmtFish(afterBalance)} 小鱼干</dd>
                  </div>
                </dl>
                <p className="trade-confirm__disclaimer">
                  实际成交价以下单那一刻的行情为准，可能与上面的参考价有细微差异。
                  价格下跌时卖出会亏掉一部分本金，最坏输光这一笔投入。
                </p>
                <div className="trade-confirm__actions">
                  <button
                    type="button"
                    className="trade-confirm__cancel"
                    onClick={() => setBuyOpen(false)}
                    disabled={busy}
                  >
                    再想想
                  </button>
                  <button
                    type="button"
                    className="trade-confirm__ok"
                    onClick={() => void submitBuy()}
                    disabled={busy}
                  >
                    {busy ? '买入中…' : '确认买入'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {sellTarget && (
        <div className="modal-overlay show" onClick={() => !busy && setSellTarget(null)}>
          <div
            className="modal-dialog trade-confirm"
            role="dialog"
            aria-label="确认卖出"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">确认卖出</h3>
              </div>
              <div className="modal-body">
                {/* 这一屏是「卖出细则」。三件事按用户的实际问题排：
                    价（涨了多少）→ 账（毛额 / 手续费 / 盈亏，加起来必须等于到手）→ 到手。
                    ⚠️ 末三行是**加得起来**的：毛额 − 手续费 = 到手、到手 − 投入 = 盈亏。
                    改动其中任何一行前先确认这条还成立 —— 屏幕上对不上的账比不显示更糟。
                    取不到行情价时整组显示「—」（估不出来就说估不出来，不编一个 0）。 */}
                <dl className="trade-confirm__rows">
                  <div className="trade-confirm__row">
                    <dt>标的</dt>
                    <dd>{sellTarget.display}</dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>投入</dt>
                    <dd>{fmtFish(sellTarget.stake)} 小鱼干</dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>开仓价</dt>
                    <dd>{fmtPrice(sellTarget.entryPrice)} USDT</dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>现价</dt>
                    <dd>
                      {sellEst ? (
                        <>
                          {fmtPrice(sellEst.px)} USDT
                          <span
                            className={`trade-confirm__delta trade-confirm__delta--${
                              sellEst.changePercent >= 0 ? 'up' : 'down'
                            }`}
                          >
                            {fmtPct(sellEst.changePercent)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>卖出金额</dt>
                    <dd>{sellEst ? `${fmtFish(sellEst.gross)} 小鱼干` : '—'}</dd>
                  </div>
                  {/* 费率从 feeRate 插值，**别写死数值**（同 RULES 那条纪律：数值只有
                      一处权威）。文本走 formatFeeRate —— 位数由它定，这里别自己
                      toFixed（费率变小会被 toFixed 抹成「0.0%」，见那个函数的注释） */}
                  <div className="trade-confirm__row">
                    <dt>手续费 {formatFeeRate(feeRate)}</dt>
                    <dd>{sellEst ? `-${fmtFish(sellEst.fee)} 小鱼干` : '—'}</dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>预计盈亏</dt>
                    {/* 颜色挂在**里层的 span** 上，不是 dd 自己：`.trade-confirm__row dd`
                        是 0-1-1，压得住任何挂在 dd 上的单类选择器（0-1-0）——
                        直接写 dd 上就是静默不变色。 */}
                    <dd>
                      {sellEst ? (
                        <span
                          className={`trade-confirm__pnl trade-confirm__pnl--${
                            sellEst.profit >= 0 ? 'up' : 'down'
                          }`}
                        >
                          {sellEst.profit > 0 ? '+' : ''}
                          {fmtFish(sellEst.profit)} 小鱼干（{fmtPct(sellEst.profitPercent)}）
                        </span>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="trade-confirm__row trade-confirm__row--total">
                    <dt>预计到手</dt>
                    <dd>{sellEst ? `${fmtFish(sellEst.payout)} 小鱼干` : '—'}</dd>
                  </div>
                </dl>
                <p className="trade-confirm__disclaimer">
                  上面的价与金额都按<strong>展示价</strong>估算，实际到手以下单那一刻的成交价为准。
                  卖出后这一笔仓位就结清了，不能再恢复。
                </p>
                <div className="trade-confirm__actions">
                  <button
                    type="button"
                    className="trade-confirm__cancel"
                    onClick={() => setSellTarget(null)}
                    disabled={busy}
                  >
                    再想想
                  </button>
                  <button
                    type="button"
                    className="trade-confirm__ok"
                    onClick={() => void submitSell()}
                    disabled={busy}
                  >
                    {busy ? '卖出中…' : '确认卖出'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
