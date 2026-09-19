// ─────────────────────────────────────────────────────────────────────────────
// market-poll-drainer.ts — 练手盘行情的**进程内**定时刷新
//
// 为什么要有它：练手盘页面上要显示现价与涨跌幅，而每次页面渲染或每次轮询请求都去
// 打一次币安，会让「有多少人在看盘」直接变成「我们对币安的请求量」。定时器把这件事
// 收敛成**每 15 秒一次、与访客数无关**。
//
// 【★ 它只服务展示，不服务成交 ★】
//   成交价必须在下单那一刻现取（见 market-price.ts 的文件头）。这个定时器刷新的
//   是缓存，**只在展示路径上被读**。谁要是图省事让下单读这个缓存，就把整条安全边界
//   拆了 —— 缓存龄 15 秒足够看盘的人做无风险套利。
//
// 【启动方式是 Next 的 instrumentation 钩子】与 webhook-drainer 同款：只**导出**
//   startMarketPoller，由 src/instrumentation.ts 调。不要改成「被某个库 import 时
//   自动启动」—— vitest 会直接 import src/lib/*，那样每个测试文件都会起一个后台
//   循环去打真实 HTTP。
//
// 【测试与 e2e 里必须关掉】两层保险（同 webhook-drainer）：
//   ① NODE_ENV === 'test' 直接不启动（vitest 那边）；
//   ② tests/setup.ts 与 playwright 的 webServer env 都把 MARKET_POLL_MS 置 0。
//   不关的话，e2e 跑着跑着会有一个后台循环去打币安 —— 而 e2e 的行情应当来自
//   tests/e2e/mock-market-price.ts（见 MARKET_PRICE_BASE_URL）。
//
// 【单进程前提】与 SSE / chat-bus / webhook-drainer 同款：多实例部署时每个实例各跑
//   一个。这里**完全无害**（就是多几次只读 GET），不像限频那样需要换 Redis。
// ─────────────────────────────────────────────────────────────────────────────

import { refreshQuotes } from './market-price';

/** 挂在 globalThis 上防 dev HMR 重复启动（同 webhook-drainer 的写法）。 */
const GLOBAL_KEY = '__raricyMarketPollTimer';
/** 上一轮还没跑完就跳过这一轮 —— 别让轮询叠起来。 */
const BUSY_KEY = '__raricyMarketPollBusy';

/**
 * 默认刷新间隔。15 秒是「看盘够用」与「请求量可忽略」之间的折中：
 * 币安那边 6000 权重/分的配额下，每 15 秒一次连零头都算不上。
 */
export const DEFAULT_POLL_MS = 15_000;

/**
 * 读间隔配置。`0`（或负数、非数字）= **关闭**。
 * 关掉是运维手段：币安不通时先停掉这条循环，免得日志被失败刷屏。
 */
export function pollIntervalMs(): number {
  const raw = process.env.MARKET_POLL_MS;
  if (raw === undefined || raw === '') return DEFAULT_POLL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * 启动定时刷新。**幂等** —— 重复调用只会有第一个生效。
 * 返回是否真的启动了（测试与排障用）。
 */
export function startMarketPoller(): boolean {
  // ① 测试进程里绝不自动跑（见文件头）
  if (process.env.NODE_ENV === 'test') return false;

  const ms = pollIntervalMs();
  if (ms <= 0) {
    console.log('[market-poller] MARKET_POLL_MS=0，行情轮询已关闭。');
    return false;
  }

  const g = globalThis as unknown as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return false; // 已经起了（HMR / 重复 register）

  const tick = async () => {
    if (g[BUSY_KEY]) return;
    g[BUSY_KEY] = true;
    try {
      // refreshQuotes 自己吞掉失败（返回 false）—— 行情源抖动不该刷屏，
      // 页面上「数据可能过期」的提示就是它的可见后果。
      await refreshQuotes();
    } catch (e) {
      // 定时器绝不能因为一次异常就死掉 —— 记一行继续转下一轮
      console.error('[market-poller] 本轮异常（下一轮继续）:', e);
    } finally {
      g[BUSY_KEY] = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, ms);
  // unref：不让这个定时器把进程钉住不退出（部署时 systemd 发 SIGTERM 要能干净退出）
  timer.unref?.();
  g[GLOBAL_KEY] = timer;

  console.log(`[market-poller] 已启动，每 ${ms}ms 刷新一次行情。`);
  return true;
}

/** 停掉（测试与优雅退出用）。 */
export function stopMarketPoller(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const timer = g[GLOBAL_KEY] as ReturnType<typeof setInterval> | undefined;
  if (timer) {
    clearInterval(timer);
    delete g[GLOBAL_KEY];
  }
  delete g[BUSY_KEY];
}
