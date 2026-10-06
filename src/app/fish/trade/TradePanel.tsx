'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AMOUNT_ERROR, fmtFish, parseFishAmount, roundFish } from '@/lib/fish-amount';
import { FISH_UNIT_SCALE, unitsToFish } from '@/lib/fish-units';
import { settleClose, formatFeeRate, liquidationPrice } from '@/lib/market-math';
// 杠杆与方向的词表（零依赖 —— 就是从 market-service 搬出来给客户端用的，见那个文件头）。
// ⚠️ `parseLeverage` 必须从**这里** import，别从 market-service —— 那边拖着 prisma 进不了
// 客户端包（它只是把它重导出了一份，方便服务端调用方）。
import {
  DIRECTIONS,
  DIRECTION_LABELS,
  DIRECTION_BADGES,
  dirSign,
  parseLeverage,
  needsLiquidator,
  LEVERAGE_PRESETS,
  MIN_LEVERAGE,
  MAX_LEVERAGE,
  HIGH_RISK_LEVERAGE,
  type Direction,
} from '@/lib/market-leverage';
import { DEFAULT_INTERVAL, type CandleTuple, type MarketInterval } from '@/lib/market-candles';
// 价格与涨跌幅的格式化只有一份（market-chart.ts），持仓行、确认弹窗、图例共用它 ——
// 这里沿用文件里原来的短名，免得改十几处调用点
import { formatPrice as fmtPrice, formatPct as fmtPct } from '@/lib/market-chart';
import TradeChartPanel from './TradeChartPanel';
import TradeWatchlist, { type WatchRow } from './TradeWatchlist';
import { useCandles } from './useCandles';
// 只取类型：`import type` 在编译期被擦掉，不会把 market-price（它带着服务端代码）
// 拖进客户端包。**别改成值导入**，也别在本地重抄一份同样的联合类型（两份必然 drift）。
import type { QuoteSource } from '@/lib/market-price';

// 练手盘面板：自选（标的选择）+ 图表 + 买入 + 持仓 + 平仓。**它是这一页状态的唯一主人**
//（当前标的 / 周期 / 金额 / 两个弹窗 / 幂等键），三个子组件都是受控的。
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
  /** `long`｜`short` —— 渲染成「多 / 空」那枚角标，并决定盈亏着色与爆仓提示的方向词。 */
  direction: Direction;
  stake: number;
  entryPrice: number;
  /** 杠杆倍数（1 = 无杠杆）。渲染成「10×」那一枚角标。 */
  leverage: number;
  /**
   * 爆仓价。**直接用它，别拿 entryPrice × (1 ∓ 1/杠杆) 自己算一遍** ——
   * 这是开仓那一刻写进库的数，与强平引擎的判据是同一个（见 market-math 的注释）。
   * ⚠️ **只有 1 倍多头**才是 0（那条线不存在、显示成「—」）；1× 空头是 2 × 开仓价。
   * 所以「要不要显示爆仓价」的判据是 `liquidationPrice > 0`，**不是** `leverage > 1`。
   */
  liquidationPrice: number;
  openedAt: string;
}

/** 开仓时刻。库内是 UTC+8 墙上时间，读它必须用 getUTC*（db-time-guard 规则 5）。 */
function fmtOpenedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export default function TradePanel({
  balance: initialBalance,
  positions,
  initialQuotes,
  sparks,
  candleSets,
  feeRate,
  minStake,
  leverageEnabled,
}: {
  balance: number;
  positions: PositionProp[];
  initialQuotes: QuoteView[];
  /** 标的 → 最近 72 根收盘价（自选列表那根小走势线）。服务端从同一批 K 线里切出来 */
  sparks: Record<string, number[]>;
  /** 服务端首屏给的 K 线，键是 `${symbol}:${interval}`（market-candles.ts 的 candleKey） */
  candleSets: Record<string, CandleTuple[]>;
  feeRate: number;
  minStake: number;
  /**
   * 强平引擎是否在跑。false 时**只留「1 倍做多」**并给一句说明 —— 与「行情拉不到就禁掉
   * 买入」同一档：服务暂时不在，就把按钮关掉，而不是让用户填完一整屏再吃 503。
   * ⚠️ 关掉的是**会爆仓的那一整类**（杠杆仓 + **全部空头仓，含 1×**），不是「杠杆」这一个
   * 维度 —— 1× 空头同样要引擎（它在 2 × 开仓价归零）。判据是 needsLiquidator。
   * ⚠️ 这不是「入口跟着藏」（那条红线针对的是**档位不够**）：1 倍多头照旧能买，
   * 入口一个都没少，少的是一个此刻兑现不了的商品。
   */
  leverageEnabled: boolean;
}) {
  const router = useRouter();
  const [balance, setBalance] = useState(initialBalance);
  const [quotes, setQuotes] = useState<QuoteView[]>(initialQuotes);
  const [symbol, setSymbol] = useState<string>(initialQuotes[0]?.symbol ?? 'BTCUSDT');
  // ⚠️ setter **不许叫 setInterval** —— 那会把全局的 setInterval 遮掉，下面那条
  // 1 秒轮询会当场报「Expected 1 arguments, but got 2」，而错的是名字不是轮询。
  const [interval, applyInterval] = useState<MarketInterval>(DEFAULT_INTERVAL);
  const [amount, setAmount] = useState('');
  // 方向**不进幂等键**：同一笔重试换一个方向不会买成两笔，服务端按 openKey 回读既有
  // 那一笔的真实方向（见 buy/route.ts 头部）。所以这里改它不需要换键。
  const [direction, setDirection] = useState<Direction>('long');
  // 杠杆**不进幂等键**，同上。`leverage` 是**最后一个合法值**（渲染与提交都用它稳定，
  // 输入框的中间态不该把页面抖成 NaN）；`leverageInput` 是输入框里的原始文本。
  const [leverage, setLeverage] = useState(1);
  const [leverageInput, setLeverageInput] = useState('1');
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

  // ── K 线（图表用）────────────────────────────────────────────────────────
  // 首屏那批由服务端直接给（SSR 出来的图就是完整的，不闪）；切标的/切周期按需取。
  // 取数时机只有三条，见 useCandles 的文件头 —— **这里没有定时器**。
  const { get: getCandleSet, ensure: ensureCandles, refresh: refreshCandles } = useCandles(candleSets);
  useEffect(() => {
    ensureCandles(symbol, interval);
  }, [ensureCandles, symbol, interval]);
  const candleEntry = getCandleSet(symbol, interval);
  // 当前标的的展示价。并进图里最后一根用（**只是展示**：成交价永远由服务端现取）
  const livePrice = current?.price ?? null;

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
  // 杠杆输入框是文本框，所以「空着」是一个真实中间态。⚠️ parseLeverage('') 返回 1
  //（那是给「调用方根本没传这个字段」的向后兼容），但**空输入框 ≠ 1 倍** ——
  // 不特判的话，用户删掉数字、页面显示「1×」并真的按 1 倍下单，而他以为还没填完。
  const leverageTrimmed = leverageInput.trim();
  const leverageOk = leverageTrimmed !== '' && parseLeverage(leverageTrimmed) !== null;
  const leverageError = leverageOk ? '' : `杠杆需是 ${MIN_LEVERAGE}–${MAX_LEVERAGE} 之间的整数`;
  // 这一笔要不要强平引擎（**会爆仓 ⟺ 杠杆仓 ‖ 空头仓**，含 1× 空头）。引擎没在跑时
  // 它就是一个「此刻兑现不了的商品」—— 与「行情拉不到就禁掉买入」同一档，不放进下单。
  const engineBlocked = needsLiquidator(leverage, direction) && !leverageEnabled;
  const canBuy = amountOk && leverageOk && current != null && !engineBlocked;
  // 选中/输入到警告带以上（≥ HIGH_RISK_LEVERAGE）时常驻一条危险说明。它**只是文案**：
  // 服务端照收 1–100 的每个整数，不因跨过 25 就变档。
  const highRisk = leverageOk && leverage >= HIGH_RISK_LEVERAGE;
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
    // ⚠️ `leverage` 与 `direction` 都从**这笔持仓**来，不是从上面那两个选择器来 ——
    // 选择器只管下一笔。拿它们去估已有持仓 = 把 1 倍的多头按 10 倍的空头显示，
    // 而且屏幕上那个数看起来完全合理。
    const s = settleClose({
      stakeUnits,
      entryPrice: p.entryPrice,
      exitPrice: px,
      feeRate,
      leverage: p.leverage,
      direction: p.direction,
    });
    return {
      px,
      /** 实发（到手）。穿过爆仓价后它是 0（同一个 max(0,…)，见 market-math.ts） */
      payout: unitsToFish(s.payoutUnits),
      /** 毛额 = 权益（**不是**持仓市值也不是名义本金）。「毛额 − 手续费 = 到手」靠它 */
      gross: unitsToFish(s.grossUnits),
      profit: unitsToFish(s.payoutUnits - stakeUnits),
      /** 手续费 + floor 零头 —— 弹窗里「毛额 − 手续费 = 到手」要对得上（见 market-math.ts） */
      fee: unitsToFish(s.feeUnits),
      /**
       * 较开仓价的涨跌幅（不含手续费）。行情卡上那个是 24 小时涨跌，两者不是一回事。
       * ⚠️ 它是**行情**的数，**不含方向** —— 空头这一栏是负的恰恰在赚钱。
       */
      changePercent: s.changePercent,
      /** 盈亏率（含手续费与 floor）。10 倍仓它约等于涨跌幅 × 10（空头取反） */
      profitPercent: s.profitPercent,
      /** 名义本金（投入 × 杠杆）—— 只在杠杆仓的弹窗里显示，1 倍时与投入同值 */
      notional: roundFish(p.stake * p.leverage),
      /**
       * 这一行的涨跌**该按赚钱还是亏钱着色** —— 行情涨跌幅乘上方向。
       * 独立的字段而不是让调用点自己乘：漏乘的地方不会报错，只会红绿反。
       */
      favorable: s.changePercent * dirSign(p.direction) >= 0,
      /**
       * 现价已经穿过这笔的爆仓价 —— 平仓实得 0，且下一轮扫描就会被强平。
       * ⚠️ 判据是 `liquidationPrice > 0`（**这条线存在**），不是 `leverage > 1`：
       * 1× 空头有一条真实爆仓价（2 × 开仓价），而 1× 多头没有。写错的话 1× 空头
       * 永远不显示「已涨破爆仓价」，用户看着一个浮亏以为还能等。
       */
      liquidated:
        p.liquidationPrice > 0 &&
        (p.direction === 'short' ? px >= p.liquidationPrice : px <= p.liquidationPrice),
    };
  }

  /** 选一个档（chip 或输入框都走它）：数值与输入框文本必须一起动，否则两者会分家。 */
  function chooseLeverage(lv: number) {
    setLeverage(lv);
    setLeverageInput(String(lv));
  }

  /**
   * 输入框的手输路径。**非法值只记文本、不动 `leverage`** —— 于是渲染与提交用的
   * 仍是最后一个合法值，而 `leverageOk` 会把买入按钮关掉、并把错因写在下面。
   * 别在这里「就近取整」（同 parseLeverage 头部那条纪律）。
   */
  function onLeverageInput(text: string) {
    setLeverageInput(text);
    const v = parseLeverage(text.trim());
    if (v !== null && text.trim() !== '') setLeverage(v);
  }

  function openBuy() {
    idemRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `mrk-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
        : `mrk-${Math.random().toString(36).slice(2, 22)}`;
    setBuyOpen(true);
  }

  async function submitBuy() {
    if (!canBuy || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fish/trade/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          symbol,
          amount: parsed,
          // 杠杆与方向原样提交。**前端不传价**这条没变（见文件头 ①）—— 它们不是价，
          // 是这一笔的形状，而区间/取值与判定全在服务端。
          leverage,
          direction,
          idempotency_key: idemRef.current,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        // 成交回报在接口文案后面**追加真实成交价与真实爆仓价**（服务端下单那一刻现取
        // 的那一对）。确认弹窗里那个「参考爆仓价」是按展示价估的 —— 高倍下两者的差
        // 能占掉整段爆仓距离的一大截（1% 的距离下，展示价差 0.25% 就是 1/4 条命）。
        // 这一句是用户唯一能**当场**看到「实际拿到的是什么」的地方：下面持仓行上
        // 也写着同一对数，但那一行要等 router.refresh() 回来才出现。
        // ⚠️ **追加，不是替换** —— 接口那条 message 是权威说法（bot 也收到它），
        // 而且 tests/e2e 的 buyViaUI 正拿它开头的「已买入」当「这一笔真的回来了」的
        // 信号。改掉那几个字要同步改那个 helper，否则五条用例会红在等待超时上。
        const filled = data.position as
          | { entry_price?: unknown; liquidation_price?: unknown }
          | undefined;
        const fillMsg =
          filled && typeof filled.entry_price === 'number'
            ? `成交价 ${fmtPrice(filled.entry_price)} USDT` +
              (typeof filled.liquidation_price === 'number' && filled.liquidation_price > 0
                ? `，爆仓价 ${fmtPrice(filled.liquidation_price)}`
                : '')
            : null;
        window.showToast?.(
          fillMsg ? `${data.message ?? '买入成功'}，${fillMsg}` : (data.message ?? '买入成功'),
          'success'
        );
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

  const quoteDown = quotes.length === 0 || quotes.every((q) => q.price == null);
  // 弹窗开着 / 提交中时冻住一切会改变「这一笔是什么」的输入（标的、金额、杠杆）。
  // 三个地方共用同一个判据 —— 分成三份写法必然有一天漏掉一处，而漏掉的那一处
  // 会让弹窗上的数字与实际提交的东西不一致。
  const locked = busy || buyOpen || sellTarget != null;
  // 弹窗里的那一整套估算算一次就好（下面要用到六七个数，逐个 estimate() 是六七次重算，
  // 且两处调用之间行情刷新会让同一个数在弹窗里显示成两个值）
  const sellEst = sellTarget ? estimate(sellTarget) : null;
  // 买入弹窗里的**参考**爆仓价：用**展示价**当开仓价估的（真实爆仓价要等成交价出来
  // 才算得出，见文件头 ①）。所以它必须标成「参考」，不能当成承诺。
  const refLiqPrice =
    current?.price != null ? liquidationPrice(current.price, leverage, direction) : null;
  // 爆仓价**离现价有多远**（%）。「距现价 −10.0%」读得出来，「72,000.00 USDT」读不出来
  // —— 后者要用户自己心算 (80000−72000)/80000，而那正是他决定要不要按买入时唯一该看的数。
  // ⚠️ **带符号**：多头是负（价要跌到那儿才爆）、空头是正（价要涨到那儿才爆）。
  // 别写死一个负号 —— 那会让空头的爆仓提示说成「跌 10% 就爆」，方向正好反了。
  // ⚠️ 必须由**上面那两个数**推，别写成 100 / leverage：公式等价，但展示价一跳动
  // 屏幕上那两个数就会对不上（写了公式的那份不会跟着动）——**静默地**。
  const refLiqDistancePct =
    refLiqPrice != null && current?.price != null && current.price > 0
      ? ((refLiqPrice - current.price) / current.price) * 100
      : null;
  // 杠杆仓才显示「杠杆 / 名义本金」那两行 —— 1 倍说「杠杆 1×」是废话，
  // 而「名义本金 = 投入」这种恒等式摆两遍会让真正要紧的那几行变淡。
  const leveraged = leverage > 1;
  // 「这一笔有没有一条真的爆仓线」：**1 倍多头没有**（爆仓价是 0），其余都有（含 1× 空头）。
  // ⚠️ 判据是 `refLiqPrice > 0`，**不是** `leverage > 1` —— 后者会把 1× 空头那条真实的
  // 线藏起来，用户看不到自己会怎么爆。
  const hasLiqLine = refLiqPrice != null && refLiqPrice > 0;

  // 自选列表的行 = 展示报价 + 走势线（走势线由服务端随首屏给，切标的不另取）。
  const watchRows: WatchRow[] = quotes.map((q) => ({
    symbol: q.symbol,
    display: q.display,
    price: q.price,
    changePercent: q.changePercent,
    stale: q.stale,
    closes: sparks[q.symbol] ?? [],
  }));

  return (
    <>
      {/* 三栏：自选 | 图表 | 下单 + 持仓。窄屏的折叠全部由 CSS 管（见 _fish-trade.scss），
          这里只有一份 DOM —— 两套布局的代价是两份状态与两处会 drift 的类名。 */}
      <div className="trade-layout">
        <TradeWatchlist
          rows={watchRows}
          symbol={symbol}
          // 确认弹窗开着时不让切标的：那两屏的文案是按当前标的算好的（同 locked）
          disabled={locked}
          onSelect={setSymbol}
        />

        <div className="trade-card trade-card--chart">
          <TradeChartPanel
            symbol={symbol}
            display={current?.display ?? symbol}
            interval={interval}
            candles={candleEntry?.candles ?? []}
            status={candleEntry?.status ?? 'loading'}
            livePrice={livePrice}
            onIntervalChange={applyInterval}
            onRetry={() => refreshCandles(symbol, interval)}
            onRolledOver={() => refreshCandles(symbol, interval)}
          />
        </div>

        <div className="trade-side">
          <div className="trade-card">
            <div className="trade-card__head">
              <span className="trade-card__balance-label">我的余额</span>
              <span className="trade-card__balance-number">{fmtFish(balance)}</span>
              <span className="trade-card__balance-unit">小鱼干</span>
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

            {/* 方向。**两个值、固定两枚 → 切页档**（同杠杆那排的判据，
                docs/frontend-styles.md §6.8）。它是「下一笔」的形状，与已有持仓无关 ——
                所以持仓行自己带方向角标，不靠这个开关解释。 */}
            <div className="trade-field">
              <span className="trade-field__label" id="trade-direction-label">
                方向
              </span>
              <div
                className="trade-direction"
                role="group"
                aria-labelledby="trade-direction-label"
              >
                {DIRECTIONS.map((d) => {
                  // **空头任何档都要强平引擎（含 1×）** —— 引擎没在跑时它是一个兑现不了
                  // 的商品，与上面那些 >1 的档同一条判据（needsLiquidator）。
                  const unavailable = d === 'short' && !leverageEnabled;
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`trade-direction__btn${d === direction ? ' is-active' : ''}`}
                      aria-pressed={d === direction}
                      disabled={locked || unavailable}
                      title={unavailable ? '做空暂不可用' : undefined}
                      onClick={() => setDirection(d)}
                    >
                      {DIRECTION_LABELS[d]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 杠杆。**快捷档一排 + 一个自由输入框**（2026-10 从固定白名单改成 1–100
                的整数）。快捷档走 .trade-leverage__btn（btn-tab），**三档之外不自造第四档**
                （docs/frontend-styles.md）；输入框是一行数字 → 胶囊。
                ⚠️ 它是「下一笔」的参数，与已有持仓的倍数无关 —— 所以列表里每一行
                自己带一枚倍数角标，而不是靠这个选择器解释。 */}
            <div className="trade-field">
              <span className="trade-field__label" id="trade-leverage-label">
                杠杆
              </span>
              <div
                className="trade-leverage"
                role="group"
                aria-labelledby="trade-leverage-label"
              >
                {LEVERAGE_PRESETS.map((lv) => {
                  // 引擎没在跑时只留 1 倍：其余档位是此刻兑现不了的商品（服务端也会拒）。
                  const unavailable = lv > 1 && !leverageEnabled;
                  return (
                    <button
                      key={lv}
                      type="button"
                      className={`trade-leverage__btn${lv === leverage ? ' is-active' : ''}`}
                      aria-pressed={lv === leverage}
                      disabled={locked || unavailable}
                      title={unavailable ? '杠杆暂不可用' : undefined}
                      onClick={() => chooseLeverage(lv)}
                    >
                      {lv}×
                    </button>
                  );
                })}
              </div>
              <div className="trade-leverage__custom">
                <input
                  className="trade-leverage__input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label={`自定义杠杆倍数（${MIN_LEVERAGE}–${MAX_LEVERAGE} 的整数）`}
                  value={leverageInput}
                  onChange={(e) => onLeverageInput(e.target.value)}
                  disabled={locked}
                />
                <span className="trade-leverage__unit">
                  倍（{MIN_LEVERAGE}–{MAX_LEVERAGE} 的整数）
                </span>
              </div>
              {leverageError && (
                <p className="trade-field__hint trade-field__hint--error">{leverageError}</p>
              )}
              {/* 危险带警告**常驻在选择器下方**，不是弹一次就完的 modal：每次都要点掉的东西
                  会立刻脱敏（同「对 1 倍反复说爆仓风险」那条）。阈值与实测曲线见
                  market-leverage 的 HIGH_RISK_LEVERAGE —— 它**只是文案**，服务端照收
                  1–100 的每一个整数，不因跨过它变档。 */}
              {highRisk && (
                <p className="trade-leverage__warn">
                  ⚠️ {leverage}× 的爆仓线离现价只有约 {(100 / leverage).toFixed(1)}% —— 一根
                  普通的日内波动就能碰到，几小时就可能见分晓。手续费按名义本金收，这一档
                  平仓一次约合投入的{' '}
                  <strong>{formatFeeRate(feeRate * leverage)}</strong>（1 倍仓是{' '}
                  {formatFeeRate(feeRate)}）。
                </p>
              )}
              {/* 提示**不要求已填金额**：距离是这一笔的属性（只由倍数、方向与现价决定，
                  与投多少无关），所以选中它的那一刻就该看见 —— 等用户填完金额才告诉他
                  那条线只有 1% 远，等于把最要紧的一句放在了决定之后。 */}
              {(leveraged || hasLiqLine) && (
                <p className="trade-field__hint">
                  {leveraged && amountOk && (
                    <>
                      名义本金 <strong>{fmtFish(roundFish(parsed * leverage))}</strong> 小鱼干
                      {hasLiqLine && '，'}
                    </>
                  )}
                  {hasLiqLine && refLiqPrice != null && (
                    <>
                      参考爆仓价{' '}
                      <strong className="trade-field__hint--danger">
                        {fmtPrice(refLiqPrice)}
                      </strong>{' '}
                      USDT
                      {refLiqDistancePct != null && (
                        <>
                          （距现价 {refLiqDistancePct >= 0 ? '+' : ''}
                          {refLiqDistancePct.toFixed(1)}%）
                        </>
                      )}
                    </>
                  )}
                </p>
              )}
              {!leverageEnabled && (
                <p className="trade-field__hint">
                  强平服务未运行 —— 此刻只能用「1 倍做多」。
                </p>
              )}
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
              {direction === 'short' ? '做空' : '买入'}
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
                        {/* 倍数**逐行显示**：上面那个选择器只管下一笔，拿它解释已有持仓
                            会把 1 倍的仓位读成 10 倍。1 倍不显示（默认档，加个「1×」
                            只是噪音，与流水描述同款处理）。 */}
                        {/* 方向角标：**恒显示**。1× 空头既没有倍数角标（倍数是 1），
                            要是再省掉方向，它的风险就被完全藏起来了 —— 一行看着像
                            一笔无关紧要的 1 倍多单，实则刚被腰斩。 */}
                        <span className={`trade-position__dir trade-position__dir--${p.direction}`}>
                          {DIRECTION_BADGES[p.direction]}
                        </span>
                        {p.leverage > 1 && (
                          <span className="trade-position__lev">{p.leverage}×</span>
                        )}
                        <span className="trade-position__stake">{fmtFish(p.stake)} 鱼干</span>
                        <span className="trade-position__entry">
                          开仓 {fmtPrice(p.entryPrice)}
                          {/* 爆仓价只要**那条线存在**就显示 —— 判据是 `> 0`，不是 `杠杆 > 1`：
                              1× 多头是 0（写「爆仓 0 USDT」是在说一件不可能发生的事），
                              而 1× 空头有一条真实爆仓价（2 × 开仓价），漏显示它等于
                              把「这笔会爆」这件事藏起来。 */}
                          {p.liquidationPrice > 0 && <> · 爆仓 {fmtPrice(p.liquidationPrice)}</>}
                          <span className="trade-position__time"> · {fmtOpenedAt(p.openedAt)}</span>
                        </span>
                        {/* 「较开仓」而不是光写一个百分数：行情卡上那个百分数是**24 小时**涨跌，
                            两个数会在同一屏里各说各话。取不到价就整行不渲染（不是显示 0.00%）。
                            ⚠️ 着色用 `est.favorable`（行情涨跌 × 方向），**不是**拿
                            `changePercent >= 0` —— 空头这一栏是负的恰恰在赚钱，直接判色
                            会让空头的红绿全反（不报错）。数值本身照旧是**行情**涨跌幅。 */}
                        {est && (
                          <span className="trade-position__now">
                            现价 {fmtPrice(est.px)}
                            <span
                              className={`trade-position__change trade-position__change--${
                                est.favorable ? 'up' : 'down'
                              }`}
                            >
                              较开仓 {fmtPct(est.changePercent)}
                            </span>
                            {/* 已经穿过爆仓价：平仓实得 0，且下一轮扫描就会被强平。
                                不说这句的话，这一行的「可卖 0 鱼干」看起来像个 bug。
                                方向词要跟着方向：多头「跌破」、空头「涨破」。 */}
                            {est.liquidated && (
                              <span className="trade-position__liq">
                                {p.direction === 'short' ? '已涨破爆仓价' : '已跌破爆仓价'}
                              </span>
                            )}
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
                        {p.direction === 'short' ? '平空' : '卖出'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
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
                <h3 className="modal-title">{direction === 'short' ? '确认做空' : '确认买入'}</h3>
              </div>
              <div className="modal-body">
                <dl className="trade-confirm__rows">
                  <div className="trade-confirm__row">
                    <dt>标的</dt>
                    <dd>{current.display}</dd>
                  </div>
                  {/* 方向**恒显示**（哪怕 1× 做多）—— 这一屏是用户最后一次看清
                      「我到底在下哪一边」，而下完单它就只体现在持仓行那枚角标上了。 */}
                  <div className="trade-confirm__row">
                    <dt>方向</dt>
                    <dd>
                      <span className={`trade-confirm__dir trade-confirm__dir--${direction}`}>
                        {DIRECTION_LABELS[direction]}
                      </span>
                    </dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>投入</dt>
                    <dd>{fmtFish(parsed)} 小鱼干</dd>
                  </div>
                  {/* 「杠杆 / 名义本金」两行只在 leverage > 1 时出现：1 倍仓说「杠杆 1×」
                      是废话，而「名义本金 = 投入」这种恒等式摆两遍会让真正要紧的那几行变淡。 */}
                  {leveraged && (
                    <>
                      <div className="trade-confirm__row">
                        <dt>杠杆</dt>
                        <dd>
                          <span className="trade-confirm__lev">{leverage}×</span>
                        </dd>
                      </div>
                      <div className="trade-confirm__row">
                        <dt>名义本金</dt>
                        <dd>{fmtFish(roundFish(parsed * leverage))} 小鱼干</dd>
                      </div>
                    </>
                  )}
                  {/* 参考爆仓价只要**那条线存在**就显示（判据 `> 0`）—— 1× 空头也有一条
                      （2 × 开仓价），漏显示它等于把「这笔会爆」藏起来。 */}
                  {hasLiqLine && refLiqPrice != null && (
                    <div className="trade-confirm__row">
                      <dt>参考爆仓价</dt>
                      <dd>
                        <span className="trade-confirm__liq">
                          {fmtPrice(refLiqPrice)} USDT
                        </span>
                        {refLiqDistancePct != null && (
                          <>
                            {' '}
                            <span className="trade-confirm__delta">
                              {refLiqDistancePct >= 0 ? '+' : ''}
                              {refLiqDistancePct.toFixed(1)}%
                            </span>
                          </>
                        )}
                      </dd>
                    </div>
                  )}
                  <div className="trade-confirm__row">
                    <dt>参考价</dt>
                    <dd>{current.price == null ? '—' : fmtPrice(current.price)} USDT</dd>
                  </div>
                  <div className="trade-confirm__row trade-confirm__row--total">
                    <dt>买入后余额</dt>
                    <dd>{fmtFish(afterBalance)} 小鱼干</dd>
                  </div>
                </dl>
                {/* 免责声明**按「这一笔有没有爆仓线」分岔**（= hasLiqLine），不是按
                    「杠杆 > 1」：1× 做空同样会爆（价格翻倍），它必须拿到下面那段危险声明。
                    **有爆仓线的那一档要把两件反直觉的事说清楚** ——
                    ① 亏损也是放大的，价格**反向**动 1/L 就归零（不是「亏一部分」）；
                    ② 爆仓价是按**参考价**估的，真实的那条线要等成交价出来才定
                       （与「成交价以下单那一刻为准」同源，见文件头 ①）。
                    不说 ② 的话，用户会拿着一个差了几分钱的数来对账。
                    「反向」的方向词随多空走 —— 空头是**涨**。 */}
                {hasLiqLine ? (
                  <p className="trade-confirm__disclaimer trade-confirm__disclaimer--danger">
                    实际成交价以下单那一刻的行情为准，<strong>真实的爆仓价跟着成交价走</strong>，
                    与上面的参考值会有差异。价格{direction === 'short' ? '反向上涨' : '反向下跌'}
                    约 {(100 / leverage).toFixed(0)}% 时保证金归零，
                    <strong>系统会自动强平，这一笔投入全部亏掉</strong>。
                    名义本金是借来的，亏损以投入的 {fmtFish(parsed)} 条为上限，不会变成欠账。
                  </p>
                ) : (
                  <p className="trade-confirm__disclaimer">
                    实际成交价以下单那一刻的行情为准，可能与上面的参考价有细微差异。
                    价格下跌时卖出会亏掉一部分本金，最坏输光这一笔投入。
                  </p>
                )}
                {/* 危险带在**按下确认这一屏**再说一遍：选择器下面那段是常驻的，而真正
                    决定的那一下在这里。措辞不与上面重复 —— 距离那个数由上面那行
                    「参考爆仓价」旁边的百分数给，这里只讲它是什么和它贵在哪。 */}
                {highRisk && (
                  <p className="trade-confirm__disclaimer trade-confirm__disclaimer--danger">
                    <strong>这是高倍档：</strong>
                    {leverage}× 的爆仓线离现价只有约 {(100 / leverage).toFixed(1)}% —— 一根
                    普通的日内波动就能碰到，方向看对了也照样会被收走。手续费按名义本金收，
                    这一笔平仓一次约合投入的 {formatFeeRate(feeRate * leverage)}。
                  </p>
                )}
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
                    {busy
                      ? direction === 'short'
                        ? '做空中…'
                        : '买入中…'
                      : direction === 'short'
                        ? '确认做空'
                        : '确认买入'}
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
                    <dt>方向</dt>
                    <dd>
                      <span
                        className={`trade-confirm__dir trade-confirm__dir--${sellTarget.direction}`}
                      >
                        {DIRECTION_LABELS[sellTarget.direction]}
                      </span>
                    </dd>
                  </div>
                  <div className="trade-confirm__row">
                    <dt>投入</dt>
                    <dd>{fmtFish(sellTarget.stake)} 小鱼干</dd>
                  </div>
                  {/* 同样的两条只在杠杆仓出现（理由见买入弹窗那一段）。 */}
                  {sellTarget.leverage > 1 && (
                    <>
                      <div className="trade-confirm__row">
                        <dt>杠杆</dt>
                        <dd>
                          <span className="trade-confirm__lev">{sellTarget.leverage}×</span>
                        </dd>
                      </div>
                      <div className="trade-confirm__row">
                        <dt>名义本金</dt>
                        <dd>{fmtFish(roundFish(sellTarget.stake * sellTarget.leverage))} 小鱼干</dd>
                      </div>
                    </>
                  )}
                  <div className="trade-confirm__row">
                    <dt>开仓价</dt>
                    <dd>{fmtPrice(sellTarget.entryPrice)} USDT</dd>
                  </div>
                  {/* 判据是 `> 0`（那条线存在），不是 `杠杆 > 1` —— 1× 空头有一条真爆仓价。 */}
                  {sellTarget.liquidationPrice > 0 && (
                    <div className="trade-confirm__row">
                      <dt>爆仓价</dt>
                      <dd>
                        <span className="trade-confirm__liq">
                          {fmtPrice(sellTarget.liquidationPrice)} USDT
                        </span>
                      </dd>
                    </div>
                  )}
                  <div className="trade-confirm__row">
                    <dt>现价</dt>
                    <dd>
                      {sellEst ? (
                        <>
                          {fmtPrice(sellEst.px)} USDT
                          {/* ⚠️ 着色用 `favorable`（行情涨跌 × 方向），不是直接拿
                              changePercent 判 —— 空头「跌了」是在赚，直接判色红绿会反。
                              数值仍是**行情**涨跌幅。 */}
                          <span
                            className={`trade-confirm__delta trade-confirm__delta--${
                              sellEst.favorable ? 'up' : 'down'
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
                {/* 已经穿过爆仓价时**必须换一套话**：这一屏上面会显示「预计到手 0」，
                    而用户是带着「赶紧止损」的念头点进来的 —— 不说清就会以为是自己操作
                    弄丢的。而真实情况是：这一笔已经归零了，等系统扫到也会被强平，
                    两者的到手金额**完全一样**（同一个 max(0,…)，见 market-math.ts）。
                    方向词与「价格要回到哪一侧」都随多空走：空头是**涨破**、要**跌回**。 */}
                {sellEst?.liquidated ? (
                  <p className="trade-confirm__disclaimer trade-confirm__disclaimer--danger">
                    现价
                    <strong>{sellTarget.direction === 'short' ? '已涨破爆仓价' : '已跌破爆仓价'}</strong>
                    ，这笔仓位的保证金已经归零 —— 现在平仓与等系统强平，到手都是{' '}
                    <strong>0 条</strong>，没有区别。唯一的不同是：继续持有的话，价格若
                    {sellTarget.direction === 'short' ? '回落到' : '反弹回'}爆仓价
                    {sellTarget.direction === 'short' ? '之下' : '之上'}，这笔仓位就还在。
                  </p>
                ) : (
                  <p className="trade-confirm__disclaimer">
                    上面的价与金额都按<strong>展示价</strong>估算，实际到手以下单那一刻的成交价为准。
                    平仓后这一笔仓位就结清了，不能再恢复。
                  </p>
                )}
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
                    {busy
                      ? sellTarget.direction === 'short'
                        ? '平空中…'
                        : '卖出中…'
                      : sellTarget.direction === 'short'
                        ? '确认平空'
                        : '确认卖出'}
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
