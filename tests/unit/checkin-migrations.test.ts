// 迁移 24_drop_fortune_columns 与 25_rewrite_checkin_descriptions 的**行为**测试。
//
// 【为什么需要它 —— 迁移 SQL 在 CI 里是零覆盖的】测试库由 `prisma db push` 从
// schema.prisma 生成（见 tests/global-setup.ts），那条路**从不执行 prisma/migrations/**
// 里的任何 SQL。于是「迁移写错了」只会在真库上炸，而且这两条都不轻：
//   · 24 是**不可逆**的删列（DROP COLUMN 连 IF EXISTS 都写不出来）；
//   · 25 的判据是一个 LIKE —— 命中不了的历史行**不出声**（SET 0 rows 不报错）。
// 做法与 tests/unit/fish-migration-21.test.ts 同款：把真库的形态照搬到一个临时库上，
// 然后**原样执行迁移文件本身**（不是它的副本 —— 改 SQL 会让它跟着变，不会悄悄脱钩）。
//
// 【为什么不用测试库】那是个 `db push` 出来的库：三列压根不存在，24 一跑就报
// `no such column`。这里要的恰恰是**迁移前**的形态。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 用 createRequire 而不是顶层 `import { DatabaseSync } from 'node:sqlite'`：
// node:sqlite 是实验性内置模块，**比 Vite 的内置列表新** —— 顶层 import 会被 Vite 的
// 解析器剥成裸名 `sqlite` 再去 node_modules 里找，直接报 "Failed to load url sqlite"。
// 运行时 require 走不到 Vite 的静态分析，是这里唯一稳的路子（同 fish-migration-21）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const ROOT = path.resolve(import.meta.dirname, '../..');
const readSql = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SQL_24 = readSql('prisma/migrations/24_drop_fortune_columns/migration.sql');
const SQL_25 = readSql('prisma/migrations/25_rewrite_checkin_descriptions/migration.sql');

/** 旧描述（当年两步式写的），25 要把它改写掉。 */
const LEGACY_DESC = '每日签到（运势值 3）';

let dbPath: string;
let db: InstanceType<typeof DatabaseSync>;

/**
 * 按迁移前的生产形态建库：三列都在，daily_checkins 带两个索引，
 * users 被别的表用外键指着（DROP COLUMN 的父表场景），外加跟踪表。
 */
function buildDb(): void {
  db.exec(`
    CREATE TABLE users (
      id TEXT NOT NULL PRIMARY KEY,
      username TEXT NOT NULL,
      total_fortune INTEGER NOT NULL DEFAULT 0,
      dried_fish INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE blog_comments (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      body TEXT,
      CONSTRAINT blog_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
    );
    CREATE TABLE daily_checkins (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      checkin_date DATETIME NOT NULL,
      created_at DATETIME,
      fortune_value INTEGER,
      fortune_pool TEXT,
      CONSTRAINT daily_checkins_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
    );
    CREATE INDEX ix_daily_checkins_user_id ON daily_checkins(user_id);
    CREATE UNIQUE INDEX daily_checkins_user_id_checkin_date_key ON daily_checkins(user_id, checkin_date);
    CREATE TABLE fish_transactions (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME
    );
    CREATE TABLE _raricy_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);
}

const DAY = new Date('2026-07-15T00:00:00.000Z').getTime();

function seed(): void {
  const user = db.prepare(
    'INSERT INTO users (id, username, total_fortune, dried_fish) VALUES (?, ?, ?, ?)'
  );
  user.run('u1', 'alice', 92, 415000); // 有累计运势值，余额有零头
  user.run('u2', 'bob', 0, 30000);
  user.run('u3', 'carol', 17, 0);

  db.prepare('INSERT INTO blog_comments (user_id, body) VALUES (?, ?)').run('u1', '外键子表');
  db.prepare('INSERT INTO blog_comments (user_id, body) VALUES (?, ?)').run('u3', '外键子表 2');

  const ci = db.prepare(
    `INSERT INTO daily_checkins (user_id, checkin_date, created_at, fortune_value, fortune_pool)
     VALUES (?, ?, ?, ?, ?)`
  );
  ci.run('u1', DAY, DAY + 9 * 3600_000, 3, '3,1,5,2,4'); // 已翻过牌
  ci.run('u2', DAY, DAY + 10 * 3600_000, null, '2,5,1,3,4'); // 已签到未翻牌（历史遗留）
  ci.run('u3', DAY - 86400_000, DAY - 86400_000 + 9 * 3600_000, 5, '5,4,3,2,1');

  const tx = db.prepare(
    'INSERT INTO fish_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  tx.run('u1', 30000, 'checkin', LEGACY_DESC, DAY);
  tx.run('u2', 20000, 'checkin', '每日签到（运势值 2）', DAY); // 另一种数额
  tx.run('u3', 10000, 'checkin', null, DAY); // 描述为空的历史行
  tx.run('u3', 50000, 'checkin', '站长手工补的备注', DAY); // 别人手工写的描述
  tx.run('u1', -10000, 'transfer', '转给 bob', DAY); // 非签到流水
}

/** 只读查询的小包装。 */
const read = (sql: string) => db.prepare(sql).all() as Record<string, number | string | null>[];
const columns = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

/** 四条流水的可观测状态（描述改写只能动 description）。 */
const ledgerRows = () =>
  read('SELECT id, user_id, amount, type, description, created_at FROM fish_transactions ORDER BY id');

describe('迁移 24 + 25（签到「运势值」机制下线）', () => {
  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `checkin-mig-${process.pid}-${Date.now()}.db`);
    db = new DatabaseSync(dbPath);
    // 与生产同款：外键是真的会被检查的（Prisma 连接默认打开）
    db.exec('PRAGMA foreign_keys = ON');
    buildDb();
    seed();
  });

  afterAll(() => {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe('24_drop_fortune_columns', () => {
    let txBefore: ReturnType<typeof ledgerRows>;

    beforeAll(() => {
      txBefore = ledgerRows();
      db.exec(SQL_24); // ← 迁移在这一步生效
    });

    it('三列真的没了', () => {
      expect(columns('users')).not.toContain('total_fortune');
      expect(columns('daily_checkins')).not.toContain('fortune_value');
      expect(columns('daily_checkins')).not.toContain('fortune_pool');
    });

    it('别的列一个都没少（改动只落在三列上）', () => {
      expect(columns('users')).toEqual(['id', 'username', 'dried_fish']);
      expect(columns('daily_checkins')).toEqual([
        'id',
        'user_id',
        'checkin_date',
        'created_at',
      ]);
    });

    it('行数据原样：余额、签到日期、外键子表都不受影响', () => {
      expect(read('SELECT id, dried_fish FROM users ORDER BY id')).toEqual([
        { id: 'u1', dried_fish: 415000 },
        { id: 'u2', dried_fish: 30000 },
        { id: 'u3', dried_fish: 0 },
      ]);
      expect(read('SELECT user_id, checkin_date FROM daily_checkins ORDER BY id')).toEqual([
        { user_id: 'u1', checkin_date: DAY },
        { user_id: 'u2', checkin_date: DAY },
        { user_id: 'u3', checkin_date: DAY - 86400_000 },
      ]);
      // users 是被外键指着的父表 —— 删它一列不该动到子表
      expect(read('SELECT COUNT(*) n FROM blog_comments')).toEqual([{ n: 2 }]);
      // 唯一的非签到流水一个字节都不该变
      expect(ledgerRows().slice(4)).toEqual(txBefore.slice(4));
    });

    it('索引还在（删列不该动它们）', () => {
      const idx = read(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='daily_checkins' ORDER BY name"
      ).map((r) => r.name);
      expect(idx).toEqual([
        'daily_checkins_user_id_checkin_date_key',
        'ix_daily_checkins_user_id',
      ]);
    });

    it('哨兵行已写入 _raricy_migrations（checksum 待 migrate.mjs 刷成真值）', () => {
      // 有了它，「SQL 提交了、跟踪行还没写就崩了」这个窗口能自愈：
      // 下次 `migrate up` 见到这行就整份跳过，不用人工 mark。
      expect(
        read("SELECT name, checksum FROM _raricy_migrations WHERE name = '24_drop_fortune_columns'")
      ).toEqual([{ name: '24_drop_fortune_columns', checksum: 'pending' }]);
    });

    it('★ 重复执行会**响亮地**失败（DROP COLUMN 写不出 IF EXISTS）', () => {
      // 这条钉的是「别手工重跑」这件事本身：文件头写明了恢复路径是
      // `npm run migrate -- mark 24_drop_fortune_columns`，而不是再跑一遍。
      // ⚠️ 失败时 SQLite 会把事务**开着**（不自动回滚），所以这里要显式收尾。
      expect(() => db.exec(SQL_24)).toThrow(/no such column/i);
      db.exec('ROLLBACK');
      // 回滚之后形态没变，仍是「删掉了」的那个库
      expect(columns('users')).not.toContain('total_fortune');
    });
  });

  describe('25_rewrite_checkin_descriptions', () => {
    beforeAll(() => {
      db.exec(SQL_25); // ← 迁移在这一步生效
    });

    it('签到流水的「运势值」描述被统一改写成 每日签到', () => {
      const rows = ledgerRows();
      expect(rows[0].description).toBe('每日签到');
      expect(rows[1].description).toBe('每日签到');
    });

    it('★ 金额与时间戳一个字节都没动（只改描述）', () => {
      expect(ledgerRows().map((r) => [r.amount, r.created_at])).toEqual([
        [30000, DAY],
        [20000, DAY],
        [10000, DAY],
        [50000, DAY],
        [-10000, DAY],
      ]);
    });

    it('不碰别人的流水：非签到行、描述为空的签到行、手工写的描述都原样', () => {
      const rows = ledgerRows();
      expect(rows[2]).toMatchObject({ type: 'checkin', description: null }); // 没描述的，不硬塞
      expect(rows[3]).toMatchObject({ type: 'checkin', description: '站长手工补的备注' });
      expect(rows[4]).toMatchObject({ type: 'transfer', description: '转给 bob' });
    });

    it('★ 天然幂等：再跑一遍不改任何东西（不需要哨兵）', () => {
      const after = ledgerRows();
      db.exec(SQL_25);
      db.exec(SQL_25);
      expect(ledgerRows()).toEqual(after);
    });

    it('库里再没有「运势」字样（这是站长要的结果）', () => {
      expect(
        read("SELECT COUNT(*) n FROM fish_transactions WHERE description LIKE '%运势%'")
      ).toEqual([{ n: 0 }]);
    });
  });
});
