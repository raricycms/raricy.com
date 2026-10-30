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
import crypto from 'node:crypto';
import { TMP_DIR, TEMPLATE_DB, TEMPLATE_HASH, SQLITE_SIDECARS } from './helpers/db-template';
import { CONSTRAINT_SQL_PATH, SEARCH_SQL_PATH, installTestConstraints } from './helpers/db-constraints';

/** 模板库「建好了」的最小体积。真实结构库 800KB+，空文件是 0 字节。 */
const MIN_TEMPLATE_BYTES = 4096;

/** schema 与手写约束共同决定模板；SQL 改变也必须使缓存失效。 */
function schemaHash(): string {
  const schema = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/schema.prisma'));
  return crypto.createHash('sha256').update(schema).update(fs.readFileSync(CONSTRAINT_SQL_PATH)).update(fs.readFileSync(SEARCH_SQL_PATH)).digest('hex');
}

/**
 * 模板库能不能直接复用。
 *
 * 【为什么可以复用】模板只由 schema 与手写约束决定，与业务代码变化无关。
 */
function templateUsable(want: string): boolean {
  try {
    if (fs.statSync(TEMPLATE_DB).size < MIN_TEMPLATE_BYTES) return false;
    return fs.readFileSync(TEMPLATE_HASH, 'utf8').trim() === want;
  } catch {
    return false; // 模板或发布戳缺一个 → 得建
  }
}

/** 删掉本进程可能留下的中间产物（构建中 / 待发布）。 */
function sweepOwnArtifacts() {
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (!/^template\.(db|hash)\./.test(f)) continue;
    const pid = /\.(\d+)$/.exec(f);
    // 只清自己这次留下的；别人的中间产物由它自己的 finally 收。
    if (pid && Number(pid[1]) !== process.pid) continue;
    try {
      fs.rmSync(path.join(TMP_DIR, f), { force: true });
    } catch {
      /* 并发下已被删掉，忽略 */
    }
  }
}

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
 * 【残留风险两类，都靠 STALE_MS 兜底】
 *   1. pid 被复用 —— 旧库的 pid 正好等于某个无关的新进程。
 *   2. EPERM 假阳性 —— pid 表里确实有这个号，但它属于**系统长驻进程**，不是 vitest。
 *      实测这台机器 44 个 test-*.db 里有 25 个栽在这里（最老的躺了一周），
 *      因为「进程存在但不归我管」与「另一个用户的 vitest」从 errno 分不开。
 * 所以 EPERM 不再直接判活，而是退回年龄判断：年轻的不动（保住同机并发那个场景），
 * 超过 STALE_MS 的收掉（否则上面那 25 个永远不会被回收）。
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
        // EPERM = 进程存在但不是我的：可能是另一个用户的 vitest（保留），
        // 也可能是 pid 撞上系统长驻进程（假阳性）。两者分不开 → 退回年龄判断。
        // ESRCH = 已死（回收）。
        alive =
          (e as NodeJS.ErrnoException).code === 'EPERM' &&
          fs.statSync(full).mtimeMs >= cutoff;
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
  sweepOwnArtifacts();

  const want = schemaHash();

  // 【为什么不再无条件重建】旧实现每次启动都 rm + writeFileSync('') + db push。
  // 那个空文件窗口（db push 要 ~3s 才建完表）是**跨进程**可见的，而各测试文件的
  // ensureSchema() 正是 copyFile 这个模板 —— 于是「同时有两个 vitest 进程」时，
  // 后启动的那个会把先启动的那个弄成满屏 `The table main.users does not exist`。
  // 实测确定性复现：A 跑到 12s 时启动 B，A 直接 686 个 DB 错误、124 次采到 size=0
  // 的模板；B 自己全绿。而 A 一个用例都没改。
  //
  // schema 没变就跳过重建，等于把这个窗口从「每次运行」缩到「改过 schema 才出现」，
  // 顺带省掉每次 ~3s 的 prisma CLI 冷启动。
  if (templateUsable(want)) return;

  // 构建到**本进程专属**的临时文件，建完再原子 rename 到 TEMPLATE_DB。
  // 这样 TEMPLATE_DB 任何时刻要么是旧的完整库、要么是新的完整库，永远不会是空文件。
  const staging = `${TEMPLATE_DB}.${process.pid}`;
  try {
    for (const suffix of ['', ...SQLITE_SIDECARS]) {
      fs.rmSync(staging + suffix, { force: true });
    }
    // Windows 的 Prisma 引擎对尚不存在的 SQLite 文件可能只报空的 Schema engine error ——
    // 先建空文件（是 staging 这个临时名，不是 TEMPLATE_DB）。
    fs.writeFileSync(staging, '');

    // execSync 默认走 shell（POSIX /bin/sh、Windows cmd.exe），跨平台都能解析 npx。
    // 命令参数全是固定字面量，无注入面。（同 helpers/db.ts 的既有注解）
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DATABASE_URL: `file:${staging}` },
      stdio: 'pipe',
    });

    installTestConstraints(staging);
    // 伴生文件（-wal/-shm）不能跟着 rename，先落进主库再发布：
    // 直接 rename 主文件时若还有 WAL，副本会缺最新事务。db push 退出后连接已关，
    // 正常没有伴生文件；有的话说明结构已 checkpoint 进主文件，删掉即可。
    for (const suffix of SQLITE_SIDECARS) {
      fs.rmSync(staging + suffix, { force: true });
    }

    // 发布戳**先于**主库写：宁可「哈希新、库旧」被下一次判为不可用再重建，
    // 也不要「库新、哈希旧」这种永远判不出问题的组合。
    fs.writeFileSync(TEMPLATE_HASH, want);
    fs.renameSync(staging, TEMPLATE_DB);
  } finally {
    for (const suffix of ['', ...SQLITE_SIDECARS]) {
      try {
        fs.rmSync(staging + suffix, { force: true });
      } catch {
        /* 已 rename 掉（ENOENT）或被并发删，忽略 */
      }
    }
  }
}
