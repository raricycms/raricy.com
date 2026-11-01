#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate.mjs —— 数据库迁移 runner（替代历史 CLI 的 `db upgrade`）
//
// 为什么不用 prisma migrate：schema.prisma 头部明确写了「不要对本库跑 prisma
// migrate」——本库 0_init 是从历史库反向生成的基线（Prisma migrate 不认识本库的
// 迁移历史；DateTime 格式陷阱也要避开它的 normalize）。所有 schema
// 改动一律走 prisma/migrations/<n>_<name>/migration.sql 手写 SQL，由本脚本统一应用。
//
// 用法：
//   npm run migrate -- up                 应用所有 pending SQL，随后执行 Reactive 数据阶段
//   npm run migrate -- status             列出 applied / pending（只读）
//   npm run migrate -- mark <name>        标记为已应用（不执行 SQL），用于 baseline
//   npm run migrate -- verify             比对 checksum（只读）
//
// `up` 的完整顺序（结构迁移之后才进入数据阶段）：
//   1. 手写 SQL 结构迁移（本文件）
//   2. Reactive 旧语法正文升级（src/lib/reactive/migrate-v07）
//   3. 历史编译快照回填（src/lib/reactive/backfill）
//   4. 必要时重建公开正文索引（src/lib/public-blog-search）
//
// 数据阶段由 scripts/reactive-migrate-data.ts 在**子进程**里执行：status / verify /
// help 不加载 reactive-md 与编译器，也不需要数据阶段依赖；同时子进程拿到的是本文件
// 解析后的**同一个绝对 DATABASE_URL**，不会因为 cwd / 相对路径不同落到另一个库。
//
// 阶段之间**不是一个大事务**：SQL、正文升级、快照回填、索引重建各自提交。数据阶段
// 失败时本脚本明确报告「结构已完成、数据未完成」，修复后重跑 `up` 会从断点继续
// （正文升级有一次性标记 + 同事务保护；回填与索引重建都是幂等的）。
//
// 跟踪表：自己维护 _raricy_migrations（name PK, applied_at, checksum）。
// 不动 Prisma 自带的 _prisma_migrations（保持 schema.prisma 头部的隔离约束）。
//
// 驱动：SQL 执行走 `prisma db execute`（与生成 client 使用同一套驱动），避免再装
// better-sqlite3 / pg / mysql2。子进程一律用 process.execPath + 参数数组，不拼 shell。
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = path.join(ROOT, 'prisma', 'schema.prisma');
const PRISMA_DIR = path.dirname(SCHEMA_PATH);
const PRISMA_CLI = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const VITE_NODE_CLI = path.join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
const DATA_PHASE_CONFIG = path.join(ROOT, 'scripts', 'reactive-vite.config.ts');
const DATA_PHASE_SCRIPT = path.join(ROOT, 'scripts', 'reactive-migrate-data.ts');
const TABLE_NAME = '_raricy_migrations';

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ── DATABASE_URL 解析 ──────────────────────────────────────────────────────

/**
 * 把 DATABASE_URL 里的相对 SQLite 路径解析成绝对路径。
 *
 * Prisma 解析相对 `file:` 路径时的基点是 **schema.prisma 目录**，不是进程 cwd。
 * 本脚本与子进程必须拿到同一个绝对地址：否则 `file:../instance/...` 在不同 cwd /
 * 不同 Prisma 入口下会指向两个库，而症状只是「迁移成功、数据没变」。
 *
 * 非 file: URL（未来换 Postgres）原样返回。查询串（connection_limit 等）保留。
 */
export function resolveDatabaseUrl(raw, prismaDir = PRISMA_DIR) {
  if (typeof raw !== 'string' || !raw.startsWith('file:')) return raw;
  const rest = raw.slice('file:'.length);
  const queryAt = rest.indexOf('?');
  const rawPath = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const query = queryAt >= 0 ? rest.slice(queryAt) : '';
  if (!rawPath) return raw;

  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // 保留原样：非法百分号编码交给 Prisma 报错，不在这里猜。
  }

  // file:///C:/...（URI 形态）与 file:/C:/...（Windows 绝对路径）都要认。
  if (decoded.startsWith('//')) {
    const restAfterHost = decoded.slice(2);
    if (!/^\/[A-Za-z]:[\\/]/.test(restAfterHost)) return raw; // UNC 路径不自行改写
    decoded = restAfterHost.slice(1);
  }
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) decoded = decoded.slice(1);

  const absolute = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(prismaDir, decoded);
  return `file:${absolute}${query}`;
}

/** 没有显式 DATABASE_URL 时，按 Prisma 的常规习惯补读 `.env`（先 cwd，再仓库根）。 */
function loadDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    const candidates = [...new Set([path.join(process.cwd(), '.env'), path.join(ROOT, '.env')])];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        process.loadEnvFile(file);
      } catch (error) {
        die(red(`错误：读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`));
      }
      if (process.env.DATABASE_URL) break;
    }
  }
  if (!process.env.DATABASE_URL) {
    die(red('错误：DATABASE_URL 未设置（看 .env 或临时 DATABASE_URL=... npm run migrate -- up）'));
  }
  const resolved = resolveDatabaseUrl(process.env.DATABASE_URL);
  // 统一改写成绝对值：本进程、prisma db execute 与数据阶段子进程读同一份。
  process.env.DATABASE_URL = resolved;
  return resolved;
}

// ── 迁移文件枚举 ────────────────────────────────────────────────────────────

/**
 * 排序键：目录名前缀的数字。**不能按字典序排** —— 那样 "10_drop_x" 会排在
 * "1_oauth" 前面（'0' < '_'），10 号迁移先于 9 号执行；若它依赖前序 DDL
 * （如删掉 9 号刚加的列）就会直接失败。无数字前缀的目录排到最后，按名字兜底。
 */
export function migrationSortKey(name) {
  const m = /^(\d+)/.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function listMigrationDirs() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(MIGRATIONS_DIR, n, 'migration.sql')))
    .sort((a, b) => migrationSortKey(a) - migrationSortKey(b) || a.localeCompare(b));
}

function readMigrationSql(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

// ── 跟踪表 ──────────────────────────────────────────────────────────────────

async function ensureTable(prisma) {
  // IF NOT EXISTS 让脚本对空库 / 已建过跟踪表的库都能跑
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TABLE_NAME}" (
      "name" TEXT PRIMARY KEY,
      "applied_at" TEXT NOT NULL,
      "checksum" TEXT NOT NULL
    )
  `);
}

async function getApplied(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT name, applied_at, checksum FROM "${TABLE_NAME}" ORDER BY name`
  );
  return new Map(rows.map((r) => [r.name, { appliedAt: r.applied_at, checksum: r.checksum }]));
}

/**
 * status / verify 是只读命令：**不要顺手建表**。
 * 返回 null 表示跟踪表不存在 —— 这与「表存在但还没有记录」是两件事：
 * verify 对前者不能打印「历史一致」，否则 db push 出来的测试库会被误判成绿色。
 */
async function getAppliedIfTableExists(prisma) {
  try {
    return await getApplied(prisma);
  } catch (error) {
    if (isMissingTrackingTable(error)) return null;
    throw error;
  }
}

function isMissingTrackingTable(error) {
  const message = String(error instanceof Error ? error.message : error);
  return (
    (/no such table/i.test(message) ||
      /does not exist in the current database/i.test(message) ||
      /P2021/.test(message)) &&
    message.includes(TABLE_NAME)
  );
}

async function markApplied(prisma, name, sum) {
  // 用 INSERT ... ON CONFLICT 兼容 SQLite/Postgres（SQLite 3.24+ / Postgres 9.5+）
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${TABLE_NAME}" (name, applied_at, checksum)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET applied_at = excluded.applied_at, checksum = excluded.checksum`,
    name,
    new Date().toISOString(),
    sum
  );
}

// ── SQL 执行 ────────────────────────────────────────────────────────────────

function applySqlFile(name) {
  const file = path.join(MIGRATIONS_DIR, name, 'migration.sql');
  try {
    if (!fs.existsSync(PRISMA_CLI)) {
      die(red(`错误：找不到 Prisma CLI（${PRISMA_CLI}）。先运行 npm ci 与 npx prisma generate。`));
    }
    // process.execPath + 参数数组：不经过 shell，Windows 路径带空格 / 引号也不会被拆开，
    // 且显式 env 保证 DATABASE_URL 与 PrismaClient 用的是同一个地址。
    execFileSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--file', file, '--schema', SCHEMA_PATH], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Prisma / 数据阶段依赖 ───────────────────────────────────────────────────

function prismaHint(error) {
  const message = String(error instanceof Error ? error.message : error);
  if (
    /@prisma\/client/i.test(message) ||
    /did not initialize yet/i.test(message) ||
    /PrismaClientInitializationError/i.test(message)
  ) {
    console.error(yellow('  Prisma Client 不可用：先运行 `npm ci`，再运行 `npx prisma generate`。'));
  }
}

async function createPrisma() {
  try {
    const { PrismaClient } = await import('@prisma/client');
    return new PrismaClient();
  } catch (error) {
    prismaHint(error);
    die(red(`错误：无法加载 Prisma Client：${error instanceof Error ? error.message : String(error)}`));
  }
}

async function assertDatabaseReachable(prisma) {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (error) {
    prismaHint(error);
    die(red(`错误：无法连接数据库：${error instanceof Error ? error.message : String(error)}`));
  }
}

/** 数据阶段依赖必须在**任何 SQL 写库之前**检查；本命令不会隐式安装或生成任何东西。 */
function preflightDataPhase() {
  const required = [
    [PRISMA_CLI, 'Prisma CLI（node_modules/prisma）'],
    [path.join(ROOT, 'node_modules', '.prisma', 'client', 'index.js'), '已生成的 Prisma Client'],
    [VITE_NODE_CLI, 'vite-node（node_modules/vite-node）'],
    [DATA_PHASE_CONFIG, 'Reactive 数据阶段的 vite-node 配置'],
    [DATA_PHASE_SCRIPT, 'Reactive 数据阶段脚本'],
    [path.join(ROOT, 'node_modules', 'reactive-md', 'package.json'), 'reactive-md（精确锁定版本）'],
  ];
  const missing = required.filter(([file]) => !fs.existsSync(file));
  if (missing.length === 0) return;
  console.error(red('错误：Reactive 数据阶段缺少依赖或生成产物，未开始任何数据库写入：'));
  for (const [file, label] of missing) console.error(red(`  - ${label}：${file}`));
  console.error(yellow('  处理：先运行 `npm ci`，再运行 `npx prisma generate`；本命令不会自动安装或联网。'));
  process.exit(1);
}

/** 数据阶段在独立进程里跑；它只认 DATABASE_URL，不读测试运行器的配置。 */
function runDataPhase() {
  const result = spawnSync(
    process.execPath,
    [VITE_NODE_CLI, '--config', DATA_PHASE_CONFIG, DATA_PHASE_SCRIPT],
    {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  if (result.error) {
    console.error(red(`\n错误：无法启动 Reactive 数据阶段：${result.error.message}`));
    return 1;
  }
  if (typeof result.status === 'number') return result.status;
  console.error(red(`\n错误：Reactive 数据阶段被信号终止（${result.signal ?? 'unknown'}）。`));
  return 1;
}

// ── 命令 ────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`用法：npm run migrate -- <命令>

命令：
  up                 应用所有 pending SQL，然后执行 Reactive 数据阶段
                     （旧语法升级 → 快照回填 → 必要时重建公开索引）
  status             列出已应用 / 待应用（只读，不执行数据阶段）
  mark <name>        标记迁移为已应用（不执行 SQL），用于基线（baseline）
  verify             比对已应用的 checksum 与当前文件内容（只读）

环境：
  DATABASE_URL       缺省时读取 cwd/.env 或仓库根 .env；相对 SQLite 路径按
                     prisma/ 目录解析，并改写成绝对路径传给所有子阶段。
  Reactive 数据阶段需要已安装依赖与已生成的 Prisma Client；本命令不会自动安装。

适用场景：
  • 全新部署：直接 \`npm run migrate -- up\`（依次应用 0_init / 1_oauth / ...，
    再完成数据阶段）
  • 存量库（表已经在，只需补记基线）：
      npm run migrate -- mark 0_init    # 标记 0_init 为已应用
      npm run migrate -- up             # 之后只应用新迁移
  • 只想诊断 / 修复某个数据阶段：保留独立的
      npm run reactive:migrate-v07 [-- --apply]
      npm run reactive:backfill [-- --apply]
      npm run search:rebuild
    （正常发布不需要单独跑它们；详见 docs/deploy.md）`);
}

async function cmdUp(prisma) {
  const applied = await getApplied(prisma);
  const all = listMigrationDirs();
  let count = 0;
  for (const name of all) {
    if (applied.has(name)) continue;
    const sql = readMigrationSql(name);
    const sum = checksumOf(sql);
    console.log(`  → 应用 ${name} ...`);
    if (!applySqlFile(name)) {
      die(red(`  ✗ 应用 ${name} 失败，回滚（无事务；如部分应用需手工清理）`), 1);
    }
    await markApplied(prisma, name, sum);
    console.log(green(`  ✓ ${name} 已应用`));
    count++;
  }
  if (count === 0) console.log(yellow('SQL 阶段：没有 pending 迁移，继续执行 Reactive 数据阶段。'));
  else console.log(green(`\nSQL 阶段完成：共应用 ${count} 个迁移。`));

  const dataStatus = runDataPhase();
  if (dataStatus !== 0) {
    console.error(red(`\n✗ 部分完成：SQL 结构迁移已完成，但 Reactive 数据阶段失败（退出码 ${dataStatus}）。`));
    console.error(yellow('  数据阶段尚未全部完成，不要把它当成一次成功迁移。'));
    console.error(yellow('  修复上述阻塞后重跑 `npm run migrate -- up`：已完成的阶段幂等，会从断点继续。'));
    process.exitCode = 1;
    return;
  }
  console.log(green('\n✓ 迁移完成：SQL 结构 + Reactive 数据阶段。'));
}

async function cmdStatus(prisma) {
  const recorded = await getAppliedIfTableExists(prisma);
  const applied = recorded ?? new Map();
  const all = listMigrationDirs();
  if (recorded === null) {
    console.log(`跟踪表：${TABLE_NAME}（尚不存在；该库还没有通过本迁移系统应用过迁移）\n`);
  } else {
    console.log(`跟踪表：${TABLE_NAME}（共 ${applied.size} 条已记录）\n`);
  }
  console.log('Applied:');
  for (const m of all) {
    if (applied.has(m)) console.log(`  ${green('✓')} ${m}  ${applied.get(m).appliedAt}`);
  }
  console.log('\nPending:');
  let pending = 0;
  for (const m of all) {
    if (!applied.has(m)) {
      console.log(`  ${yellow('✗')} ${m}`);
      pending++;
    }
  }
  if (pending === 0) console.log(`  ${green('（无）')}`);
  console.log(`\n提示：status 只读；\`up\` 在 SQL 之后还会执行 Reactive 数据阶段（旧语法升级 / 快照回填 / 索引重建）。`);
}

async function cmdMark(prisma, name) {
  if (!name) die(red('错误：mark 命令需要指定迁移名（例：mark 0_init）'));
  if (!fs.existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'))) {
    die(red(`错误：迁移 ${name} 不存在或没有 migration.sql`));
  }
  const sql = readMigrationSql(name);
  await markApplied(prisma, name, checksumOf(sql));
  console.log(green(`✓ ${name} 已标记为已应用（未执行 SQL）`));
  console.log(yellow('  适用：库内表已经存在（来自其他途径，如从旧库拷贝 / 手跑 SQL），不希望重复执行。'));
}

async function cmdVerify(prisma) {
  const applied = await getAppliedIfTableExists(prisma);
  if (applied === null) {
    console.error(red(`\n跟踪表 ${TABLE_NAME} 不存在：该库从未通过本迁移系统应用过迁移。`));
    console.error(yellow('  这不等于「checksum 一致」。先按 docs/deploy.md 基线化或执行 up。'));
    process.exitCode = 2;
    return;
  }
  let drift = 0;
  for (const [name, rec] of applied) {
    const filePath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!fs.existsSync(filePath)) {
      console.log(red(`  ⚠ ${name}：文件已删除，但跟踪表标记为已应用`));
      drift++;
      continue;
    }
    const sql = readMigrationSql(name);
    const sum = checksumOf(sql);
    if (sum !== rec.checksum) {
      console.log(red(`  ⚠ ${name}：checksum 不一致`));
      console.log(`    跟踪表：${rec.checksum}`);
      console.log(`    当前文件：${sum}`);
      drift++;
    } else {
      console.log(green(`  ✓ ${name}`));
    }
  }
  if (drift === 0) console.log(green('\n所有已应用迁移 checksum 一致。'));
  else die(red(`\n${drift} 个迁移存在漂移`), 2);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (!['up', 'status', 'mark', 'verify'].includes(cmd)) {
    console.error(red(`未知命令：${cmd}\n`));
    usage();
    process.exit(1);
  }
  if (!fs.existsSync(SCHEMA_PATH)) {
    die(red(`错误：找不到 ${SCHEMA_PATH}`));
  }
  loadDatabaseUrl();
  if (cmd === 'up') preflightDataPhase();

  const prisma = await createPrisma();
  try {
    if (cmd === 'up' || cmd === 'mark') {
      await assertDatabaseReachable(prisma);
      await ensureTable(prisma);
    }
    if (cmd === 'up') await cmdUp(prisma);
    else if (cmd === 'status') await cmdStatus(prisma);
    else if (cmd === 'mark') await cmdMark(prisma, process.argv[3]);
    else if (cmd === 'verify') await cmdVerify(prisma);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

/**
 * 判断本文件是否被直接执行（而不是被单测 import）。
 *
 * 必须比较 realpath：部署里常见的 `releases/current → releases/<sha>` 符号链接会让
 * `process.argv[1]`（链接路径）与 `import.meta.url`（Node 已解析的真实路径）文本不等。
 * 只比字符串时 `main()` 根本不执行，进程**零输出退出 0** —— 流水线会把「什么都没跑」
 * 当成迁移成功。
 */
export function isMainModule(invokedPath, modulePath) {
  if (!invokedPath) return false;
  try {
    return fs.realpathSync.native(invokedPath) === fs.realpathSync.native(modulePath);
  } catch {
    const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    return normalize(invokedPath) === normalize(modulePath);
  }
}

if (isMainModule(process.argv[1] ? path.resolve(process.argv[1]) : '', fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    prismaHint(error);
    console.error(red('未捕获异常：'), error);
    process.exit(1);
  });
}
