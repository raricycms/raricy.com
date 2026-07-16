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
process.env.SECRET_KEY = 'test-secret-key-do-not-use-in-prod';
// NODE_ENV 由 vitest 自动置为 'test'，无需（也不能，@types/node 标了 readonly）在此赋值。

// 账户服务默认不可达 —— 走 dev fallback 分支，用例里需要时再单独 mock
delete process.env.ACCOUNT_SERVICE_INTERNAL_TOKEN;

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
