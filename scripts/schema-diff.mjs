#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// schema-diff.mjs —— 空库「迁移路径」与「schema.prisma 路径」的机器比对（R3-019）
//
// 用法：node scripts/schema-diff.mjs [--keep] [--fail-on-diff]
//       npm run schema:diff
//
// 【为什么需要】本仓有三条建库路径：
//   A. `npm run migrate -- up`（生产路径：手写 SQL）      ← 本脚本的 A 库
//   B. `prisma db push`（测试/模板路径：从 schema.prisma） ← 本脚本的 B 库
//   C. 生产真库（由迁移历史演进而来、被两者共同描述）
// schema.prisma 与手写迁移目录之间**没有任何机器核对**：`migrate verify` 只比迁移
// 文件 checksum，不比结构。于是「schema 改了、迁移
// 没写」「迁移写了、schema 漂了」「外键 CASCADE 只在迁移里」都只能靠人读。
//
// 本脚本在两份**隔离的空库**上各跑一条路径，然后把结构逐项比对并打印清单：
//   · 表 / 列（类型、NOT NULL、默认值、主键）
//   · 索引（唯一性、列序、partial）
//   · 外键（引用目标、ON DELETE / ON UPDATE）
//   · 触发器 / 视图
// **只报告、不修改任何东西**。两个临时库建在 tests/.tmp（已 gitignore），跑完删除
// （`--keep` 保留以便人工打开）；不读 instance/、不碰生产库、不跑 prisma generate。
//
// 【已知且接受的结构差异（脚本会标成 known，不会当成新问题）】
//   · A 有 `_raricy_migrations` 跟踪表与 FTS5 虚拟表 `public_blog_search`（含影子表）
//     及 39 号迁移建的触发器 —— `db push` 只表达 schema.prisma，天然没有它们；
//   · B 有 Prisma 自己的 `_prisma_migrations`（db push 偶发创建，视版本而定）；
//   · SQLite 亲和/词法差异：迁移里 REAL vs schema Int（刻意，见 21 号迁移说明）、
//     迁移 INTEGER vs schema Boolean、默认值 0/1 vs false/true（语义相同）；
//   · R3-019 已登记的 `blogs.visibility` 列默认 'private' vs 'internal'；
//   · R3-014 已登记的 7 处 ON DELETE CASCADE（迁移）vs 默认 RESTRICT（schema）；
//   · 38 / 43 号迁移的 partial unique index（schema 表达不了）。
// 其余差异一律列在「需要人判读」区，退出码默认 0；加 `--fail-on-diff` 时只要存在
// **非 known** 差异就退出 1，可直接当 CI 门禁用（已知项已从退出码里排除）。
// ⚠️ 现状下 `--fail-on-diff` 仍会为 11 条**存量未登记差异**退出 1：`chat_members` /
//    `chat_messages` 的 6 条外键只在 schema（迁移 4_chat 没建），以及
//    `account_sync_ledger` / `chat_*` 的 5 条 NOT NULL 分叉。它们与 R3-014 的 CASCADE
//    同类，是历史迁移与 schema 的既有分叉，不是本轮引入的；裁决前不要拿本开关当绿门禁，
//    处置方式同 `docs/legacy-constraints.md`（登记为历史约束，或另开迁移补齐）。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE = path.join(ROOT, 'scripts', 'migrate.mjs');
const PRISMA_CLI = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const TMP_ROOT = path.join(ROOT, 'tests', '.tmp');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const FAIL_ON_DIFF = args.includes('--fail-on-diff');

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** 迁移侧独有、且属于「机制产物」的表前缀（不是 schema 漂移）。 */
const KNOWN_MIGRATION_ONLY_TABLES = ['_raricy_migrations', 'public_blog_search'];
const KNOWN_SCHEMA_ONLY_TABLES = ['_prisma_migrations'];

/** 迁移刻意建、而 schema.prisma 表达不了（SQLite partial unique index）的索引。 */
const KNOWN_PARTIAL_UNIQUE_INDEXES = new Map([
  ['uq_daily_quotes_active_content', '38 号迁移的 partial unique，schema 表达不了（R3-019 已登记）'],
  ['uq_admin_action_appeals_pending', '43 号迁移的 partial unique，schema 表达不了（R3-447 已登记）'],
]);

const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');
const MIGRATION_COUNT = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(MIGRATIONS_DIR, d.name, 'migration.sql'))).length;

fs.mkdirSync(TMP_ROOT, { recursive: true });
const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'schema-diff-'));
const MIGRATED_DB = path.join(dir, 'migrated.db');
const PUSHED_DB = path.join(dir, 'pushed.db');

function section(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function run(label, command, commandArgs, databaseUrl) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${databaseUrl}` },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${result.status ?? String(result.signal)}）`);
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
    fail(`无法建立比对基准：${label} 失败。`);
  }
  return result.stdout ?? '';
}

function fail(message) {
  console.error(`\n${message}`);
  if (!KEEP) cleanup();
  process.exit(2);
}

function cleanup() {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

/** 读一库的结构：表 → 列 / 索引 / 外键，外加触发器和视图。 */
function readStructure(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = new Map();
  try {
    const master = db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();

    for (const row of master.filter((r) => r.type === 'table')) {
      const cols = db.prepare(`PRAGMA table_info("${row.name.replaceAll('"', '""')}")`).all().map((c) => ({
        name: c.name,
        type: (c.type ?? '').toUpperCase() || 'BLOB',
        notnull: Number(c.notnull) === 1,
        default: normalizeDefault(c.dflt_value),
        pk: Number(c.pk),
      }));
      const indexList = db.prepare(`PRAGMA index_list("${row.name.replaceAll('"', '""')}")`).all();
      const indexes = indexList.map((idx) => {
        const sql =
          db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('index', idx.name)?.sql ?? null;
        const columns = db
          .prepare(`PRAGMA index_info("${String(idx.name).replaceAll('"', '""')}")`)
          .all()
          .map((c) => c.name ?? `expr:${String(sql ?? '').replace(/\s+/g, ' ')}`);
        return {
          name: idx.name,
          unique: Number(idx.unique) === 1,
          partial: Number(idx.partial) === 1,
          origin: idx.origin,
          columns,
        };
      });
      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list("${row.name.replaceAll('"', '""')}")`)
        .all()
        .map((fk) => ({
          from: fk.from,
          table: fk.table,
          to: fk.to,
          onUpdate: fk.on_update,
          onDelete: fk.on_delete,
        }));
      tables.set(row.name, { columns: cols, indexes, foreignKeys });
    }

    const triggers = master
      .filter((r) => r.type === 'trigger')
      .map((r) => ({ name: r.name, sql: normalizeSql(r.sql) }));
    const views = master.filter((r) => r.type === 'view').map((r) => ({ name: r.name, sql: normalizeSql(r.sql) }));
    return { tables, triggers, views };
  } finally {
    db.close();
  }
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/^\((.*)\)$/s, '$1');
}

function normalizeSql(sql) {
  return String(sql ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffList(left, right) {
  return [
    ...left.filter((item) => !right.includes(item)),
    ...right.filter((item) => !left.includes(item)),
  ];
}

function renderIndex(idx) {
  return `index ${idx.name}(${idx.columns.join(', ')})${idx.unique ? ' UNIQUE' : ''}${idx.partial ? ' PARTIAL' : ''}`;
}

function renderForeignKey(fk) {
  return `FK ${fk.from} → ${fk.table}.${fk.to} ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`;
}

function isKnownTableOnlyInMigrations(name) {
  return KNOWN_MIGRATION_ONLY_TABLES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`));
}

// ── 建两个基准库（互不共享文件）──────────────────────────────────────────────
section('1/3 建库：migrate up（生产路径）');
console.log(`  库：${path.relative(ROOT, MIGRATED_DB)}`);
run('migrate up', process.execPath, [MIGRATE, 'up'], MIGRATED_DB);
console.log(`  ✓ ${MIGRATION_COUNT} 个迁移全部应用`);

section('2/3 建库：prisma db push（schema.prisma 路径）');
console.log(`  库：${path.relative(ROOT, PUSHED_DB)}`);
if (!fs.existsSync(PRISMA_CLI)) {
  fail('找不到 Prisma CLI（node_modules/prisma/build/index.js）。先 npm ci。');
}
run('prisma db push', process.execPath, [PRISMA_CLI, 'db', 'push', '--schema', SCHEMA, '--skip-generate'], PUSHED_DB);
console.log('  ✓ schema.prisma 已落库（未 generate）');

// ── 比对 ─────────────────────────────────────────────────────────────────────
section('3/3 结构比对（A = migrate up，B = db push）');
const migrated = readStructure(MIGRATED_DB);
const pushed = readStructure(PUSHED_DB);

const onlyInA = [...migrated.tables.keys()].filter((name) => !pushed.tables.has(name));
const onlyInB = [...pushed.tables.keys()].filter((name) => !migrated.tables.has(name));

const knownOnlyInA = onlyInA.filter(isKnownTableOnlyInMigrations);
const knownOnlyInB = onlyInB.filter((name) => KNOWN_SCHEMA_ONLY_TABLES.includes(name));
const unexpectedOnlyInA = onlyInA.filter((name) => !knownOnlyInA.includes(name));
const unexpectedOnlyInB = onlyInB.filter((name) => !knownOnlyInB.includes(name));

/** 需要人判读的差异（表级 / 列级 / 索引级 / 外键级 / 触发器 / 视图）。 */
const findings = [];
const knownFindings = [];
const pushFinding = (scope, message) => findings.push({ scope, message });
const pushKnown = (scope, message) => knownFindings.push({ scope, message });

for (const name of unexpectedOnlyInA) pushFinding('表', `只在迁移里有：${name}（schema 里没有这个模型）`);
for (const name of unexpectedOnlyInB) pushFinding('表', `只在 schema 里有：${name}（缺迁移 CREATE TABLE）`);

/** 已登记/可解释的列差异 → 返回原因；否则 null（进「需人判读」）。 */
function knownColumnReason(table, column, kind, migratedValue, schemaValue) {
  const normalized = (value) => String(value).trim().replaceAll("'", '').toLowerCase();
  if (kind === 'type') {
    // schema 写逻辑类型（Int / Boolean），迁移写 SQLite 物理亲和（REAL / INTEGER）。
    // users.dried_fish / blog_feeds.amount / fish_transactions.amount 的 REAL 是刻意
    // （schema 注释与 21 号迁移头部都写了），Boolean 在 SQLite 里就是 INTEGER。
    if (migratedValue === 'REAL' && schemaValue === 'INTEGER') return 'SQLite REAL 亲和 vs schema Int（刻意，见 schema/21 号迁移注释）';
    if (migratedValue === 'INTEGER' && schemaValue === 'BOOLEAN') return 'SQLite 无 BOOLEAN：迁移 INTEGER vs schema Boolean（语义相同）';
    if (migratedValue === 'REAL' && schemaValue === 'REAL') return null;
  }
  if (kind === 'default') {
    const pair = new Set([normalized(migratedValue), normalized(schemaValue)]);
    if (pair.size === 2 && ((pair.has('0') && pair.has('false')) || (pair.has('1') && pair.has('true')))) {
      return '布尔默认值 0/1 vs false/true（SQLite 语义相同）';
    }
    if (table === 'blogs' && column === 'visibility' && pair.has('private') && pair.has('internal')) {
      return 'R3-019 已登记：13 号迁移的列默认 private vs schema internal（当前无插入依赖默认值）';
    }
  }
  return null;
}

for (const [name, aTable] of migrated.tables) {
  const bTable = pushed.tables.get(name);
  if (!bTable) continue;

  const aCols = aTable.columns;
  const bCols = bTable.columns;
  const byNameA = new Map(aCols.map((c) => [c.name, c]));
  const byNameB = new Map(bCols.map((c) => [c.name, c]));
  for (const col of aCols) {
    const other = byNameB.get(col.name);
    if (!other) {
      pushFinding('列', `${name}.${col.name}：迁移里有、schema 里没有（缺 DROP，或 schema 漏写）`);
      continue;
    }
    if (col.type !== other.type) {
      const message = `${name}.${col.name} 类型：迁移 ${col.type} / schema ${other.type}`;
      const reason = knownColumnReason(name, col.name, 'type', col.type, other.type);
      if (reason) pushKnown('列', `${message} —— ${reason}`);
      else pushFinding('列', message);
    }
    if (col.notnull !== other.notnull) {
      pushFinding('列', `${name}.${col.name} NOT NULL：迁移 ${col.notnull} / schema ${other.notnull}`);
    }
    if (col.default !== other.default) {
      const message = `${name}.${col.name} 默认值：迁移 ${String(col.default)} / schema ${String(other.default)}`;
      const reason = knownColumnReason(name, col.name, 'default', col.default, other.default);
      if (reason) pushKnown('列', `${message} —— ${reason}`);
      else pushFinding('列', message);
    }
    if (col.pk !== other.pk) pushFinding('列', `${name}.${col.name} 主键序：迁移 ${col.pk} / schema ${other.pk}`);
  }
  for (const col of bCols) {
    if (!byNameA.has(col.name)) {
      pushFinding('列', `${name}.${col.name}：schema 里有、迁移里没有（缺 ADD COLUMN）`);
    }
  }

  const aIndexes = aTable.indexes.filter((idx) => idx.origin !== 'pk');
  const bIndexes = bTable.indexes.filter((idx) => idx.origin !== 'pk');
  const indexKey = (idx) => JSON.stringify([idx.columns, idx.unique, idx.partial]);
  const aKeys = aIndexes.map(indexKey);
  const bKeys = bIndexes.map(indexKey);
  const onlyIndexesA = aIndexes.filter((idx) => !bKeys.includes(indexKey(idx)));
  const onlyIndexesB = bIndexes.filter((idx) => !aKeys.includes(indexKey(idx)));
  for (const idx of onlyIndexesA) {
    const message = `${name}：只迁移里有 ${renderIndex(idx)}`;
    // 部分唯一索引 schema.prisma 表达不了；只接受登记过的那些（见 KNOWN_PARTIAL_UNIQUE_INDEXES）。
    const knownPartial = KNOWN_PARTIAL_UNIQUE_INDEXES.get(idx.name);
    if (idx.unique && idx.partial && knownPartial) {
      pushKnown('索引', `${message} —— ${knownPartial}`);
    } else {
      pushFinding('索引', message);
    }
  }
  for (const idx of onlyIndexesB) pushFinding('索引', `${name}：只 schema 里有 ${renderIndex(idx)}`);

  // 外键按 (from → table.to) 成对比较：只在一侧 → 真差异；两侧都在但 CASCADE/RESTRICT
  // 不同 → R3-014 已登记（迁移有 7 处 ON DELETE CASCADE，schema 全写默认 RESTRICT）。
  const fkGroups = new Map();
  const groupKey = (fk) => `${fk.from}→${fk.table}.${fk.to}`;
  for (const fk of aTable.foreignKeys) fkGroups.set(groupKey(fk), { ...(fkGroups.get(groupKey(fk)) ?? {}), a: fk });
  for (const fk of bTable.foreignKeys) fkGroups.set(groupKey(fk), { ...(fkGroups.get(groupKey(fk)) ?? {}), b: fk });
  for (const [key, pair] of fkGroups) {
    if (!pair.a) {
      pushFinding('外键', `${name}：只 schema 里有 ${renderForeignKey(pair.b)}（缺迁移外键）`);
      continue;
    }
    if (!pair.b) {
      pushFinding('外键', `${name}：只迁移里有 ${renderForeignKey(pair.a)}（schema 没写）`);
      continue;
    }
    const message = `${name}：${key} ON UPDATE ${pair.a.onUpdate}/${pair.b.onUpdate} ON DELETE ${pair.a.onDelete}/${pair.b.onDelete}（迁移/schema）`;
    const deletePair = new Set([pair.a.onDelete, pair.b.onDelete]);
    if (deletePair.has('CASCADE') && deletePair.has('RESTRICT')) {
      pushKnown('外键', `${message} —— R3-014 已登记：迁移有 CASCADE、schema 写默认 RESTRICT（文档对齐，不动已应用 SQL）`);
    } else if (pair.a.onUpdate !== pair.b.onUpdate || pair.a.onDelete !== pair.b.onDelete) {
      pushFinding('外键', message);
    }
  }
}

const aTriggerNames = migrated.triggers.map((t) => t.name);
const bTriggerNames = pushed.triggers.map((t) => t.name);
for (const name of diffList(aTriggerNames, bTriggerNames)) {
  // 39 号迁移的 FTS 触发器只存在于生产路径；db push 表达不了触发器，属 known。
  if (name.startsWith('public_blog_search')) continue;
  pushFinding('触发器', `触发器只在一侧：${name}`);
}
const aViewNames = migrated.views.map((v) => v.name);
const bViewNames = pushed.views.map((v) => v.name);
for (const name of diffList(aViewNames, bViewNames)) pushFinding('视图', `视图只在一侧：${name}`);

// ── 输出 ─────────────────────────────────────────────────────────────────────
const knownOnlyInAExtra = knownOnlyInA.filter((name) => name.startsWith('public_blog_search'));
console.log(`\n已知差异（机制产物 / 已登记的永久差异，不算新漂移）：`);
console.log(`  · A 独有表 ${[...knownOnlyInA].length} 个：${[...knownOnlyInA].join(', ') || '（无）'}`);
if (knownOnlyInAExtra.length > 0) {
  console.log(`    —— 其中 FTS5 虚拟表/影子表 ${knownOnlyInAExtra.length} 个（39 号迁移建，schema 表达不了）`);
}
if (knownOnlyInB.length > 0) console.log(`  · B 独有表：${knownOnlyInB.join(', ')}`);
if (knownFindings.length > 0) {
  console.log(`  · 列/索引/外键级已知差异 ${knownFindings.length} 条（SQLite 亲和、布尔词法、CASCADE↔RESTRICT、partial unique）；`);
  console.log('    要逐条看可加 `--keep` 后另开，或直接读本脚本的 knownColumnReason / fk 分支。');
}

if (findings.length === 0) {
  console.log('\n✓ 未发现额外结构差异：迁移路径与 schema.prisma 路径一致（不含上述 known 项）。');
} else {
  console.log(`\n需人判读的结构差异 ${findings.length} 条：`);
  for (const group of ['表', '列', '索引', '外键', '触发器', '视图']) {
    const items = findings.filter((f) => f.scope === group);
    if (items.length === 0) continue;
    console.log(`\n[${group}]`);
    for (const item of items) console.log(`  · ${item.message}`);
  }
  console.log('\n判读提示：schema.prisma 是 db push 路径的唯一真相，迁移是生产路径的唯一真相；');
  console.log('两者不一致时要决定「补迁移」还是「改 schema」——本脚本不替你做，也不改任何文件。');
}

const strictFailure = FAIL_ON_DIFF && findings.length > 0;
if (KEEP) {
  console.log(`\n(--keep) 保留两个基准库供人工打开：\n  A=${MIGRATED_DB}\n  B=${PUSHED_DB}`);
} else {
  cleanup();
}
process.exit(strictFailure ? 1 : 0);
