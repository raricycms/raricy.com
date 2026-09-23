import { redirect, forbidden } from 'next/navigation';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import {
  listOpenPositions,
  displaySymbol,
  MARKET_FEE_RATE,
  MIN_STAKE_FISH,
} from '@/lib/market-service';
import { getCachedQuotes, getCandles, MARKET_SYMBOLS } from '@/lib/market-price';
import { sparkCloses } from '@/lib/market-candles';
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

  const [balance, positions, quoteData, candleEntries] = await Promise.all([
    getBalance(user.id),
    listOpenPositions(user.id),
    getCachedQuotes(),
    // 标的列表是 MARKET_SYMBOLS 的单一真相源，这里不硬编码币名。
    // 每个标的都拉一次（默认周期）顺带把服务端那份 K 线缓存**预热**，切标的一次往返就够。
    // 走势线只取末尾 72 根的收盘价（sparkCloses）—— 首屏不把 1000 根原始 K 线塞进 payload。
    Promise.all(
      MARKET_SYMBOLS.map(async (s) => [s as string, sparkCloses(await getCandles(s))] as const)
    ),
  ]);
  const candles: Record<string, number[]> = Object.fromEntries(candleEntries);

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
      </p>

      <TradePanel
        balance={balance}
        positions={positionProps}
        initialQuotes={quotes}
        candles={candles}
        feeRate={MARKET_FEE_RATE}
        minStake={MIN_STAKE_FISH}
      />
    </div>
  );
}
