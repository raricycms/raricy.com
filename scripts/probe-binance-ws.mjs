#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// probe-binance-ws.mjs — 行情 WebSocket 的可达性 / 稳定性探针（**在生产机上跑**）
//
// 【它回答什么问题】练手盘的行情现在是 REST 轮询（15 秒一次）。想升级成「交易所级
// 跳动」的话，**第一步不是写代码**，而是确认：从生产机（阿里云大陆）能不能挂住一条
// 币安行情 WebSocket。这跟「代码能不能写」是两件事 —— REST 那条路当年是一个个域名
// 实测出来的（见 src/lib/market-price.ts 文件头），长连接是另一条完全不同的路：
// 更容易被掐、被 QoS，而且本站从来没测过。我这儿连得上不代表那台机器连得上。
//
// 【怎么读结果】最要紧的不是「收到多少 tick」，是**最长静默**与**重连次数**：
//   · 一次没断 + 最长静默 < 5s   → 可以走 WS
//   · 有重连 / 有 > 15s 的静默   → 能走，但重连与「半死」判据的阈值要按这里量到的值取
//   · 连不上 / 连上秒断           → 这条路不通，回 REST 调频率
// 「连着但收不到」是本站已经交过学费的失效模式（顶栏 SSE 那条红线）：连接还在、
// 进程还在、日志什么都不打，而页面上的价永远冻住。行情流一模一样。
//
// 【不依赖任何 npm 包】只用 node: 内置 —— Node 22 有全局 WebSocket；Node 20 则回退
// 到本机的 ws（若装了）。两个都没有会**明确报错**，不会静默失败。
// **故意不 import 站内模块**：它要在生产机上独立跑，不该被构建产物或依赖状态牵连。
//
// 用法：
//   node scripts/probe-binance-ws.mjs                              # 10 分钟，正式跑
//   node scripts/probe-binance-ws.mjs --seconds 60                 # 短跑（先验证脚本本身）
//   node scripts/probe-binance-ws.mjs --host stream.binance.com    # 换源对照
//   node scripts/probe-binance-ws.mjs --symbols btcusdt            # 只订一个标的
// 跑完（或 Ctrl-C）会打印一段可直接粘贴回来的总结。
//
// 注意：如果这台机器出网要走代理，本脚本**不认** HTTPS_PROXY（WebSocket 没有标准
// 的代理环境变量）—— 届时先说明代理怎么配，再谈这个测试。
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';
import dns from 'node:dns/promises';

// ── 参数 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
/** REST 那条腿的域（同族，用来做 DNS 对照与「网络本身通不通」的参照）。 */
const REST_HOST = 'data-api.binance.vision';

const opts = {
  seconds: Number(arg('seconds', 600)),
  host: arg('host', 'data-stream.binance.vision'),
  symbols: arg('symbols', 'btcusdt,ethusdt')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // 静默多久值得记一笔 / 多久算「半死」并强制重连
  silenceWarnMs: Number(arg('silence-warn', 15_000)),
  silenceDeadMs: Number(arg('silence-dead', 120_000)),
  reportEveryMs: 30_000,
};

if (!Number.isFinite(opts.seconds) || opts.seconds <= 0) {
  console.error('--seconds 需要一个正数');
  process.exit(2);
}

// ── 选一个 WebSocket 实现 ───────────────────────────────────────────────────

function resolveWebSocket() {
  if (typeof WebSocket !== 'undefined') return { Ctor: WebSocket, name: 'node 内置 WebSocket' };
  try {
    const require = createRequire(import.meta.url);
    const ws = require('ws');
    return { Ctor: ws.WebSocket ?? ws, name: `npm ws@${require('ws/package.json').version}` };
  } catch {
    return null;
  }
}

const impl = resolveWebSocket();
if (!impl) {
  console.error(
    [
      '',
      '✗ 这台机器上的 Node 既没有全局 WebSocket（Node 22+ 才有），也找不到 ws 包。',
      `  当前 Node：${process.version}`,
      '',
      '  两条路选一条：',
      '    1) 用 Node 22 跑这个脚本（不必换部署用的 Node）',
      '    2) 在本目录装一个：npm i ws --no-save   （--no-save 不碰 lockfile）',
      '',
    ].join('\n')
  );
  process.exit(2);
}

// ── 统计 ────────────────────────────────────────────────────────────────────

/** 一条流的滚动统计（只留标量，不存数组 —— 10 分钟能有几万条）。 */
function newStats() {
  return { count: 0, firstAt: 0, lastAt: 0, maxGapMs: 0, sumGapMs: 0, gapCount: 0, sumLatencyMs: 0, maxLatencyMs: 0, minLatencyMs: Infinity };
}

const stats = {
  startedAt: Date.now(),
  ticks: 0,
  perSymbol: new Map(opts.symbols.map((s) => [s, newStats()])),
  lastMessageAt: 0,
  maxSilenceMs: 0,
  silenceEpisodes: 0, // > silenceWarnMs 的静默段数
  connects: 0, // 连接尝试次数（含第一次）
  reconnects: 0, // 其中由断开/超时触发的重连次数
  events: [], // 断开 / 半死 / 错误，按发生顺序
};

function note(kind, detail) {
  stats.events.push({ at: Date.now(), kind, detail });
  console.log(`[${stamp()}] ${kind}${detail ? ` — ${detail}` : ''}`);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const ms = (n) => `${Math.round(n)}ms`;
const secs = (n) => `${(n / 1000).toFixed(1)}s`;

// ── 先做对照：DNS 与 REST ───────────────────────────────────────────────────

async function preflight() {
  console.log('── 探针 ──────────────────────────────────────────────');
  console.log(`Node      ${process.version}（${impl.name}）`);
  console.log(`WS 目标   wss://${opts.host}/stream?streams=${opts.symbols.map((s) => `${s}@trade`).join('/')}`);
  // 故意订 @trade：**消息最密**的流（每笔成交一条，实测 ~30 条/秒/标的）。连它都稳，
  // 就没理由不稳；真要落地时大概会用 @miniTicker（1 条/秒）那种轻得多的流。
  console.log(`时长      ${opts.seconds}s`);

  for (const host of [opts.host, REST_HOST]) {
    try {
      const { address, family } = await dns.lookup(host);
      console.log(`DNS       ${host} → ${address} (IPv${family})`);
    } catch (e) {
      console.log(`DNS       ${host} → 解析失败：${e.code ?? e.message}`);
    }
  }
  // REST 是**已经在跑的那条路**，它通说明基础出网没问题 —— 于是 WS 失败的责任就落回 WS 本身
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${REST_HOST}/api/v3/ticker/price?symbol=BTCUSDT`, {
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    console.log(`REST 对照 GET /ticker/price → ${res.status} ${j.price}（${ms(Date.now() - t0)}）`);
  } catch (e) {
    console.log(`REST 对照 失败（${ms(Date.now() - t0)}）：${e.message}`);
  }
  console.log('──────────────────────────────────────────────────────');
}

// ── 主循环：连接 → 收 tick → 断了重连，直到时间到 ───────────────────────────

/**
 * 连接状态机。**为什么要它**：握手失败时，node 内置 WebSocket 实测只触发 `error`、
 * **不触发 `close`**（在 stream.binance.com 那条失败路径上验过）。只挂 onclose 的写法
 * 会在第一次失败之后彻底安静下来、剩下的时间什么都不做 —— 那正是本探针要抓的
 * 「半死」，只不过发生在探针自己身上。所以：「这条连接结束了」一律走 onDown()，
 * 另有一个 1 秒看门狗兜住「两个事件都没来」的情况。
 */
let ws = null;
let done = false;
let phase = 'idle'; // idle | connecting | open
let attemptAt = 0;
let reconnectTimer = null;
let reconnectPending = false;
/** 多久没握上手就算这次尝试失败（DNS 失败 / RST / TLS 拦截通常秒级就回）。 */
const CONNECT_TIMEOUT_MS = 10_000;
const url = `wss://${opts.host}/stream?streams=${opts.symbols.map((s) => `${s}@trade`).join('/')}`;

function connect() {
  if (done) return;
  reconnectPending = false;
  phase = 'connecting';
  attemptAt = Date.now();
  stats.connects++;
  let opened = false;

  try {
    ws = new impl.Ctor(url);
  } catch (e) {
    return onDown(`构造失败：${e.message}`, false);
  }

  ws.onopen = () => {
    opened = true;
    phase = 'open';
    stats.lastMessageAt = Date.now();
    console.log(
      `[${stamp()}] 已连接（握手 ${ms(Date.now() - attemptAt)}）${stats.connects > 1 ? ` · 第 ${stats.connects} 次尝试` : ''}`
    );
  };

  ws.onmessage = (ev) => {
    const now = Date.now();
    let raw;
    try {
      raw = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return; // 心跳等非 JSON 帧：忽略即可
    }
    const d = raw.data ?? raw;
    if (!d || typeof d.p !== 'string' || typeof d.s !== 'string') return;

    const sym = String(d.s).toLowerCase();
    const s = stats.perSymbol.get(sym);
    if (!s) return;

    if (s.lastAt) {
      const gap = now - s.lastAt;
      s.gapCount++;
      s.sumGapMs += gap;
      if (gap > s.maxGapMs) s.maxGapMs = gap;
    } else {
      s.firstAt = now;
    }
    s.lastAt = now;
    s.count++;
    stats.ticks++;

    // 事件时间与本地钟的差 = 单程延迟 + 两机钟差（NTP 同步的话就是个位数秒级以内）
    if (typeof d.E === 'number') {
      const lat = now - d.E;
      s.sumLatencyMs += lat;
      if (lat > s.maxLatencyMs) s.maxLatencyMs = lat;
      if (lat < s.minLatencyMs) s.minLatencyMs = lat;
    }

    // 「最长静默」按**真实的消息间隔**算，不靠 30 秒的采样点 —— 否则短静默会被漏掉
    if (stats.lastMessageAt) {
      const gapAll = now - stats.lastMessageAt;
      if (gapAll > stats.maxSilenceMs) stats.maxSilenceMs = gapAll;
      if (gapAll > opts.silenceWarnMs) {
        stats.silenceEpisodes++;
        note('⚠ 静默', `${secs(gapAll)} 没收到任何消息（两个标的合计）`);
      }
    }
    stats.lastMessageAt = now;
  };

  ws.onerror = () => {
    // 浏览器式实现的 onerror 不带细节。**别在这里安排重连** —— 交给 onDown 或看门狗，
    // 否则会与随后的 onclose 抢着排，同一次失败数出两次
    if (!opened) note('错误', '握手阶段失败（域不可达 / 被 RST / TLS 被拦），等看门狗收尾');
  };

  ws.onclose = (ev) => {
    onDown(`code=${ev.code ?? '?'} reason=${ev.reason ? `"${ev.reason}"` : '（空）'}`, true);
  };
}

/**
 * 一条连接的唯一出口：先拆干净（摘掉回调再 close，免得再触发一轮），记一笔，
 * 然后安排重连。`hadOpened` 只影响文案 —— 没握上手就说「尝试失败」。
 */
function onDown(why, hadOpened) {
  if (done) return;
  const cur = ws;
  ws = null;
  phase = 'idle';
  if (cur) {
    try {
      cur.onopen = cur.onmessage = cur.onerror = cur.onclose = null;
      cur.close?.();
    } catch { /* 已经死了，忽略 */ }
  }
  const lived = hadOpened ? ` · 存活 ${secs(Date.now() - attemptAt)}` : '';
  note(hadOpened ? '断开' : '尝试失败', `${why}${lived}`);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (done || reconnectPending) return;
  reconnectPending = true;
  stats.reconnects++;
  // 退避：1s → 2s → 4s …封顶 10s
  const delay = Math.min(10_000, 1000 * 2 ** Math.min(stats.reconnects - 1, 4));
  reconnectTimer = setTimeout(() => {
    if (!done) connect();
  }, delay);
}

/** 看门狗（1 秒）：兜住「既不 onclose 也不 onerror」的两种情形。 */
const watchdog = setInterval(() => {
  if (done) return;
  const now = Date.now();
  if (phase === 'connecting' && now - attemptAt > CONNECT_TIMEOUT_MS) {
    onDown(`${secs(CONNECT_TIMEOUT_MS)} 没握上手（既没 close 也没 error，看门狗收的尾）`, false);
  } else if (phase === 'open') {
    const silence = now - stats.lastMessageAt;
    if (silence > opts.silenceDeadMs) {
      onDown(`半死：静默 ${secs(silence)} 且没有任何事件（SSE 那条红线说的就是这种状态）`, true);
    }
  }
}, 1000);

/** 每 30 秒报一次活。 */
const reporter = setInterval(() => {
  const now = Date.now();
  const silence = now - (stats.lastMessageAt || now);
  if (silence > stats.maxSilenceMs) stats.maxSilenceMs = silence;

  const elapsedSec = Math.round((now - stats.startedAt) / 1000);
  console.log(
    `[${stamp()}] ${elapsedSec}s/${opts.seconds}s · tick=${stats.ticks} · 最长静默=${secs(stats.maxSilenceMs)} · 连接=${stats.connects} · 重连=${stats.reconnects}`
  );
}, opts.reportEveryMs);

// ── 收尾 ────────────────────────────────────────────────────────────────────

function finish() {
  if (done) return;
  done = true; // 先置位：下面的 close 会再触发一轮回调，那些都靠它早退
  clearInterval(reporter);
  clearInterval(watchdog);
  clearTimeout(reconnectTimer);
  const cur = ws;
  ws = null;
  try {
    if (cur) {
      cur.onopen = cur.onmessage = cur.onerror = cur.onclose = null;
      cur.close?.();
    }
  } catch { /* 忽略 */ }

  const wallMs = Date.now() - stats.startedAt;
  const line = (label, value) => console.log(`${label.padEnd(22)}${value}`);

  console.log('');
  console.log('══════════ 总结（把这一段整段贴回来）══════════');
  line('连接', `${stats.connects} 次（重连 ${stats.reconnects}）`);
  line('实际时长', secs(wallMs));
  line('tick 总数', String(stats.ticks));
  if (stats.ticks === 0) {
    line('结论', '✗ 一个 tick 都没收到 —— 这条路不通，回 REST 调频率');
  } else {
    const rate = stats.ticks / (wallMs / 1000);
    line('平均速率', `${rate.toFixed(1)} tick/s（两个标的合计）`);
    line('最长静默', `${secs(stats.maxSilenceMs)}${stats.silenceEpisodes ? ` · 超过 ${secs(opts.silenceWarnMs)} 的静默 ${stats.silenceEpisodes} 段` : ' · 没有异常静默'}`);
    for (const [sym, s] of stats.perSymbol) {
      if (!s.count) {
        line(`  ${sym}`, '一条都没收到');
        continue;
      }
      const avgGap = s.gapCount ? s.sumGapMs / s.gapCount : 0;
      const avgLat = s.sumLatencyMs / s.count;
      line(
        `  ${sym}`,
        `${s.count} tick · 间隔 均 ${ms(avgGap)} / 最大 ${ms(s.maxGapMs)} · 事件时间差 均 ${ms(avgLat)} / 最大 ${ms(s.maxLatencyMs)}`
      );
    }
  }
  if (stats.events.length) {
    console.log('── 事件 ──');
    for (const e of stats.events) console.log(`  ${new Date(e.at).toISOString().slice(11, 19)}  ${e.kind}  ${e.detail ?? ''}`);
  }
  console.log('── 判据 ──');
  console.log('  一次没断 + 最长静默 < 5s        → 可以走 WS');
  console.log('  有重连 / 有 > 15s 的静默        → 能走，但重连与半死阈值按上面量到的取');
  console.log('  连不上 / 连上秒断 / 0 tick      → 这条路不通，回 REST 把频率调上去');
  console.log('  另注：「事件时间差」含两机钟差，只用来发现异常（比如回填旧数据）');
  console.log('═══════════════════════════════════════════════');
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n（收到 Ctrl-C，按当前进度收尾）');
  finish();
});

await preflight();
connect();
setTimeout(finish, opts.seconds * 1000);
