// ─────────────────────────────────────────────────────────────────────────────
// webhook-drainer.ts — 回调投递的**进程内**定时驱动
//
// 这是本站第一个后台循环。之所以要有它：回调失败之后如果只能靠运维敲
// `fish webhook-retry`，那一次失败的回调可能要等很久才重试 —— 而商户在等这笔
// 到账通知。定时器把「重试」变成不需要人值守的事；CLI 仍然保留，作为兜底与
// 手动推动（见 docs/cli.md）。
//
// 【启动方式是 Next 的 instrumentation 钩子】`src/instrumentation.ts` 的
// register() 在进程启动时调一次。不要改成「被某个库 import 时自动启动」——
// vitest 会直接 import src/lib/* ，那样会让每个测试文件都起一个后台循环去发
// 真实 HTTP 请求。所以这里只**导出** startWebhookDrainer，由 instrumentation 调。
//
// 【单进程前提】与 SSE / chat-bus / rate-limit 同款：多实例部署时每个实例都会各跑
// 一个 drainer。**投递不会重复**（认领是条件 UPDATE，见 fish-webhook-service），
// 只是会多几次空扫。真正要改的是限频/广播那几层（见 docs/architecture.md §2）。
//
// 【测试与 e2e 里必须关掉】两层保险：
//   ① NODE_ENV === 'test' 直接不启动（vitest 那边）；
//   ② tests/setup.ts 与 playwright 的 webServer env 都把 FISH_WEBHOOK_DRAIN_MS 置 0。
// 不关的话，e2e 跑着跑着会有一个后台循环去投递真实地址 —— 而 e2e 里根本没有接收端。
// ─────────────────────────────────────────────────────────────────────────────

import { drainWebhookDeliveries } from './fish-webhook-service';

/** 挂在 globalThis 上防 dev HMR 重复启动（同 topbar-bus 的写法）。 */
const GLOBAL_KEY = '__raricyWebhookDrainerTimer';
/** 上一轮还没跑完就跳过这一轮 —— 别让 drain 叠起来。 */
const BUSY_KEY = '__raricyWebhookDrainerBusy';

/** 默认扫描间隔（毫秒）。 */
export const DEFAULT_DRAIN_MS = 30_000;

/**
 * 读间隔配置。`0`（或负数、非数字）= **关闭**。
 * 关掉是运维手段：回调出问题时可以先停掉重试风暴，再慢慢查。
 */
export function drainIntervalMs(): number {
  const raw = process.env.FISH_WEBHOOK_DRAIN_MS;
  if (raw === undefined || raw === '') return DEFAULT_DRAIN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * 启动定时投递。**幂等** —— 重复调用只会有第一个生效。
 * 返回是否真的启动了（测试与排障用）。
 */
export function startWebhookDrainer(): boolean {
  // ① 测试进程里绝不自动跑（见文件头）
  if (process.env.NODE_ENV === 'test') return false;

  const ms = drainIntervalMs();
  if (ms <= 0) {
    console.log('[webhook-drainer] FISH_WEBHOOK_DRAIN_MS=0，定时投递已关闭。');
    return false;
  }

  const g = globalThis as unknown as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return false; // 已经起了（HMR / 重复 register）

  const tick = async () => {
    if (g[BUSY_KEY]) return;
    g[BUSY_KEY] = true;
    try {
      const r = await drainWebhookDeliveries();
      if (r.delivered || r.retried || r.dead || r.reclaimed) {
        console.log(
          `[webhook-drainer] 扫描 ${r.scanned}：成功 ${r.delivered}，待重试 ${r.retried}，` +
            `判死 ${r.dead}，回收租约 ${r.reclaimed}`
        );
      }
    } catch (e) {
      // 定时器绝不能因为一次异常就死掉 —— 记一行继续转下一轮
      console.error('[webhook-drainer] 本轮异常（下一轮继续）:', e);
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

  console.log(`[webhook-drainer] 已启动，每 ${ms}ms 扫描一次待投递回调。`);
  return true;
}

/** 停掉（测试与优雅退出用）。 */
export function stopWebhookDrainer(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const timer = g[GLOBAL_KEY] as ReturnType<typeof setInterval> | undefined;
  if (timer) {
    clearInterval(timer);
    delete g[GLOBAL_KEY];
  }
  delete g[BUSY_KEY];
}
