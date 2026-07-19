#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate.mjs —— 数据库迁移 runner（替代 Flask 时代的 `flask db upgrade`）
//
// 为什么不用 prisma migrate：schema.prisma 头部明确写了「不要对本库跑 prisma
// migrate」——本库 0_init 是从 Flask SQLAlchemy 1:1 抄来的（Prisma migrate 不
// 认识 alembic 迁移历史；DateTime 格式陷阱也要避开它的 normalize）。所有 schema
// 改动一律走 prisma/migrations/<n>_<name>/migration.sql 手写 SQL，由本脚本统一应用。
//
// 用法：
//   npm run migrate -- up                 应用所有 pending 迁移
//   npm run migrate -- status             列出 applied / pending
//   npm run migrate -- mark <name>        标记为已应用（不执行 SQL），用于 baseline
//   npm run migrate -- verify             检查 DB 与文件的一致性（checksum 比对）
//
// 跟踪表：自己维护 _raricy_migrations（name PK, applied_at, checksum）。
// 不动 Prisma 自带的 _prisma_migrations（保持 schema.prisma 头部的隔离约束）。
//
// 驱动复用：SQL 执行走 `npx prisma db execute --file ...`（与 prisma 生成 client
// 用同一套驱动），避免再装 better-sqlite3 / pg / mysql2。
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// 让脚本能直接 import src/lib 的 TS（与 cli.mjs 同套 tsx 解析）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = path.join(ROOT, 'prisma', 'schema.prisma');
const TABLE_NAME = '_raricy_migrations';

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ── 迁移文件枚举 ────────────────────────────────────────────────────────────

function listMigrationDirs() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(MIGRATIONS_DIR, n, 'migration.sql')))
    .sort();
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

// ── SQL 执行（复用 prisma db execute 处理多语句 / 驱动差异） ─────────────────

function applySqlFile(name) {
  const file = path.join(MIGRATIONS_DIR, name, 'migration.sql');
  try {
    execFileSync(
      'npx',
      ['prisma', 'db', 'execute', '--file', file, '--schema', SCHEMA_PATH],
      { stdio: ['ignore', 'inherit', 'inherit'], env: process.env }
    );
    return true;
  } catch (e) {
    return false;
  }
}

// ── 命令 ────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`用法：npm run migrate -- <命令>

命令：
  up                 应用所有 pending 迁移（按 prisma/migrations/ 目录名顺序）
  status             列出已应用 / 待应用
  mark <name>        标记迁移为已应用（不执行 SQL），用于基线（baseline）
  verify             比对已应用的 checksum 与当前文件内容（发现漂移）

适用场景：
  • 全新部署：直接 \`npm run migrate -- up\`（依次应用 0_init / 1_oauth / ...）
  • 从 Flask 切过来的现有库：
      npm run migrate -- mark 0_init    # 标记 0_init 为已应用
      npm run migrate -- up             # 之后只应用新迁移
  • 部署新代码：\`npm run migrate -- status\` 看看有没有 pending`);
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
  if (count === 0) console.log(yellow('没有 pending 迁移。'));
  else console.log(green(`\n共应用 ${count} 个迁移。`));
}

async function cmdStatus(prisma) {
  const applied = await getApplied(prisma);
  const all = listMigrationDirs();
  console.log(`跟踪表：${TABLE_NAME}（共 ${applied.size} 条已记录）\n`);
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
}

async function cmdMark(prisma, name) {
  if (!name) die(red('错误：mark 命令需要指定迁移名（例：mark 0_init）'));
  if (!fs.existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'))) {
    die(red(`错误：迁移 ${name} 不存在或没有 migration.sql`));
  }
  const sql = readMigrationSql(name);
  await markApplied(prisma, name, checksumOf(sql));
  console.log(green(`✓ ${name} 已标记为已应用（未执行 SQL）`));
  console.log(yellow('  适用：库内表已经存在（来自其他途径，如 Flask / 手跑 SQL），不希望重复执行。'));
}

async function cmdVerify(prisma) {
  const applied = await getApplied(prisma);
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

  if (!fs.existsSync(SCHEMA_PATH)) {
    die(red(`错误：找不到 ${SCHEMA_PATH}`));
  }
  if (!process.env.DATABASE_URL) {
    die(red('错误：DATABASE_URL 未设置（看 .env 或临时 DATABASE_URL=... npm run migrate -- up）'));
  }

  const prisma = new PrismaClient();
  try {
    await ensureTable(prisma);
    if (cmd === 'up') await cmdUp(prisma);
    else if (cmd === 'status') await cmdStatus(prisma);
    else if (cmd === 'mark') await cmdMark(prisma, process.argv[3]);
    else if (cmd === 'verify') await cmdVerify(prisma);
    else {
      console.error(red(`未知命令：${cmd}\n`));
      usage();
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(red('未捕获异常：'), e);
  process.exit(1);
});