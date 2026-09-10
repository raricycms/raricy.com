// Vitest 全局准备：整个测试进程只跑一次 `prisma db push`，把空库结构固化成模板。
//
// 【为什么不再每个测试文件 build 一次库】
// 旧实现里 tests/helpers/db.ts 的 ensureSchema() 在每个测试文件首次碰库时
// rm 掉库文件 + 重新 `npx prisma db push`。实测单次 3013ms（worker 内直接计时），
// 其中真正建表只要 453ms，剩下 ~2.5s 全是 prisma CLI 启动 + 引擎加载的开销。
// 39 个测试文件里 22 个要碰库 → 串行跑就是 ~66s（占全量 175s 的 38%）纯粹花在
// 反复搭同一个空库上。开了 fileParallelism 之后更糟：多个 worker 同时拉 prisma
// CLI，CPU 全耗在进程启动上。
//
// 模板化后这笔钱只付一次，各文件改成 fs.copyFile（557KB，<1ms）。
//
// 【为什么可以安全复制】
// 每个测试文件在 tests/setup.ts 里拿到**唯一**的库文件名（pid + 随机串），
// 复制出来的副本天然是一个只有自己用的新文件 —— 无并发写同一 inode 的问题。
// 这正是旧实现注释里担心的那个坑（「服务器手里攥着已删除的 inode」），
// 前提是共享文件名，不是并行本身。

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { TMP_DIR, TEMPLATE_DB, SQLITE_SIDECARS } from './helpers/db-template';

/** 崩溃残留的测试库超过这个年龄就回收（见下方 sweepStale）。 */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 回收上次崩溃残留的测试库文件。
 *
 * 正常路径下 tests/setup.ts 的 exit 钩子会删掉自己的库，但进程被 SIGKILL /
 * 断电时钩子不跑 —— 实测 tests/.tmp 里攒到过 ~600MB 的僵尸 test-*.db。
 *
 * 只删 24h 以上的：同机可能有另一个终端正在跑 vitest（库名带 pid 就是为了支持
 * 这个），误删活跃文件会让对方报 readonly database。
 */
function sweepStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (!/^test-.*\.db/.test(f)) continue;
    const full = path.join(TMP_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      /* 并发下文件可能已被别的进程删掉，忽略 */
    }
  }
}

export default function globalSetup() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  sweepStale();

  for (const suffix of ['', ...SQLITE_SIDECARS]) {
    fs.rmSync(TEMPLATE_DB + suffix, { force: true });
  }

  // execSync 默认走 shell（POSIX /bin/sh、Windows cmd.exe），跨平台都能解析 npx。
  // 命令参数全是固定字面量，无注入面。（同 helpers/db.ts 的既有注解）
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: 'pipe',
  });
}
