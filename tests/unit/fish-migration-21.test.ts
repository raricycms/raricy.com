// 迁移 21_fish_units_1e4 的**行为**测试。
//
// 【为什么需要它 —— 在此之前迁移 SQL 是零覆盖的】
// 测试库由 `prisma db push` 从 schema.prisma 生成（见 tests/global-setup.ts），
// 那条路**从不执行 prisma/migrations/** 里的任何 SQL。于是「迁移写错了」在 CI 里
// 是静默的，只会在真库上炸 —— 而真库是原始 SQLAlchemy DDL、`prisma migrate diff`
// 对它永远不会返回空（详见 docs/deploy.md）。
//
// 【为什么在临时库上重建列，而不是用测试库】
// 生产/开发库这五列是 **REAL 亲和**（0_init 里写的是 `"dried_fish" REAL NOT NULL`），
// 而 `db push` 出来的测试库是 **INTEGER 亲和**。迁移动的正是「REAL 列里存整数值」
// 这个具体形态，所以这里照着生产形态重建才有意义。
//
// ⚠️ 这个用例跑的是**迁移文件本身**（读文件、原样执行），不是它的副本 ——
//    改迁移 SQL 会让它跟着变，而不是悄悄脱钩。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 用 createRequire 而不是顶层 `import { DatabaseSync } from 'node:sqlite'`：
// node:sqlite 是实验性内置模块，**比 Vite 的内置列表新** —— 顶层 import 会被 Vite 的
// 解析器剥成裸名 `sqlite` 再去 node_modules 里找，直接报 "Failed to load url sqlite"。
// （试过 ssr.external 与 test.server.deps.external，两条都不管用 —— 那是给 npm 包用的，
// 拦不住内置模块的解析。）运行时 require 走不到 Vite 的静态分析，是这里唯一稳的路子。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const MIGRATION = 'prisma/migrations/21_fish_units_1e4/migration.sql';
const ROOT = path.resolve(import.meta.dirname, '../..');
const SQL = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');

/** 迁移前的标度：这些列在 3_fish_integer_units 之后、21 之前存的是「几个 0.1 鱼干」。 */
const OLD_SCALE = 10;
const NEW_SCALE = 10000;
const RATIO = NEW_SCALE / OLD_SCALE;

let dbPath: string;
// createRequire 取到的是**值**不是类型，所以句柄类型得从它反推（不能直接用 DatabaseSync 当类型）
let db: InstanceType<typeof DatabaseSync>;

/** 按生产形态建库：五列都是 REAL 亲和（payout_units 除外，它照 18 的 DDL 是 INTEGER）。 */
function buildDb(): void {
  db.exec(`
    CREATE TABLE users (
      id TEXT NOT NULL PRIMARY KEY,
      dried_fish REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE fish_transactions (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE blog_feeds (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE market_positions (
      id TEXT NOT NULL PRIMARY KEY,
      stake_units REAL NOT NULL,
      payout_units INTEGER,
      entry_price REAL NOT NULL
    );
    CREATE TABLE _raricy_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);
}

function seed(): void {
  const user = db.prepare('INSERT INTO users (id, dried_fish) VALUES (?, ?)');
  user.run('u1', 2045 * OLD_SCALE); // 普通余额
  user.run('u2', 0); // 零
  user.run('u3', 1); // 最小单位（0.1 条）
  user.run('u4', -3 * OLD_SCALE); // 负数（欠账不该出现，但迁移不该炸）

  const tx = db.prepare('INSERT INTO fish_transactions (user_id, amount) VALUES (?, ?)');
  tx.run('u1', 7 * OLD_SCALE);
  tx.run('u1', -2 * OLD_SCALE); // 支出流水为负
  tx.run('u2', 0);

  db.prepare('INSERT INTO blog_feeds (amount) VALUES (?)').run(5 * OLD_SCALE);

  const pos = db.prepare(
    'INSERT INTO market_positions (id, stake_units, payout_units, entry_price) VALUES (?, ?, ?, ?)'
  );
  pos.run('p-closed', 100 * OLD_SCALE, 1098, 80000); // 已平仓，payout 有值
  pos.run('p-zero', 1 * OLD_SCALE, 0, 80000); // 实发 0
  pos.run('p-open', 20 * OLD_SCALE, null, 80000); // 未平仓，payout 为 NULL
}

/** 快照四张表的全部内容（用于幂等性比对）。 */
function snapshot() {
  const read = (sql: string) => db.prepare(sql).all();
  return {
    users: read('SELECT id, dried_fish FROM users ORDER BY id'),
    tx: read('SELECT id, amount FROM fish_transactions ORDER BY id'),
    feeds: read('SELECT id, amount FROM blog_feeds ORDER BY id'),
    pos: read('SELECT id, stake_units, payout_units FROM market_positions ORDER BY id'),
    guard: read('SELECT name, checksum FROM _raricy_migrations ORDER BY name'),
  };
}

describe('迁移 21_fish_units_1e4', () => {
  let before: ReturnType<typeof snapshot>;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `fish-mig21-${process.pid}-${Date.now()}.db`);
    db = new DatabaseSync(dbPath);
    buildDb();
    seed();

    before = snapshot();
    db.exec(SQL); // ← 迁移在这一步生效，下面全是断言
  });

  afterAll(() => {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const read = (sql: string) => db.prepare(sql).all() as Record<string, number | string | null>[];

  it('users.dried_fish 逐行 ×1000（含零、负数、最小单位）', () => {
    expect(read('SELECT id, dried_fish FROM users ORDER BY id')).toEqual([
      { id: 'u1', dried_fish: 2045 * NEW_SCALE },
      { id: 'u2', dried_fish: 0 },
      { id: 'u3', dried_fish: 1 * RATIO }, // 1 单位 → 1000 单位
      { id: 'u4', dried_fish: -3 * NEW_SCALE },
    ]);
  });

  it('fish_transactions.amount 逐行 ×1000（支出流水为负，ROUND 对负值同样正确）', () => {
    expect(read('SELECT amount FROM fish_transactions ORDER BY id').map((r) => r.amount)).toEqual([
      7 * NEW_SCALE,
      -2 * NEW_SCALE,
      0,
    ]);
  });

  it('blog_feeds.amount 逐行 ×1000', () => {
    expect(read('SELECT amount FROM blog_feeds').map((r) => r.amount)).toEqual([5 * NEW_SCALE]);
  });

  it('market_positions：已平仓 ×1000、实发 0 仍是 0、未平仓的 NULL 保持 NULL', () => {
    expect(read('SELECT id, stake_units, payout_units FROM market_positions ORDER BY id')).toEqual([
      // ⚠️ 别给 payout_units 加 COALESCE(..., 0) —— 那会把未平仓的 NULL 变成 0，
      // 看起来像「已平仓、实发 0」。下面 p-open 这行就是钉那颗钉子的。
      { id: 'p-closed', stake_units: 100 * NEW_SCALE, payout_units: 1098 * RATIO },
      { id: 'p-open', stake_units: 20 * NEW_SCALE, payout_units: null },
      { id: 'p-zero', stake_units: OLD_SCALE * RATIO, payout_units: 0 }, // 种的是 1 单位
    ]);
  });

  it('价格列一个字节都没动（entry_price 不是金额，别顺手「归一化」）', () => {
    for (const r of read('SELECT entry_price FROM market_positions')) {
      expect(r.entry_price).toBe(80000);
    }
  });

  it('哨兵行已写入 _raricy_migrations（checksum 由 migrate.mjs 的 markApplied 随后刷新）', () => {
    const rows = read("SELECT name, checksum FROM _raricy_migrations WHERE name = '21_fish_units_1e4'");
    expect(rows).toHaveLength(1);
    expect(rows[0].checksum).toBe('pending');
  });

  it('★ 重复执行不改任何数（哨兵 + 事务：重跑不会二次翻倍）', () => {
    // 这是本次迁移最要命的风险：相对乘法跑两次就是 ×10^6（users 从 ×1000 变 ×10^6），
    // 而且**不报任何错** —— 只有对账时才会发现撕裂。哨兵行让第二次变成空转。
    const after = snapshot();
    db.exec(SQL);
    db.exec(SQL);
    expect(snapshot()).toEqual(after);
    expect(after.users).not.toEqual(before.users); // 顺带确认第一次**确实**改了东西
  });
});
