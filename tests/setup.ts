// 全局测试环境：每个 vitest 进程用**独立**的临时 SQLite，
// 由 tests/helpers/db.ts 在首次 import 时按 prisma schema 建表。
//
// 关键 1：DATABASE_URL 必须在任何 `@/lib/db` 被 import 之前设置好，
//        否则 PrismaClient 会连到 .env 里的真实库 —— 测试绝不能碰真实数据。
//
// 关键 2：库文件名带 pid + 随机串。此前用固定的 test.db，多个 vitest 进程
//        （比如同时开几个终端跑、或 CI 并行分片）会同时读写并互相 rmSync 重建，
//        表现为随机的 "no such table" / "readonly database" / 唯一约束冲突 ——
//        看起来像被测代码不稳，实为测试基建自伤。

import path from 'node:path';
import fs from 'node:fs';
const TMP_DIR = path.resolve(import.meta.dirname, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

// 每进程独立：pid 防同机并发，随机串防 pid 复用
const TAG = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB = path.join(TMP_DIR, `test-${TAG}.db`);

process.env.DATABASE_URL = `file:${TEST_DB}`;

// 限频快照同理，必须在任何 @/lib/rate-limit 被 import 之前改指。
// 它的默认落点是 instance/rate-limit-snapshot.json —— 那是**生产运行时状态**
// （重启不重置窗口，见该文件头部）。不重定向的话，任何触发清扫落盘的用例都会把它
// 覆盖成测试桶（实测：rate-limit.test.ts 里走真实 Date.now() 的那条会让 10 分钟节拍
// 立即满足 → flushSnapshot() 写默认路径）。playwright 侧早有同样做法，见
// playwright.config.ts 的 RATE_LIMIT_SNAPSHOT_PATH；vitest 侧此前漏了。
//
// 文件名必须**按进程唯一**（同 TEST_DB 的 pid + 随机串）：固定名会让同机并行的两个
// vitest 进程互相覆盖快照、退出后还留一个谁也不删的残留文件（R3-720）。
const RATE_LIMIT_SNAPSHOT = path.join(TMP_DIR, `rate-limit-snapshot-${TAG}.json`);
// 硬校验：测试快照必须写 tests/.tmp 下的自己的文件，绝不能落到生产默认落点。
// 配置改错时要当场炸，而不是静默污染 instance/ 下的运行时状态 —— 与 db.ts
// 「拒绝在非测试库上运行」同一条纪律。
const PROD_SNAPSHOT = path.resolve(process.cwd(), 'instance', 'rate-limit-snapshot.json');
if (
  RATE_LIMIT_SNAPSHOT === PROD_SNAPSHOT ||
  !RATE_LIMIT_SNAPSHOT.replace(/\\/g, '/').includes('/tests/.tmp/')
) {
  throw new Error(`拒绝使用测试目录以外的限频快照路径：${RATE_LIMIT_SNAPSHOT}`);
}
process.env.RATE_LIMIT_SNAPSHOT_PATH = RATE_LIMIT_SNAPSHOT;

process.env.SECRET_KEY = 'test-secret-key-do-not-use-in-prod';
// NODE_ENV 由 vitest 自动置为 'test'，无需（也不能，@types/node 标了 readonly）在此赋值。

// 鱼干记账已全部在站内（同一个 SQLite 事务），没有需要在这里关掉的远端。
// 这里原先置空 ACCOUNT_SERVICE_INTERNAL_TOKEN / ACCOUNT_SYSTEM_KEY 以强制走
// dev fallback 分支 —— 那两个变量已不再被任何代码读取，用例也就不用再摆姿态。

// 回调投递的定时器**必须关掉**：跑起来的话，每个测试文件都会有一个后台循环
// 去发真实 HTTP 请求（而且指向的是用例里造的假地址）。
// src/lib/webhook-drainer.ts 里还有一道 `NODE_ENV === 'test'` 的保险，这里是第二道 ——
// 两道都留着：谁把那条判断删了，这条还兜得住。
process.env.FISH_WEBHOOK_DRAIN_MS = '0';

// 练手盘的行情轮询同理必须关掉：跑起来的话每个测试文件都会有一个后台循环去打
// 真实币安。src/lib/market-poll-drainer.ts 里还有一道 `NODE_ENV === 'test'` 的
// 保险，这里是第二道 —— 两道都留着。
process.env.MARKET_POLL_MS = '0';

// 练手盘的**行情流**（常驻 WebSocket）同理，而且更硬：它连的是外部地址、挂的是长连接，
// 跑起来每个测试文件都会去连一次真实币安。src/lib/market-stream.ts 里还有一道
// `NODE_ENV === 'test'` 的保险，这里是第二道 —— 两道都留着。
process.env.MARKET_STREAM_SILENCE_MS = '0';

// 练手盘的**强平引擎**（每 15 秒扫一遍杠杆仓）同理。src/lib/market-liquidator.ts 里
// 还有一道 `NODE_ENV === 'test'` 的保险，这里是第二道 —— 两道都留着。
//
// ⚠️ 这个变量**不是**「杠杆闸门」：openPosition 问的是 isLiquidationRunning()，
// 而那个函数在测试进程里的默认口径是**放行**（循环本来就不加载，用例要能直接调
// sweepLiquidations 与开杠杆仓）。所以这里置 0 只关掉那个循环，不会让杠杆仓开不了
// —— 想验「引擎没跑 → 拒单」，用 `__setLiquidationRunning(false)` 显式摆布。
process.env.MARKET_LIQUIDATE_MS = '0';

// 行情的**展示缓存**（不是成交价）挂在 globalThis 上，见 src/lib/market-price.ts 的
// 文件头 —— 这么挂是为了让 instrumentation 图与请求图共用同一份。代价是它**跨测试
// 文件也不再天然隔离**：前一个文件留下的热身缓存会让后一个文件里「只打了一次行情源」
// 这类断言静默失真。
//
// 但重置**不放在这里**：setup 顶部 import 真身的 market-price 会在任何测试文件的
// `vi.mock` 之前把它钉进模块图（下面那条强平闸门的教训是同一个机制），而且真正读这份
// 缓存的只有 market-price.test.ts 与 market-stream.test.ts —— 两者各自在 beforeEach
// 里 `__resetPriceCache()`。其余 market 用例把模块替换成替身，不受缓存影响。

// ⚠️ 【这里**不能**替测试打开强平闸门】—— 2026-09 实测踩过一次，别再试第二次。
//
// 强平闸门（market-liquidator 的 isLiquidationRunning）在生产是 **fail-closed** 的：
// 只有引擎真起来了才放行。于是测试进程里默认是「没在跑」，开杠杆仓的用例得自己
// 显式打开。看起来在 setup.ts 里放一行 `__setLiquidationRunning(true)` 最省事 ——
// 但那要 `import { __setLiquidationRunning } from '@/lib/market-liquidator'`，
// 而 **setup 文件在任何测试文件的 `vi.mock` 注册之前就被求值**：
//   setup.ts → market-liquidator → market-price（**真身**，被缓存下来）
// 之后测试文件里 `vi.mock('@/lib/market-price')` 只换掉了「后来者」（测试文件自己与
// market-service 拿到的都是 mock），**market-liquidator 手里那个 fetchQuote 还是真身**
// —— 于是它的取价直接打真实币安。症状极具迷惑性：探针自己调 fetchQuote 拿到 mock 的
// 71999，而引擎内部那次拿到真实价（> 72000）→ 判定「没到线」→ 用例红成
// 「expected 0 to be 1」，看着像强平逻辑坏了。
//   （这与本文件开头那条「vitest 会直接 import src/lib/*，每个测试文件都会起一个后台
//    循环去发真实 HTTP」是同一枚硬币的两面。）
//
// 所以：**开杠杆闸门这件事由每个用到的测试文件在自己的 beforeEach 里显式声明**
// （market-service / market-liquidator / market-trade-api 三处各一行）。显式也正好
// 说明了那个前提是「这个文件在测杠杆」，而不是一个全进程的隐式放行。

// 进程退出时清掉自己的库文件与限频快照，避免 .tmp 堆积
process.on('exit', () => {
  for (const file of [
    TEST_DB,
    `${TEST_DB}-wal`,
    `${TEST_DB}-shm`,
    RATE_LIMIT_SNAPSHOT,
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }
});
