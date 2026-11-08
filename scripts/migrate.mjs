#!/usr/bin/env node
// 手写 SQL 迁移 runner：只应用 prisma/migrations 的结构变更。
// _raricy_migrations 记录历史与 checksum；不使用 Prisma migrate。
// RMD 源码升级和搜索重建是独立运维操作，不参与 SQL up。
// SQL 子进程与跟踪连接使用同一规范化 DATABASE_URL。

import { execFileSync } from 'node:child_process';
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
  // 统一改写成绝对值：本进程、prisma db execute 与SQL 子进程读同一份。
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

/**
 * 迁移文件是否自带事务（顶格 BEGIN，含 BEGIN IMMEDIATE / TRANSACTION 等变体）。
 *
 * 七个迁移自带：21 / 24 / 25 / 26 / 35 / 38 / 42。它们里有的在事务内写「哨兵」跟踪行，
 * 外面再包一层会变成嵌套 BEGIN 直接报错 —— 所以自带事务的原样交给 `--file`。
 */
function hasOwnTransaction(sql) {
  return /^[ \t]*BEGIN(?:[ \t]+(?:IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION))?[ \t]*;/im.test(sql);
}

/**
 * 执行一条迁移。返回 { ok, transactional }：transactional 表示这次是真的在事务里跑的
 * （runner 包的事务或迁移自带），失败时可以如实说「已回滚」。
 *
 * 【为什么给无 BEGIN 的迁移包一层事务】SQLite 在 autocommit 下逐条提交，而 41 个迁移
 * 里有 27 个是多语句且不带 BEGIN（如 11_comment_attachments 的三条 ALTER）。中途失败
 * 会留下半套结构，而跟踪表没有记录 → 重跑第一条就撞 duplicate column，**永久卡死**。
 * 包 `BEGIN IMMEDIATE … COMMIT` 后，「一个迁移 = 一个事务」成为 runner 的不变量；
 * 已应用 SQL 一个字节都不改，checksum 仍是文件内容的 sha256 前 16。
 */
function applySqlFile(name) {
  const file = path.join(MIGRATIONS_DIR, name, 'migration.sql');
  let own = false;
  try {
    if (!fs.existsSync(PRISMA_CLI)) {
      die(red(`错误：找不到 Prisma CLI（${PRISMA_CLI}）。先运行 npm ci 与 npx prisma generate。`));
    }
    const sql = readMigrationSql(name);
    own = hasOwnTransaction(sql);
    // process.execPath + 参数数组：不经过 shell，Windows 路径带空格 / 引号也不会被拆开，
    // 且显式 env 保证 DATABASE_URL 与 PrismaClient 用的是同一个地址。
    const base = [PRISMA_CLI, 'db', 'execute', '--url', process.env.DATABASE_URL];
    if (own) {
      execFileSync(process.execPath, [...base, '--file', file], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
      });
    } else {
      // `--stdin`：prisma 把整个输入当一条命令发送，SQLite 逐条执行并尊重其中的
      // 显式事务边界（21 号迁移头部有实测记录）。stdio 的 stdin 必须 pipe 才能喂 input；
      // stdout 是 prisma 的「Script executed successfully」，每条迁移都会刷一行噪音，
      // 故只留 stderr（失败原因仍会原样出现在终端）。
      const wrapped = `BEGIN IMMEDIATE;\n${sql}\nCOMMIT;\n`;
      execFileSync(process.execPath, [...base, '--stdin'], {
        input: wrapped,
        stdio: ['pipe', 'ignore', 'inherit'],
        env: process.env,
      });
    }
    return { ok: true, own };
  } catch {
    return { ok: false, own };
  }
}

// ── Prisma 依赖 ───────────────────────────────────────────────────

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

// ── 命令 ────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`用法：npm run migrate -- <命令>

  up                 应用所有 pending 手写 SQL（不编译或改写正文）
  status             只读列出已应用 / 待应用迁移
  mark <name>        标记为已应用，不执行 SQL（用于基线）
  verify             只读校验已应用迁移的 checksum

DATABASE_URL 缺省读 cwd/.env 或仓库根 .env；相对 SQLite 地址按 prisma/ 解析。
先安装依赖并生成 Prisma Client。源码升级使用独立 reactive:migrate-v07；
公开搜索索引修复使用 search:rebuild。两者不作为 SQL 迁移成功的条件。`);
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
    const outcome = applySqlFile(name);
    if (!outcome.ok) {
      // 两种形态都在事务里（runner 包的 / 迁移自带的 BEGIN），失败时连接未提交 → 回滚。
      // 保留「手工清理」的兜底：若有人绕过 up 用 --file 手工跑过同一份 SQL，库可能
      // 已经被部分改过，跟踪表却仍无记录。
      const how = outcome.own ? '迁移自带事务，未提交' : 'runner 包的事务未提交';
      die(
        red(
          `  ✗ 应用 ${name} 失败（${how}）：库应保持迁移前状态。若这是绕过 up 手工执行留下的半套结构，需人工核对后再 mark 或清理（没有自动补偿）`
        ),
        1
      );
    }
    await markApplied(prisma, name, sum);
    console.log(green(`  ✓ ${name} 已应用`));
    count++;
  }
  console.log(green(count === 0 ? '没有待应用的 SQL 迁移。' : `SQL 迁移完成：共应用 ${count} 个迁移。`));
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
  console.log(`\n提示：status 只读；\`up\` 只应用手写 SQL，不升级正文、不写编译快照、不重建公开索引（源码升级用 reactive:migrate-v07，索引修复用 search:rebuild）。`);
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
