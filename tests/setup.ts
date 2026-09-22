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
import { beforeEach } from 'vitest';
import { __resetPriceCache } from '@/lib/market-price';
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
process.env.RATE_LIMIT_SNAPSHOT_PATH = path.join(TMP_DIR, 'rate-limit-snapshot.json');

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

// 行情的**展示缓存**（不是成交价）挂在 globalThis 上，见 src/lib/market-price.ts 的
// 文件头 —— 这么挂是为了让 instrumentation 图与请求图共用同一份。代价是它**跨测试
// 文件也不再天然隔离**：前一个文件留下的热身缓存会让后一个文件里「只打了一次行情源」
// 这类断言静默失真（用例照旧绿，只是不再验真的东西）。所以每个用例前清一次。
beforeEach(() => {
  __resetPriceCache();
});

// 进程退出时清掉自己的库文件，避免 .tmp 堆积
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TEST_DB + suffix, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }
});
