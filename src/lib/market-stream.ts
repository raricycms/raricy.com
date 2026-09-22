// ─────────────────────────────────────────────────────────────────────────────
// market-stream.ts — 练手盘行情的**常驻 WebSocket 消费端**（只喂展示缓存）
//
// 【它解决什么】15 秒一轮的 REST 轮询让屏幕上的价最坏 30 秒旧。这条流把「服务器知
// 道最新价」的延迟从 15 秒压到 ~50ms（实测），前端再把轮询降到 1 秒，于是页面上的价
// 每秒跳一次。**REST 那条循环一个字符都没动** —— 它现在同时是兜底价源：这条流挂了，
// getCachedQuotes() 在 STREAM_TRUST_MS 之后自动回落到它，屏幕不会冻住。
//
// 【★ 它只服务展示，不服务成交 ★】与 market-poll-drainer 同一条红线：成交价必须在
//   下单那一刻现取（market-service 的 fetchQuote），**谁要是图省事让下单读这里抄来的
//   价，就把整条安全边界拆了** —— 一帧 ~50ms 前的价同样是无风险套利，只是赢面小一点。
//   见 src/lib/market-price.ts 的文件头。
//
// 【为什么是 @trade】它与成交价**同口径**（都是「最新成交价」），展示与成交是同一个量、
//   只是时刻不同。@miniTicker 每条 1 秒、@bookTicker 是买一卖一，都不对口径。
//
// 【启动方式】与另两个后台循环同款：只**导出** startMarketStream，由
//   src/instrumentation.ts 调。不要改成「被某个库 import 时自动启动」—— vitest 会直接
//   import src/lib/*，那样每个测试文件都会去连真实币安。
//
// 【测试与 e2e 里必须关掉】三层保险（另两个循环只有两层）：
//   ① NODE_ENV === 'test' 直接不启动（vitest 那边）；
//   ② tests/setup.ts 置 MARKET_STREAM_SILENCE_MS=0；
//   ③ playwright 的 webServer env 同款 —— e2e 跑的是 next start，NODE_ENV 是
//      production，那道保险在那儿**盖不住**。e2e 的行情替身只有 HTTP、没有 WS 端点，
//      不关就会去连真实外网（违反「e2e 不能打真实外网」）。
//
// 【单进程前提】与 SSE / chat-bus / 另两个 drainer 同款：多实例部署时每个实例各连一条。
//   这里**完全无害**（各自多收几帧只读数据），不像限频那样需要换 Redis。
//
// 【阈值不是拍的，是量出来的】2026-09-22 生产机实测 10 分钟：0 重连、53828 tick、
//   合计最长静默 0.9s、事件时间差 30~54ms（对照 REST 一次往返 402ms）。
//   ⚠️ **半死判据必须盯「合计」静默**：同一次实测里单标的可以冷清 3.5 秒（BTC），
//   按单标的判会把一次正常冷清误判成断流、白重连一次。
//
// 【失效模式：握手失败既没有 close 也可能没有 error】探针实测（node 内置 WebSocket）：
//   域被 RST/TLS 拦时只触发 error 不触发 close；域被黑洞掉时**两个都不来**，连接就那么
//   挂着。只挂 onclose 的写法会在第一次失败后彻底安静 —— 那正是本站已经交过学费的
//   「连着但收不到」（顶栏 SSE 那条红线）。所以这里：「这条连接结束了」一律走 onDown()，
//   另有一个 1 秒看门狗兜底。这套写法已在 scripts/probe-binance-ws.mjs 上跑过 10 分钟
//   生产实测，是同一个形状。
// ─────────────────────────────────────────────────────────────────────────────

import { MARKET_SYMBOLS, applyStreamTick } from './market-price';

/** 挂在 globalThis 上防 dev HMR 重复起、也防两份模块实例各连一条（同另两个 drainer）。 */
const GLOBAL_KEY = '__raricyMarketStream';

/**
 * 行情 WS 的域。与 REST 那条腿同族（`data-api.binance.vision` 的 WS 版）——
 * 生产机实测可达、解析到 AWS 东京真 IP，见 market-price.ts 文件头那串域名实测记录。
 * **故意不给它一个 env 覆盖**：这条流坏了会自动回落到 REST，而 REST 那条腿已经有一个
 * `MARKET_PRICE_BASE_URL` 换源开关了，再加一个只是多一处要登记的配置。
 */
const STREAM_BASE = 'wss://data-stream.binance.vision';

/** 连不上时多久算这次尝试失败（DNS 失败 / RST / TLS 拦截通常秒级就回）。 */
const CONNECT_TIMEOUT_MS = 10_000;

/** 看门狗间隔。1 秒足够收住「既不 close 也不 error」，又不值得再密。 */
const WATCHDOG_MS = 1_000;

/**
 * 默认半死阈值：合计这么久没有**任何**帧就强制重连。
 * 30 秒 = 实测合计最长静默（0.9s）的 33 倍 —— 宁可迟钝也别白重连。
 */
export const DEFAULT_STREAM_SILENCE_MS = 30_000;

interface StreamState {
  ws: { close?: () => void; onopen?: unknown; onmessage?: unknown; onerror?: unknown; onclose?: unknown } | null;
  phase: 'idle' | 'connecting' | 'open';
  /** 本次连接的发起时刻（真实 UTC 毫秒，只用来算握手耗时与存活时长）。 */
  attemptAtMs: number;
  /** 最近一帧到达的时刻（**任何**标的 —— 半死判据看的就是它）。 */
  lastMsgAtMs: number;
  connects: number;
  reconnects: number;
  watchdog: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectPending: boolean;
  /** 生效的半死阈值（启动时读一次 env 定下来）。 */
  silenceMs: number;
  /** 消息处理里出现过非预期异常 —— 只报一次，不刷屏。 */
  warned: boolean;
}

/**
 * 测试注入的 WebSocket 实现。**故意做成模块级而不是放进上面的共享状态** ——
 * 它要活过 stopMarketStream()（那个函数会把整个共享状态删掉，见那里的注释），
 * 否则「停掉再起」的用例会掉回真实的全局 WebSocket、去连真实币安。
 */
let implOverride: unknown = null;

function streamState(): StreamState {
  const g = globalThis as unknown as Record<string, unknown>;
  let s = g[GLOBAL_KEY] as StreamState | undefined;
  if (!s) {
    s = {
      ws: null,
      phase: 'idle',
      attemptAtMs: 0,
      lastMsgAtMs: 0,
      connects: 0,
      reconnects: 0,
      watchdog: null,
      reconnectTimer: null,
      reconnectPending: false,
      silenceMs: DEFAULT_STREAM_SILENCE_MS,
      warned: false,
    };
    g[GLOBAL_KEY] = s;
  }
  return s;
}

/**
 * 读半死阈值配置。`0`（或负数、非数字）= **关闭这条流**（回退纯轮询）。
 * 关掉是运维手段：流出现异常行为时先停掉它，不用发版 —— 同 MARKET_POLL_MS 的语义。
 */
export function streamSilenceMs(): number {
  const raw = process.env.MARKET_STREAM_SILENCE_MS;
  if (raw === undefined || raw === '') return DEFAULT_STREAM_SILENCE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** 订阅地址：把白名单标的拼成币安的组合流（一条连接订多个标的）。 */
export function streamUrl(): string {
  const streams = MARKET_SYMBOLS.map((s) => `${s.toLowerCase()}@trade`).join('/');
  return `${STREAM_BASE}/stream?streams=${streams}`;
}

/** 测试钩子：注入一个假的 WebSocket 实现（传 null 恢复用全局那个）。 */
export function __setWebSocketImpl(impl: unknown): void {
  implOverride = impl;
}

/** 取当前生效的 WebSocket 构造器；这个进程里没有就返回 null（Node 20 / 非浏览器环境）。 */
function resolveCtor(): (new (url: string) => unknown) | null {
  if (implOverride) return implOverride as new (url: string) => unknown;
  const g = globalThis as unknown as { WebSocket?: new (url: string) => unknown };
  return typeof g.WebSocket === 'function' ? g.WebSocket : null;
}

/**
 * 启动行情流。**幂等** —— 重复调用只会有第一个生效（与另两个 drainer 同款）。
 * 返回是否真的启动了（测试与排障用）。
 */
export function startMarketStream(): boolean {
  // ① 测试进程里绝不自动跑（见文件头）
  if (process.env.NODE_ENV === 'test') return false;

  const s = streamState();
  const ms = streamSilenceMs();
  if (ms <= 0) {
    console.log('[market-stream] MARKET_STREAM_SILENCE_MS=0，行情流已关闭（展示回落到 15 秒轮询）。');
    return false;
  }

  // ② 已经起了（HMR / 重复 register / 两份模块实例）
  if (s.watchdog) return false;

  // ③ 这个进程没有 WebSocket 实现 → 优雅退化，不是故障。
  //    全局 WebSocket 要 Node 22+（生产实测 v22.23.1）；engines 声明的是 >=20，
  //    所以 Node 20 上这条必须走得到，且**不能抛**（instrumentation 里抛会拖垮启动）。
  if (!resolveCtor()) {
    console.log(
      '[market-stream] 本进程的 Node 没有全局 WebSocket（需要 22+），行情流不启动' +
        ' —— 展示回落到 15 秒轮询，成交不受影响。'
    );
    return false;
  }

  s.silenceMs = ms;
  watchdog();
  console.log(`[market-stream] 已启动，订阅 ${MARKET_SYMBOLS.map((x) => x.toLowerCase()).join('/')}（半死阈值 ${ms}ms）。`);
  connect(s);
  return true;
}

/**
 * 停掉（测试与优雅退出用）。**连共享状态一起删掉** —— 与另两个 drainer 的 stop 同款，
 * 于是「停掉再起」是一次干净的重来（计数归零、注入的实现照旧生效），测试之间也不会
 * 互相看见对方的连接计数。
 */
export function stopMarketStream(): void {
  const s = streamState();
  if (s.watchdog) clearInterval(s.watchdog);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  teardown(s);
  const g = globalThis as unknown as Record<string, unknown>;
  delete g[GLOBAL_KEY];
}

/** 一条连接的唯一出口：先把回调摘干净（免得 close() 再触发一轮），再安排重连。 */
function onDown(s: StreamState, why: string, hadOpened: boolean): void {
  if (!s.watchdog) return; // 已经停了 —— 不再安排重连
  teardown(s);
  const lived = hadOpened ? ` · 存活 ${((Date.now() - s.attemptAtMs) / 1000).toFixed(1)}s` : '';
  console.log(`[market-stream] ${hadOpened ? '断开' : '尝试失败'} — ${why}${lived}`);
  scheduleReconnect(s);
}

/** 拆掉当前连接（摘回调 + close）。**不**安排重连，也不改 watchdog。 */
function teardown(s: StreamState): void {
  const cur = s.ws;
  s.ws = null;
  s.phase = 'idle';
  if (!cur) return;
  try {
    cur.onopen = cur.onmessage = cur.onerror = cur.onclose = null;
    cur.close?.();
  } catch {
    /* 已经死了，忽略 */
  }
}

function scheduleReconnect(s: StreamState): void {
  if (!s.watchdog || s.reconnectPending) return;
  s.reconnectPending = true;
  s.reconnects++;
  // 退避：1s → 2s → 4s …封顶 10s（探针同款）
  const delay = Math.min(10_000, 1000 * 2 ** Math.min(s.reconnects - 1, 4));
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    connect(s);
  }, delay);
  // unref：不让这个定时器把进程钉住不退出（systemd 发 SIGTERM 要能干净退出）
  s.reconnectTimer.unref?.();
}

function connect(s: StreamState): void {
  if (!s.watchdog) return;
  s.reconnectPending = false;
  s.phase = 'connecting';
  s.attemptAtMs = Date.now();
  s.connects++;

  const Ctor = resolveCtor();
  // 没有实现**不是**瞬时故障（Node 20、或测试把注入撤了）→ 停掉整条流，别每 10 秒
  // 重试一次刷屏。startMarketStream 里那道检查管首次启动，这里管「跑到一半没了」。
  if (!Ctor) {
    console.log('[market-stream] 没有可用的 WebSocket 实现，行情流停止（展示回落到 15 秒轮询）。');
    stopMarketStream();
    return;
  }

  let ws: StreamState['ws'];
  try {
    ws = new Ctor(streamUrl()) as StreamState['ws'];
  } catch (e) {
    onDown(s, `构造失败：${String(e)}`, false);
    return;
  }
  if (!ws) {
    onDown(s, '构造失败：返回了空对象', false);
    return;
  }
  s.ws = ws;
  let opened = false;

  ws.onopen = () => {
    opened = true;
    s.phase = 'open';
    s.lastMsgAtMs = Date.now();
    console.log(
      `[market-stream] 已连接（握手 ${Date.now() - s.attemptAtMs}ms）` +
        (s.connects > 1 ? ` · 第 ${s.connects} 次尝试` : '')
    );
  };

  ws.onmessage = (ev: { data?: unknown }) => {
    try {
      const raw = ev?.data;
      const text = typeof raw === 'string' ? raw : String(raw);
      const parsed = JSON.parse(text) as { data?: unknown } | unknown[];
      // 组合流的外层是 { stream, data }；单流是裸对象。两种都认。
      const d = (Array.isArray(parsed) ? parsed[0] : (parsed as { data?: unknown }).data ?? parsed) as
        | { s?: unknown; p?: unknown }
        | undefined;
      if (!d || typeof d !== 'object') return;
      if (typeof d.p !== 'string' && typeof d.p !== 'number') return;
      applyStreamTick(d.s, Number(d.p), Date.now());
      // 合计静默：**任何**标的的帧都算活着（单标的可以冷清好几秒，见文件头）
      s.lastMsgAtMs = Date.now();
    } catch (e) {
      // 心跳等非 JSON 帧会走到这里（正常）。真出别的错也只报一次，不刷屏。
      if (!s.warned) {
        s.warned = true;
        console.warn('[market-stream] 有帧处理失败（后续不再重复报）:', e);
      }
    }
  };

  ws.onerror = () => {
    // 浏览器式实现的 onerror 不带细节。**别在这里安排重连** —— 交给 onDown 或看门狗，
    // 否则会与随后的 onclose 抢着排，同一次失败数出两次。
    if (!opened) console.log('[market-stream] 握手阶段失败（域不可达 / 被 RST / TLS 被拦），等看门狗收尾。');
  };

  ws.onclose = (ev: { code?: number; reason?: string }) => {
    onDown(s, `code=${ev?.code ?? '?'} reason=${ev?.reason ? `"${ev.reason}"` : '（空）'}`, true);
  };
}

/**
 * 看门狗（1 秒）：既负责重连（这是唯一的「该不该连」的驱动），也兜住两种
 * **没有任何事件**的情形 —— 连不上时只挂着的握手，和连着但一帧都不再来的半死。
 */
function watchdog(): void {
  const s = streamState();
  s.watchdog = setInterval(() => {
    const now = Date.now();
    if (s.phase === 'connecting' && now - s.attemptAtMs > CONNECT_TIMEOUT_MS) {
      onDown(s, `${CONNECT_TIMEOUT_MS}ms 没握上手（既没 close 也没 error，看门狗收的尾）`, false);
    } else if (s.phase === 'open' && now - s.lastMsgAtMs > s.silenceMs) {
      onDown(
        s,
        `半死：合计静默 ${((now - s.lastMsgAtMs) / 1000).toFixed(1)}s 且没有任何事件（SSE 那条红线说的就是这种状态）`,
        true
      );
    } else if (s.phase === 'idle' && !s.reconnectPending) {
      // 首连、或上一轮 onDown 之后还没排上（幂等兜底，正常不会走到）
      connect(s);
    }
  }, WATCHDOG_MS);
  // unref 同上：定时器不该把进程钉住
  s.watchdog.unref?.();
}
