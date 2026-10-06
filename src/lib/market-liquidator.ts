// ─────────────────────────────────────────────────────────────────────────────
// market-liquidator.ts — 练手盘的**强平引擎**（本站第一个「自己动手动钱」的后台循环）
//
// 【它做什么】每隔一段时间扫一遍**会爆仓的**仓位，谁的价格穿过了自己那行上写死的
// **爆仓价**，就把谁强制结清（status: open → liquidated）。
//
// 【为什么必须有它】这类仓位的亏损在爆仓价处归零（见 market-math.ts 头部）。归零之后
// 用户没有任何理由自己动手 —— 他按「平仓」拿到的也是 0。所以系统必须自己来收这一笔；
// 没有它，「亏光」这个状态就永远只存在于公式里，而库里那行一直是 open。
//
//   ★ 哪些仓位「会爆仓」：判据是**存着的爆仓价 > 0**，不是 `leverage > 1` ★
//     多头 1 倍的爆仓价是 0（价格到不了 0 以下 ⇒ 那条线不存在），所以加杠杆那一版
//     写的是 `leverage > 1`。**做空把它推翻了**：空头任何杠杆下爆仓价都 > 0，
//     1× 空头在 2 × 开仓价归零。于是扫描的筛选改成 `liquidation_price > 0` ——
//     它天然包含 1× 空头、天然排除 1× 多头，而且不依赖方向这个维度（少一处能写反的判据）。
//     ⚠️ 它与 `market-service.openPosition` 的开仓闸门（`needsLiquidator`）**必须同真同假**：
//     闸门放行而这里捞不到的仓位 = 一份没人清算的免费期权，全程不报错。
//
//   ★ 穿线的方向也分多空 ★
//     多头是「现价**跌到**爆仓价或以下」，空头是「现价**涨到**爆仓价或以上」。
//     两种都靠每行自己的 direction 分派 —— 判据写反的话，一个刚开的健康空头会被
//     下一轮立刻结清（它的爆仓价在开仓价上方，而多头的 `现价 ≤ 爆仓价` 对它恒真）。
//
// ── ★ 它是本站第一个会自己动手动钱的后台循环 ★ ─────────────────────────────
// 另外三个循环（webhook 投递 / 行情轮询 / 行情流）要么只投递、要么只写展示缓存。
// 这一个在**用户没按任何按钮**的情况下改仓位行的状态。因此：
//   · 它**不写鱼干流水**。爆仓价处的权益恰好是 0，实发恒为 0 —— 没有钱动过，也就不该
//     有流水（同「实发为 0 的平仓也不写流水」那一档）。这条不变式由
//     tests/unit/market-math.test.ts 钉着：改 liquidationPrice() 会当场让它变红。
//     ⚠️ 所以这里没有 postEntry、没有事务 —— 一条条件 UPDATE 就是全部写操作。
//   · **它不 import market-service**（那边 import 本模块取 isLiquidationRunning，
//     反向再 import 成环会炸在模块求值上）。要复用的算术全在零依赖的 market-math。
//   · **它不判禁言**。禁言是「不能说话」，不该顺带变成「不能止损」——被禁言的人手上
//     还开着的杠杆仓照旧会被强平（与 sell 不判禁言同源，见 sell/route.ts 头部）。
//
// ── ★ 结算价是**爆仓价**，不是现价 ★ ────────────────────────────────────────
// 触发判据是「现价穿过了爆仓价」（多头 ≤、空头 ≥），但写进 exit_price 的是**那行上
// 存着的爆仓价**。两条，都不是洁癖：
//   1. **封顶**。若按现价结算，一次插针到爆仓价以下的行情会让权益变成负数 ——
//      而负数只能被 max(0,…) 截成 0，结果一样。按爆仓价结算则让「亏光投入」这件事
//      是**算出来的**而不是**截出来的**，谁读这行都能验算。
//   2. **时间无关**。爆仓价是个常量，所以「什么时候发现」不影响「结算成多少」——
//      引擎晚了一轮、挂了十分钟再起来，用户拿到的数完全一样。这条把一整类
//      「引擎越慢用户越亏/越赚」的问题消掉了。
//   ⚠️ 推论：**两次 tick 之间的插针不触发爆仓**（多头是价格跌下去又弹回来、空头是涨上去
//      又跌回来，那一轮扫不到就不爆）。这不是漏洞：用户无法影响 tick 时机，最坏是被白送
//      一次「幸免」；而按上面的第 2 条，它也绝不会让任何人多亏。
//
// ── 成交价现取，不是缓存价 ──────────────────────────────────────────────────
// 每个 tick 对**有杠杆仓的标的**各调一次 fetchQuote()（与开平仓同一条边界）。
// 这里要现取的理由与成交略有不同：不是为了防套利（用户按不了这个按钮），而是
// **判定必须诚实** —— 拿 15 秒前的缓存价去爆一个人的仓，会在他价格已经弹回来之后
// 把他强平掉。行情源挂了就跳过这一轮（仓位留着，下一轮再说），**不降级、不猜**。
//
// ── 启动方式与开关 ──────────────────────────────────────────────────────────
// 与另三个循环同款：只**导出** startMarketLiquidator，由 src/instrumentation.ts 调。
// 别改成「被 import 时自动启动」—— vitest 会直接 import src/lib/*。
//   · `MARKET_LIQUIDATE_MS` 默认 15000，`0` = 关闭（运维手段）。
//   · **关掉它不只是关掉一个循环**：isLiquidationRunning() 会跟着变成 false，
//     于是 openPosition 拒绝开**会爆仓的**仓位（503）。这是刻意的 —— 卖一个兑现不了的
//     产品比不卖更糟。**1 倍多头**不受影响（它永远碰不到爆仓价）；**空头与杠杆仓
//     （含 1× 空头）一并关掉** —— 判据是 needsLiquidator，见文件头。
//   · 那个判据是 **fail-closed** 的（没起来就是没起来，不看 NODE_ENV）——
//     理由见 isLiquidationRunning 的注释，别给它加 test 环境的默认放行。
//   · 单进程前提：多实例部署时每个实例各扫一遍。**无害** —— 结算是条件 UPDATE
//     （`where status='open'`），只有一个能改到，另一个 count 为 0。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { fetchQuote, parseSymbol, MarketPriceError } from './market-price';
import { settleClose } from './market-math';
// 只取类型（方向词表零依赖，但这里不需要它的任何值）。
import type { Direction } from './market-leverage';

/** 挂在 globalThis 上：防 dev HMR 重复启动，也让「引擎是否活着」能被别的模块读到。 */
const TIMER_KEY = '__raricyMarketLiqTimer';
/** 上一轮还没跑完就跳过这一轮 —— 别让扫描叠起来。 */
const BUSY_KEY = '__raricyMarketLiqBusy';
/** 「引擎正在跑」的标志。**它同时是开杠杆仓的闸门**（见 isLiquidationRunning）。 */
const RUNNING_KEY = '__raricyMarketLiqRunning';

/**
 * 默认扫描间隔。与行情轮询同档的 15 秒。
 *
 * 【为什么不是 1 秒】爆仓是**低频**事件（要价格真的穿过那一条线），而每一轮都要
 * 对每个有杠杆仓的标的现取一次价。1 秒一轮等于把出站请求量乘 15，换来的只是
 * 「爆得更及时」——而按上面的「时间无关」，早爆晚爆用户拿到的数完全一样。
 * 真要更灵敏，改这个环境变量即可，不用发版。
 */
export const DEFAULT_LIQUIDATE_MS = 15_000;

type G = Record<string, unknown>;

function g(): G {
  return globalThis as unknown as G;
}

/**
 * 读扫描间隔。`0`（或负数、非数字、非有限值）= **关闭**。
 * 关掉是运维手段（同 MARKET_POLL_MS）：行情源长期不通时先停掉，免得日志被刷屏。
 * ⚠️ 它同时关掉**会爆仓的仓位开仓**（杠杆仓与空头仓，含 1× 空头）—— 见文件头。
 */
export function liquidationIntervalMs(): number {
  const raw = process.env.MARKET_LIQUIDATE_MS;
  if (raw === undefined || raw === '') return DEFAULT_LIQUIDATE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * 强平引擎此刻是否在跑。**openPosition 拿它决定要不要卖杠杆仓**。
 *
 * 【★ fail-closed：只有 startMarketLiquidator() 真的写进 true 才放行 ★】
 * env 配了但启动失败（instrumentation 那一段抛了、进程根本没走到那）同样是 false ——
 * 「配置说有」和「真的在跑」是两件事，而这个闸门要的是后者。
 *
 * ⚠️ **别给它加一个 `NODE_ENV === 'test'` 的默认放行** —— 那是 fail-**open**：
 * 服务进程只要带着 `NODE_ENV=test` 起来（环境变量抄错、把测试 env 带进容器），
 * `startMarketLiquidator()` 会在开头直接 return false（**循环根本没起来**），
 * 而这个函数却返回 true：页面上的杠杆档照常可点、`buy` 也照常成交 —— 于是站点在
 * **没有任何清算者**的情况下卖 10 倍仓，用户手里拿着一份跌了亏损封顶、涨了全归他的
 * 永久免费看涨期权，而且没有任何症状。这正是本文件与 market-service 都在防的那条。
 * 测试要放行就**显式**打开（tests/setup.ts 里有那一行，route/service 用例的
 * beforeEach 各有一处）—— 显式打开是可见的，env 巧合不是。
 */
export function isLiquidationRunning(): boolean {
  return g()[RUNNING_KEY] === true;
}

/**
 * **仅供测试**：显式摆布闸门的状态。
 * 生产代码里没有任何地方该调它 —— 真实状态只由 start/stop 写。
 */
export function __setLiquidationRunning(running: boolean): void {
  g()[RUNNING_KEY] = running;
}

/** 启动扫描循环。**幂等** —— 重复调用只会有第一个生效。返回是否真的启动了。 */
export function startMarketLiquidator(): boolean {
  // ① 测试进程里绝不自动跑（见文件头）
  if (process.env.NODE_ENV === 'test') return false;

  const ms = liquidationIntervalMs();
  if (ms <= 0) {
    console.log('[market-liquidator] MARKET_LIQUIDATE_MS=0，强平引擎已关闭（杠杆开仓同时关闭）。');
    return false;
  }

  const store = g();
  if (store[TIMER_KEY]) {
    // 已经起了（HMR / 重复 register）。**仍然刷新一次运行标志** —— 标志可能是被
    // __setLiquidationRunning(false) 摆过（测试），这里要把它拉回真实状态。
    store[RUNNING_KEY] = true;
    return false;
  }

  const tick = async () => {
    if (store[BUSY_KEY]) return;
    store[BUSY_KEY] = true;
    try {
      const n = await sweepLiquidations();
      if (n > 0) console.log(`[market-liquidator] 本轮强平 ${n} 个仓位。`);
    } catch (e) {
      // 定时器绝不能因为一次异常就死掉 —— 记一行继续转下一轮
      console.error('[market-liquidator] 本轮异常（下一轮继续）:', e);
    } finally {
      store[BUSY_KEY] = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, ms);
  // unref：不让这个定时器把进程钉住不退出（部署时 systemd 发 SIGTERM 要能干净退出）
  timer.unref?.();
  store[TIMER_KEY] = timer;
  store[RUNNING_KEY] = true;

  console.log(`[market-liquidator] 已启动，每 ${ms}ms 扫一遍杠杆仓。`);
  return true;
}

/**
 * 停掉（优雅退出用；测试里想验闸门请用 __setLiquidationRunning）。
 *
 * ⚠️ 这里**删掉**运行标志而不是留着 true：删掉 = 「引擎没在跑」，而闸门是
 * fail-closed 的，于是它立刻读成 false（停止强平 = 停止卖杠杆，这是刻意的）。
 * ⚠️ **测试进程里调它的用例要自己把闸门开回来**（`__setLiquidationRunning(true)`），
 * 否则同一个文件后面的用例全都开不了杠杆仓，而失败点与被测的东西无关 ——
 * tests/setup.ts 那一行只在文件加载时执行一次，早于本函数。
 */
export function stopMarketLiquidator(): void {
  const store = g();
  const timer = store[TIMER_KEY] as ReturnType<typeof setInterval> | undefined;
  if (timer) {
    clearInterval(timer);
    delete store[TIMER_KEY];
  }
  delete store[BUSY_KEY];
  delete store[RUNNING_KEY];
}

/** 一个待判的仓位 —— 只取判据与结算要用的那几列。 */
interface Candidate {
  id: string;
  userId: string;
  symbol: string;
  /** `long`｜`short` —— 决定穿线方向（多头 ≤、空头 ≥）。 */
  direction: Direction;
  stakeUnits: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice: number;
}

/**
 * 一个**已经判定该爆**的仓位（扫描的产物，还没动手）。
 *
 * 带上 `stakeUnits` / `entryPrice` 是因为**结算要算一遍**（`liquidateOne` 用它验
 * 「爆仓价处实发为 0」那条不变式）。金额只此一份（存储单位），确认屏要显示鱼干时
 * 自己过 `unitsToFish` —— 别在这里再放一个已经换算好的副本，两份必然有一天对不上。
 */
export interface DueLiquidation {
  id: string;
  userId: string;
  symbol: string;
  /** `long`｜`short`。CLI 确认屏据此渲染正确的不等式（多头 ≤、空头 ≥）。 */
  direction: Direction;
  leverage: number;
  stakeUnits: number;
  entryPrice: number;
  /** 那行上存着的爆仓价。**结算价就是它**（不是现价，见文件头）。 */
  liquidationPrice: number;
  /** 判定时取到的现价。它只用来判「到没到」，不参与结算。 */
  currentPrice: number;
  /** 这次取价的库内时刻（写进 `exit_quote_at`，审计用）。 */
  quotedAt: Date;
}

export interface LiquidationScan {
  /** 判定该爆的仓位（一个都没有就是空数组）。 */
  due: DueLiquidation[];
  /** 这一轮**没扫成**的标的及其原因（白名单外 / 取价失败）。排障与确认屏都要说。 */
  skipped: { symbol: string; reason: string }[];
}

/**
 * **只读**扫一轮：对每个有杠杆仓的标的现取一次价，返回「谁该爆」。
 *
 * 【为什么要与动手那一步分开】CLI 的确认屏（`fish liquidate` 的 describe）要能在
 * **不写库**的前提下把「即将发生什么」摆给人看 —— 那是 CLI 的硬约定。
 * ⚠️ 但**预览是给你看的，不是执行的依据**：`sweepLiquidations` 会**重新扫一遍**。
 * 人读确认屏要花几秒，那几秒里价格早就走了（`fetchQuote` 是现取的，而扫描结果
 * 没有保鲜期可言）。拿一份旧扫描去结清仓位 = 对着一个过期的世界动手。
 *
 * **不抛异常**（行情源抖动只记进 skipped）—— 调用方是定时器与 CLI。
 */
export async function scanLiquidations(): Promise<LiquidationScan> {
  // 只捞**会爆仓的**：判据是「存着的爆仓价 > 0」。1 倍多头的爆仓价恒为 0（价格到不了
  // 0 以下），它们**结构上**不可能被强平；而 1× 空头是 2 × 开仓价，必须捞进来。
  // 把筛选放在查询里而不是循环里 —— 这个条件不会随时间变（liquidation_price 开仓写死），
  // 也就没有「查询与判据不一致」的风险，而它把这张表的扫描面缩到「还开着且会爆的仓位」。
  // ⚠️ 别写回 `leverage: { gt: 1 }` —— 那会把 1× 空头静默漏在扫描之外（见文件头）。
  const rows = await prisma.marketPosition.findMany({
    where: { status: 'open', liquidationPrice: { gt: 0 } },
    select: {
      id: true, userId: true, symbol: true, direction: true, stakeUnits: true,
      entryPrice: true, leverage: true, liquidationPrice: true,
    },
  });

  const due: DueLiquidation[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  if (rows.length === 0) return { due, skipped };

  // 同一标的的多个仓位共用一次出站请求。
  const bySymbol = new Map<string, Candidate[]>();
  for (const r of rows) {
    // 库里那一列是文本（Prisma 给 string）；词表只有 long/short（迁移的默认值是 long），
    // 这里按词表收窄一次。收窄放在**这一个**入口，别让 `as Direction` 散到判据那几行。
    const c: Candidate = { ...r, direction: r.direction as Direction };
    const list = bySymbol.get(r.symbol);
    if (list) list.push(c);
    else bySymbol.set(r.symbol, [c]);
  }

  for (const [symbolRaw, candidates] of bySymbol) {
    const symbol = parseSymbol(symbolRaw);
    if (!symbol) {
      // 白名单外的标的（改过 MARKET_SYMBOLS 之后残留的旧仓）。取不到价就没法判，
      // 记一行跳过 —— 绝不拿某个默认价去爆它。
      console.warn(`[market-liquidator] 跳过未知标的（不在 MARKET_SYMBOLS 里）：${symbolRaw}`);
      skipped.push({ symbol: symbolRaw, reason: '不在标的白名单里' });
      continue;
    }

    let quote;
    try {
      quote = await fetchQuote(symbol);
    } catch (e) {
      if (e instanceof MarketPriceError) {
        // 行情源抖动：这一轮不动这个标的的任何仓位，下一轮再说。
        // 按「时间无关」那条，晚一轮发现不会改变任何人拿到的数。
        console.warn(`[market-liquidator] 取价失败，本轮跳过 ${symbolRaw}: ${e.message}`);
        skipped.push({ symbol: symbolRaw, reason: '行情源不可用' });
        continue;
      }
      // 真故障：记一行、跳过（下一轮继续），绝不冒泡 —— 上面的 tick 兜着也不该靠它
      console.error(`[market-liquidator] 取价异常，本轮跳过 ${symbolRaw}:`, e);
      skipped.push({ symbol: symbolRaw, reason: '取价异常' });
      continue;
    }

    for (const c of candidates) {
      // 穿线方向随方向走：**多头**价格跌到爆仓价或以下就爆；**空头**是涨到或以上。
      // 判据用**现取价**。⚠️ 写反的后果不对称：用多头判据扫空头，一个刚开的健康空头
      //（爆仓价在开仓价上方）会**下一轮立刻被结清** —— 不报错、日志也只有一行正常的强平。
      const hit =
        c.direction === 'short'
          ? quote.price >= c.liquidationPrice
          : quote.price <= c.liquidationPrice;
      if (!hit) continue;
      due.push({
        id: c.id,
        userId: c.userId,
        symbol: c.symbol,
        direction: c.direction,
        leverage: c.leverage,
        stakeUnits: c.stakeUnits,
        entryPrice: c.entryPrice,
        liquidationPrice: c.liquidationPrice,
        currentPrice: quote.price,
        quotedAt: quote.quotedAt,
      });
    }
  }
  return { due, skipped };
}

/**
 * 扫一轮并**动手**：把穿过爆仓价的仓位强平掉。返回本轮强平的个数。
 *
 * 【它自己重新扫一遍，不复用任何人的扫描结果】见 scanLiquidations 的注释 ——
 * 扫描结果没有保鲜期，拿旧的那份去结清仓位等于对着一个过期的世界动手。
 */
export async function sweepLiquidations(): Promise<number> {
  const { due } = await scanLiquidations();
  let liquidated = 0;
  for (const d of due) {
    const ok = await liquidateOne(d);
    if (ok) {
      liquidated++;
      console.log(
        `[market-liquidator] 强平 ${d.symbol} ${d.leverage}x ${d.direction} ` +
          `(user=${d.userId} 爆仓价=${d.liquidationPrice} 现价=${d.currentPrice})`
      );
    }
  }
  return liquidated;
}

/**
 * 强平**一个**仓位。返回是否真的改到了（false = 别人先一步结清了，不是故障）。
 *
 * 一条条件 UPDATE 就是全部：`where status='open'` 是并发保护 —— 用户手动平仓、
 * 另一个实例的引擎、或者本进程上一轮，谁先改到谁算，其余 count 都是 0。
 *
 * ⚠️ **没有流水**：爆仓价处的权益恰好为 0，实发 0 = 没有钱动过（同「实发为 0 的
 * 平仓」那一档）。这里刻意不调 postEntry —— 而如果有一天
 * `liquidationPrice()` 被改成含维持保证金（爆仓时还剩一点权益），**这条就错了**，
 * 那会吞掉用户的钱。tripwire 在 tests/unit/market-math.test.ts：
 * 「以爆仓价结算，实发恒为 0」。
 */
async function liquidateOne(c: DueLiquidation): Promise<boolean> {
  // 结算价 = 那行上存着的爆仓价（不是现价，理由见文件头）。这一步在写库之前做，
  // 于是「实发是 0」这件事对读这行的人是可验算的。
  //
  // ⚠️ `feeRate: 0` 不是「爆仓不收手续费」的意思，而是**在问权益、不问到手**：
  // 费率传 0 时 settleClose 的 payoutUnits 就等于那条被 max(0,…) 截断的权益。
  // 这里要验的正是「爆仓价处权益归零」这条定义（下一行的告警靠它），而手续费是
  // 平仓时从那笔权益里扣的东西 —— 权益都是 0 了，扣不扣结果都一样。
  // 顺带：真正的 MARKET_FEE_RATE 在 market-service 里，而本模块**不能** import 它
  //（成环，见文件头）。用 0 在这里既正确又不必绕那个弯。
  const { payoutUnits } = settleClose({
    stakeUnits: c.stakeUnits,
    entryPrice: c.entryPrice,
    exitPrice: c.liquidationPrice,
    feeRate: 0,
    leverage: c.leverage,
    // ⚠️ 方向必须传：漏了（或给默认值）会让空头按多头公式算，爆仓价处实发**不为 0**，
    // 于是下面那条告警对每一笔空头强平都响（而它是「绝不该响」的那条）。
    direction: c.direction,
  });

  const flipped = await prisma.marketPosition.updateMany({
    where: { id: c.id, userId: c.userId, status: 'open' },
    data: {
      status: 'liquidated',
      exitPrice: c.liquidationPrice,
      exitQuoteAt: c.quotedAt,
      // 写**算出来的**那个数，不写一个字面量 0：万一上面那条不变式破了，
      // 库里那一行仍然是自洽的（只是那时就该给用户记一条流水了 —— 见上面的 tripwire）。
      payoutUnits,
      closedAt: nowForDb(),
    },
  });

  if (flipped.count === 0) {
    // 用户在同一瞬间自己平了（或另一个实例先扫到）。不是故障：钱一分没动。
    return false;
  }
  // ⚠️ 判据是 **payoutUnits**，不是「权益是否为 0」：浮点下爆仓价处的权益会留下
  // ~1.8e-12 的尘埃（实测 10× / 5× / 3× 都有，2× 恰好干净）—— 拿权益判会让这条
  // 告警**每次强平都响**，然后一次真响就淹没在噪音里了。而 payout 是 floor 过的
  // 整数，尘埃过不了 floor + 手续费那两道，实测恒为 0。
  // 要问的问题本来就是「这一笔会不会欠用户钱」，那正是 payout。
  if (payoutUnits !== 0) {
    // 正常永远不进来（爆仓价处实发为 0）。真进来了说明 liquidationPrice() 被改过
    //（比如加了维持保证金），而这条路径**不会**给用户补流水 —— 必须有人当场看见。
    console.error(
      `[market-liquidator] 异常：爆仓价处实发不为 0（${payoutUnits} 单位），` +
        `仓位 ${c.id} 少发了这部分。检查 market-math.liquidationPrice() 与结算公式。`
    );
  }
  return true;
}
