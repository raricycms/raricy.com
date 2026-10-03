import Link from 'next/link';
import { redirect, forbidden } from 'next/navigation';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import {
  listOpenPositions,
  listSettledPositions,
  displaySymbol,
  MARKET_FEE_RATE,
  MIN_STAKE_FISH,
  LEVERAGE_OPTIONS,
  LOTTERY_LEVERAGE,
  type SettledPositionView,
} from '@/lib/market-service';
// 杠杆档位能不能选，取决于**强平引擎此刻在不在跑**（服务端也会据此拒单，见那里的注释）
import { isLiquidationRunning } from '@/lib/market-liquidator';
import { getCachedQuotes, getCandles, MARKET_SYMBOLS } from '@/lib/market-price';
import { fmtFish } from '@/lib/fish-amount';
import { formatPrice } from '@/lib/market-chart';
import {
  DEFAULT_INTERVAL,
  candleKey,
  sparkCloses,
  type CandleTuple,
} from '@/lib/market-candles';
import TradePanel, { type QuoteView, type PositionProp } from './TradePanel';

// 鱼干练手盘 —— 投入鱼干买入一个绑定真实加密价格的仓位。
//
// 【档位 core+】与签到、投喂同档。它是**签到之外第二条 core+ 赚取渠道**：赚了凭空
// 加进用户余额、亏了少发给他 —— **没有「系统水池」那一行**，它表现为全站鱼干总量的
// 增减（见 docs/architecture.md §6.3）。
// 没有突破「非核心账号没有鱼干赚取渠道」这条口径 —— 只是把 core+ 的路多开了一条。
//
// 【为什么不用 guard.ts 的 requireCoreUser】那个门的 next 取自 referer，而练手盘是
// 从 /fish 面板点进来的：直连 / 书签 / 无 referer 时它会退化成 `next=/`，登录完被
// 扔回首页而不是这里。路径是已知的，直接写死进 next —— 与签到、/fish/* 各页同款。
// access-control.spec 把这条钉死了。
export const dynamic = 'force-dynamic';

export default async function FishTradePage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish/trade'));
  if (!isCoreUser(user)) forbidden();
  // 专注模式：与上面那条同款（原地 403，不跳登录）。forbidden() 是 Next 内建的、
  // 收不了文案，所以这里给不出「因为专注模式」这句话 —— 而入口（/fish 卡片与
  // /fish/market 页脚那三处）在专注模式下**整段不渲染**，所以解释只剩一处：
  // /settings 的专注模式说明。直连 URL 进来的看到的是 403 页那句通用「权限不足」。
  if (user.focusMode) forbidden();

  const [balance, positions, settled, quoteData, candleEntries] = await Promise.all([
    getBalance(user.id),
    listOpenPositions(user.id),
    // 「最近结清」：take 比显示的多取一条，用来判「还有更多」—— 别把这个上限当全量历史
    listSettledPositions(user.id, SETTLED_PREVIEW + 1),
    getCachedQuotes(),
    // 标的列表是 MARKET_SYMBOLS 的单一真相源，这里不硬编码币名。
    // 每个标的都拉一次（默认周期）顺带把服务端那份 K 线缓存**预热** —— 切标的那一次
    // 于是只走本站一跳，不再打出站请求。
    Promise.all(MARKET_SYMBOLS.map(async (s) => [s, await getCandles(s, DEFAULT_INTERVAL)] as const)),
  ]);

  // 只有**首个标的**的整批 K 线进 payload（1000 根 × 6 项，实测 57,668 字节 ≈ 56KB，
  // 两个标的就是两倍）。
  // 另一个标的的走势线走 sparks（每人 72 个数），切过去时由客户端按需取。
  const first = MARKET_SYMBOLS[0];
  const candleSets: Record<string, CandleTuple[]> = {
    [candleKey(first, DEFAULT_INTERVAL)]: candleEntries.find(([s]) => s === first)?.[1] ?? [],
  };
  const sparks: Record<string, number[]> = Object.fromEntries(
    candleEntries.map(([s, list]) => [s, sparkCloses(list)])
  );

  // 展示用报价。**缺价就是 null** —— 页面显示「—」与「行情暂不可用」，
  // 绝不编一个价出来让人照着按下买入（同 /api/fish/trade/quote 的口径）。
  const quotes: QuoteView[] = MARKET_SYMBOLS.map((s) => {
    const q = quoteData.quotes.find((x) => x.symbol === s);
    return {
      symbol: s,
      display: displaySymbol(s),
      price: q?.price ?? null,
      changePercent: q?.changePercent ?? null,
      stale: q?.stale ?? false,
      // 首屏这一份与轮询拿到的那份要同形（见 TradePanel 的 QuoteView）。同样不渲染。
      source: q?.source ?? 'poll',
    };
  });

  const positionProps: PositionProp[] = positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    display: displaySymbol(p.symbol),
    stake: p.stake,
    entryPrice: p.entryPrice,
    leverage: p.leverage,
    liquidationPrice: p.liquidationPrice,
    openedAt: p.openedAt.toISOString(),
  }));

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-market" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        鱼干练手盘
      </h1>
      <p className="trade-subtitle">
        投入小鱼干买入 BTC / ETH，价格按真实行情走 —— 涨了赚鱼干，跌了亏鱼干。
        这是练习盘，练的是手感，亏掉的是鱼干不是钱。
        <br />
        <Link href="/fish/trade/stats" className="trade-stats-link">
          看看我的战绩
        </Link>
      </p>

      <TradePanel
        balance={balance}
        positions={positionProps}
        initialQuotes={quotes}
        sparks={sparks}
        candleSets={candleSets}
        feeRate={MARKET_FEE_RATE}
        minStake={MIN_STAKE_FISH}
        leverageOptions={[...LEVERAGE_OPTIONS]}
        lotteryLeverage={LOTTERY_LEVERAGE}
        leverageEnabled={isLiquidationRunning()}
      />

      <SettledList rows={settled.slice(0, SETTLED_PREVIEW)} hasMore={settled.length > SETTLED_PREVIEW} />
    </div>
  );
}

/** 「最近结清」显示几笔。取数时多取一条判「还有更多」（见上面 listSettledPositions 的调用）。 */
const SETTLED_PREVIEW = 10;

/** 结清时刻。库内是「UTC+8 墙上时间贴 Z」，读它必须走 getUTC*（db-time-guard 规则 5）。 */
function fmtSettledAt(d: Date | null): string {
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 带符号的鱼干数。0 不带正号 —— 与统计页的 signed 同一条判据。 */
const signedFish = (v: number) => `${v > 0 ? '+' : ''}${fmtFish(v)}`;

/**
 * 「最近结清」—— 平掉 / 爆掉的每一笔逐条列出。
 *
 * 【为什么它必须在页面上】结清之后那笔仓位从上方的「我的持仓」里消失，而流水页**没有它的
 * 条目**（实发为 0 时不写流水）。没有这一块，用户就只剩「仓位没了、账上什么都没留下」。
 *
 * 【口径与统计页一致】盈亏 = 实发 − 投入，来自 `market_positions`（见 listSettledPositions）。
 * ⚠️ **别改成从流水求和** —— 强平与实发为 0 的平仓都不写流水。
 */
function SettledList({ rows, hasMore }: { rows: SettledPositionView[]; hasMore: boolean }) {
  return (
    <section className="trade-card trade-settled">
      <div className="trade-settled__head">
        <h2 className="trade-settled__title">最近结清</h2>
        <Link href="/fish/trade/stats" className="trade-settled__more">
          完整战绩
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="trade-settled__empty">
          还没有结清的仓位。卖出或爆仓之后，这里会留下每一笔的记录。
        </p>
      ) : (
        <>
          <ul className="trade-settled__list">
            {rows.map((r) => (
              <li className="trade-settled__row" key={r.id} data-position-id={r.id}>
                <span className="trade-settled__name">{displaySymbol(r.symbol)}</span>
                {/* 倍数角标只在杠杆仓出现（1 倍是默认档，加个「1×」只是噪音 —— 同持仓行） */}
                {r.leverage > 1 && <span className="trade-settled__lev">{r.leverage}×</span>}
                <span
                  className={`trade-settled__tag${
                    r.status === 'liquidated' ? ' trade-settled__tag--liquidated' : ''
                  }`}
                >
                  {r.status === 'liquidated' ? '爆仓' : '卖出'}
                </span>
                <span className="trade-settled__meta">
                  投入 {fmtFish(r.stake)} · 结清价 {formatPrice(r.exitPrice)} · {fmtSettledAt(r.closedAt)}
                </span>
                <span
                  className={`trade-settled__pnl${
                    r.profit == null ? '' : r.profit >= 0 ? ' trade-settled__pnl--up' : ' trade-settled__pnl--down'
                  }`}
                >
                  {r.profit == null ? '—' : signedFish(r.profit)}
                </span>
              </li>
            ))}
          </ul>
          {hasMore && (
            <p className="trade-settled__note">
              只显示最近 {SETTLED_PREVIEW} 笔，更早的已结清记录不在本页。
            </p>
          )}
        </>
      )}
    </section>
  );
}
