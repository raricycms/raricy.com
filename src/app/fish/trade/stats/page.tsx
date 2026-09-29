import Link from 'next/link';
import { redirect, forbidden } from 'next/navigation';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getMarketStats } from '@/lib/market-stats-service';
import {
  estimateOpenPosition,
  sumProfitUnits,
  type OpenEstimate,
  type StatBucket,
} from '@/lib/market-stats';
import { listOpenPositions, displaySymbol, MARKET_FEE_RATE, type PositionView } from '@/lib/market-service';
import { getCachedQuotes } from '@/lib/market-price';
import { FISH_UNIT_SCALE, unitsToFish } from '@/lib/fish-units';
import { fmtFish } from '@/lib/fish-amount';
import { ymdhms } from '@/lib/format';
import { formatPrice } from '@/lib/market-chart';

// 鱼干练手盘 · 我的统计 —— 已结清仓位的总览 + 按标的 / 按杠杆拆解 + 持仓浮动盈亏快照。
//
// 【为什么不需要新表】`market_positions` **一行 = 一个批次**，结清时 `status` 就地改成
// closed / liquidated 且**绝不物理删除**，所以整套统计全部可由既有列推出来。指标口径
// 与「为什么盈亏不能从账本求和」写在 `src/lib/market-stats.ts` 与
// `market-stats-service.ts` 的文件头。
//
// 【档位 core+】与 /fish/trade 同档。**不判禁言**：这是只读页，禁言是「不能说话」，
// 不该顺带变成「不能看自己的账」（同 sell / quote / candles 那条不对称）。
//
// 【为什么不用 guard.ts 的 requireCoreUser】同 /fish/trade：那个门的 next 取自 referer，
// 直连 / 书签 / 无 referer 时会退化成 `next=/`。路径是已知的，写死进 next。
export const dynamic = 'force-dynamic';

/**
 * 存储单位 → 页面文本。**全页只此一处换算** —— 多写一次就是静默差 10000 倍
 * （存储单位是 0.0001 条，见 fish-units.ts）。
 */
const fish = (units: number) => fmtFish(unitsToFish(units));

/** 带符号的鱼干数。0 不带正号 —— 与 formatPct「0 既不是涨也不是跌」同一个判据。 */
const signed = (units: number) => `${units > 0 ? '+' : ''}${fish(units)}`;

/** 涨跌修饰类名（**完整类名**，要拼在 .tstats-pnl 后面）。0 不上色。 */
const tone = (units: number) => (units > 0 ? ' tstats-pnl--up' : units < 0 ? ' tstats-pnl--down' : '');

/** 胜率文本：0 笔时是「—」而不是 0%（`winRatePct` 为 null，见 market-stats.ts）。 */
const winRate = (pct: number | null) => (pct == null ? '—' : `${pct.toFixed(1)}%`);

/** 一行的浮动盈亏文本。**缺价就是「—」**，绝不编一个数出来。 */
function profitText(est: OpenEstimate | null): string {
  if (!est) return '—';
  return signed(est.profitUnits);
}

export default async function FishTradeStatsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish/trade/stats'));
  if (!isCoreUser(user)) forbidden();
  // 专注模式：统计页也在闸内（它是练手盘的一部分，不是另一件事）。文案同上：
  // forbidden() 收不了参数，而入口整段不渲染 —— 解释只剩 /settings 的专注模式说明。
  if (user.focusMode) forbidden();

  const [stats, positions, quoteData] = await Promise.all([
    getMarketStats(user.id),
    listOpenPositions(user.id),
    getCachedQuotes(),
  ]);

  const quoteOf = new Map(quoteData.quotes.map((q) => [q.symbol, q]));

  const openRows = positions.map((p: PositionView) => {
    const quote = quoteOf.get(p.symbol);
    const price = quote?.price ?? null;
    const estimate =
      price == null
        ? null
        : estimateOpenPosition({
            // ⚠️ `stake` 是鱼干、结算吃**存储单位**：换算只走 FISH_UNIT_SCALE，别写死 10000
            //    （同 TradePanel 的 estimate()）。杠杆取**这一笔**的，不是页面上某个选择器。
            stakeUnits: Math.round(p.stake * FISH_UNIT_SCALE),
            entryPrice: p.entryPrice,
            leverage: p.leverage,
            liquidationPrice: p.liquidationPrice,
            exitPrice: price,
            feeRate: MARKET_FEE_RATE,
          });
    return {
      id: p.id,
      symbol: p.symbol,
      display: displaySymbol(p.symbol),
      stake: p.stake,
      entryPrice: p.entryPrice,
      leverage: p.leverage,
      price,
      estimate,
      stale: quote?.stale ?? false,
    };
  });

  // 「有一行取不到价 → 合计是 null」：那时整块显示「—」，不显示一个看着像完整的数
  const totalProfitUnits = sumProfitUnits(openRows.map((r) => r.estimate));
  const anyStale = openRows.some((r) => r.stale);
  // ⚠️ 这是**轮询那一次**的时刻，不是那个价的时刻：行情流活着时 price 来自 WS 帧，
  //    而 quotedAt 仍停在最近一次 REST 刷新上（最多差一个轮询周期）。文案如实写。
  const quoteAt = quoteData.quotes[0]?.quotedAt ?? null;
  const hasSettled = stats.count + stats.incomplete > 0;

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-market" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        练手盘统计
      </h1>
      {/* ★ 副标题里**不写币名**：CLAUDE.md 的「加一个标的要改四处」已经列了三个页面的
          副标题，这里再写一遍就成了第五处 —— 而那四处是靠人记着的，不是靠编译。 */}
      <p className="tstats-subtitle">
        把已结清的战绩按标的与杠杆拆开看 —— 平仓与爆仓都算，盈亏已扣平仓手续费。
      </p>

      <div className="tstats-kpis">
        <div className="tstats-kpi" data-kpi="pnl">
          <div className="tstats-kpi__label">累计已实现盈亏</div>
          <div className={`tstats-kpi__value${tone(stats.realizedUnits)}`}>
            {signed(stats.realizedUnits)}
          </div>
          <div className="tstats-kpi__unit">小鱼干</div>
        </div>
        <div className="tstats-kpi" data-kpi="winrate">
          <div className="tstats-kpi__label">胜率</div>
          <div className="tstats-kpi__value">{winRate(stats.winRatePct)}</div>
          <div className="tstats-kpi__unit">
            {stats.wins} 胜 / {stats.losses} 负
            {stats.flats > 0 && ` / ${stats.flats} 平`}
          </div>
        </div>
        <div className="tstats-kpi" data-kpi="count">
          <div className="tstats-kpi__label">已结清</div>
          <div className="tstats-kpi__value">{stats.count}</div>
          <div className="tstats-kpi__unit">笔</div>
        </div>
        <div className="tstats-kpi" data-kpi="liquidated">
          <div className="tstats-kpi__label">爆仓</div>
          <div className="tstats-kpi__value">{stats.liquidated}</div>
          <div className="tstats-kpi__unit">次</div>
        </div>
        <div className="tstats-kpi" data-kpi="stake">
          <div className="tstats-kpi__label">累计投入</div>
          <div className="tstats-kpi__value">{fish(stats.stakeUnits)}</div>
          <div className="tstats-kpi__unit">小鱼干</div>
        </div>
        <div className="tstats-kpi" data-kpi="payout">
          <div className="tstats-kpi__label">累计实发</div>
          <div className="tstats-kpi__value">{fish(stats.payoutUnits)}</div>
          <div className="tstats-kpi__unit">小鱼干</div>
        </div>
      </div>

      {hasSettled ? (
        <>
          <BreakdownTable
            title="按标的"
            head="标的"
            buckets={stats.bySymbol}
            labelOf={displaySymbol}
          />
          <BreakdownTable
            title="按杠杆"
            head="杠杆"
            buckets={stats.byLeverage}
            labelOf={(key) => `${key}×`}
          />
        </>
      ) : (
        <p className="tstats-empty">
          还没有已结清的战绩。去
          <Link href="/fish/trade" className="tstats-back">练手盘</Link>
          买第一笔，平掉之后这里就有数了。
        </p>
      )}

      <section className="card tstats-card">
        <div className="tstats-card__head">
          <h2 className="tstats-card__title">当前持仓</h2>
          {/* 「行情刷新于 …」只在**真有持仓**时才有意义 —— 没有持仓时那一行说的是
              一个与本题无关的时刻，而上面那几个 KPI 根本不看行情。 */}
          {quoteAt && openRows.length > 0 && (
            <span className="tstats-note">行情刷新于 {ymdhms(quoteAt)}</span>
          )}
        </div>
        {openRows.length === 0 ? (
          <p className="tstats-empty">当前没有持仓。</p>
        ) : (
          <>
            <div className="table-responsive">
              <table className="table tstats-table">
                <thead>
                  <tr>
                    <th>标的</th>
                    <th className="tstats-table__num">杠杆</th>
                    <th className="tstats-table__num">投入</th>
                    <th className="tstats-table__num">开仓价</th>
                    <th className="tstats-table__num">现价</th>
                    <th className="tstats-table__num">浮动盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {openRows.map((r) => (
                    <tr key={r.id} data-position-id={r.id}>
                      <td>{r.display}</td>
                      <td className="tstats-table__num">{r.leverage}×</td>
                      <td className="tstats-table__num">{fmtFish(r.stake)}</td>
                      <td className="tstats-table__num">{formatPrice(r.entryPrice)}</td>
                      <td className="tstats-table__num">
                        {r.price == null ? '—' : formatPrice(r.price)}
                      </td>
                      <td className="tstats-table__num">
                        {/* 颜色挂在里层 span 上，别挂在 <td> 上：`.table td`（0-1-1）压得住
                            单类选择器，见 _fish-trade-stats.scss 那条注释 */}
                        <span className={`tstats-pnl${r.estimate ? tone(r.estimate.profitUnits) : ''}`}>
                          {profitText(r.estimate)}
                        </span>
                        {/* 跌穿爆仓价：平仓实得 0，下一轮扫描就会被强平。不说这句的话，
                            「0.0000」看起来像个 bug（同 /fish/trade 持仓行那条） */}
                        {r.estimate?.belowLiquidation && (
                          <span className="tstats-liq">已跌破爆仓价</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tstats-total">
              浮动盈亏合计{' '}
              <strong className={`tstats-pnl${totalProfitUnits == null ? '' : tone(totalProfitUnits)}`}>
                {totalProfitUnits == null ? '—' : signed(totalProfitUnits)}
              </strong>
              {totalProfitUnits == null && <span className="tstats-liq">有行情取不到，合计先不算</span>}
            </p>
            {anyStale && <p className="tstats-note">行情更新有延迟，数据可能不是最新的。</p>}
          </>
        )}
      </section>

      {stats.incomplete > 0 && (
        <p className="tstats-note">
          有 {stats.incomplete} 行数据不完整，未计入统计。
        </p>
      )}

      <p className="tstats-back-line">
        <Link href="/fish/trade" className="tstats-back">← 回到练手盘</Link>
      </p>
    </div>
  );
}

/** 一张拆解表。按标的与按杠杆只差标题、表头与标签渲染，别抄两份。 */
function BreakdownTable({
  title,
  head,
  buckets,
  labelOf,
}: {
  title: string;
  head: string;
  buckets: StatBucket[];
  labelOf(key: string): string;
}) {
  return (
    <section className="card tstats-card">
      <h2 className="tstats-card__title">{title}</h2>
      <div className="table-responsive">
        <table className="table tstats-table">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="tstats-table__num">笔数</th>
              <th className="tstats-table__num">胜率</th>
              <th className="tstats-table__num">累计盈亏</th>
              <th className="tstats-table__num">爆仓</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.key}>
                <td>{labelOf(b.key)}</td>
                <td className="tstats-table__num">{b.count}</td>
                <td className="tstats-table__num">{winRate(b.winRatePct)}</td>
                <td className="tstats-table__num">
                  <span className={`tstats-pnl${tone(b.realizedUnits)}`}>{signed(b.realizedUnits)}</span>
                </td>
                <td className="tstats-table__num">{b.liquidated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
