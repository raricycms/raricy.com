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

/** 判定不了归属时的兜底回收线：库名不合规 / pid 已复用，只能按年龄算。 */
const STALE_MS = 24 * 60 * 60 * 1000;

/** test-<pid>-<rand>.db（tests/setup.ts 的 TAG 格式）里取出 pid。 */
function pidOf(file: string): number | null {
  const m = /^test-(\d+)-/.exec(file);
  return m ? Number(m[1]) : null;
}

/**
 * 回收已死进程留下的测试库。
 *
 * 【为什么需要】tests/setup.ts 的 exit 钩子并不可靠 —— 实测跑 2 个测试文件就
 * 漏掉 1 个库（vitest 的 worker 池在子进程上用的是 SIGTERM 硬退出，不保证走到
 * 'exit' 回调）。日积月累：实测 tests/.tmp 攒到过 572 个库 / 309MB，而生成它们的
 * 进程早就没了。
 *
 * 【怎么判死】库名里的 pid 就是建它的进程号 —— 白捡的存活凭据。kill(pid, 0)
 * 探活：ESRCH 说明进程已不存在，文件可回收；EPERM 说明进程在但不归我管，保留。
 *
 * 比按年龄删（mtime 必须 > 24h）精确得多：那个阈值是为了不误删**同机另一个
 * 终端的 vitest**，代价是自己漏出来的库也要躺满 24h。改成探活后，
 * 活跃的那个进程还在 → 不动；死掉的 → 本次启动就收。
 *
 * 残留风险只有一种：pid 被复用（旧库的 pid 正好等于某个无关的新进程）。
 * 概率低，且兜底有 STALE_MS —— 真撞上也只是少收一个文件。
 */
function sweepStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (!/^test-.*\.db/.test(f)) continue;
    const full = path.join(TMP_DIR, f);
    const pid = pidOf(f);

    let alive = false;
    if (pid !== null) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        // EPERM = 进程存在但不是我的（保留）；ESRCH = 已死（回收）。
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }

    try {
      // pid 已死 → 直接收；pid 认不出来 → 退回过期回收
      if (!alive && (pid !== null || fs.statSync(full).mtimeMs < cutoff)) {
        fs.rmSync(full, { force: true });
      }
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
