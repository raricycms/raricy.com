// 原样执行迁移 37：db push 生成的测试库根本不会执行 prisma/migrations/**
// 里的任何 SQL，于是「迁移写错了」在 CI 里是看不见的。这里用真 SQLite 内存库
// 先套真实迁移 34 建表，再塞进**含跨日重复**的旧共鸣明细，然后执行 37。
//
// 守三件事：
//   1. 回填每个 (quote_id, user_id) 只有一行、时间取最早那条明细；
//   2. 明细表一行不删、一列不改（旧流水与历史行为的唯一凭据）；
//   3. 重复执行不产生额外身份行（INSERT OR IGNORE），空库也能迁移。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// node:sqlite 比 Vite 的内置模块列表新，运行时 require 避免被解析成 npm 包。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const ROOT = path.resolve(import.meta.dirname, '../..');
const readMigration = (name: string) => fs.readFileSync(path.join(ROOT, 'prisma/migrations', name, 'migration.sql'), 'utf8');
const SQL_34 = readMigration('34_daily_quotes');
const SQL_37 = readMigration('37_daily_quote_resonance_once');

let db: InstanceType<typeof DatabaseSync>;

function newDb() {
  db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT NOT NULL PRIMARY KEY);
    INSERT INTO users VALUES ('u1'), ('u2'), ('archived-user');
  `);
  db.exec(SQL_34);
}

beforeEach(newDb);
afterEach(() => db.close());

const resonances = () =>
  db.prepare('SELECT quote_id, user_id, day, paid_units, created_at FROM daily_quote_resonances ORDER BY quote_id, user_id, day').all();
const once = () =>
  db.prepare('SELECT quote_id, user_id, first_resonated_at FROM daily_quote_resonance_once ORDER BY quote_id, user_id').all();

describe('37_daily_quote_resonance_once（真实迁移 SQL）', () => {
  it('跨日重复明细回填成每人每句一行，时间取最早一条，明细一行不删一列不改', () => {
    db.exec(`
      INSERT INTO daily_quote_resonances (quote_id, user_id, day, paid_units, created_at) VALUES
        ('builtin-001', 'u1', '2026-10-20', 10000, 1792000000000),
        ('builtin-001', 'u1', '2026-10-22', 10000, 1792200000000),
        ('builtin-001', 'u1', '2026-10-25', 0, 1792500000000),
        ('builtin-001', 'u2', '2026-10-21', 10000, 1792100000000),
        ('builtin-002', 'u1', '2026-10-23', 0, 1792300000000),
        ('builtin-002', 'archived-user', '2026-10-23', 0, 1792300000000);
    `);
    const before = resonances();

    db.exec(SQL_37);

    expect(once()).toEqual([
      { quote_id: 'builtin-001', user_id: 'u1', first_resonated_at: 1792000000000 },
      { quote_id: 'builtin-001', user_id: 'u2', first_resonated_at: 1792100000000 },
      { quote_id: 'builtin-002', user_id: 'archived-user', first_resonated_at: 1792300000000 },
      { quote_id: 'builtin-002', user_id: 'u1', first_resonated_at: 1792300000000 },
    ]);
    // 明细原样保留：这是历史行为与历史转账的对应关系，任何「清理重复」都是丢证据。
    expect(resonances()).toEqual(before);
  });

  it('重复执行不新增身份行、不改最早时间；空库同样可迁移', () => {
    db.exec(`INSERT INTO daily_quote_resonances (quote_id, user_id, day, paid_units, created_at)
             VALUES ('builtin-001', 'u1', '2026-10-20', 10000, 1792000000000)`);
    db.exec(SQL_37);
    const first = once();
    expect(first).toHaveLength(1);

    // 新明细出现后再跑一次：既有行不动，只补新组合（幂等 + 可重复执行）。
    db.exec(`INSERT INTO daily_quote_resonances (quote_id, user_id, day, paid_units, created_at)
             VALUES ('builtin-003', 'u2', '2026-10-24', 10000, 1792400000000)`);
    db.exec(SQL_37);
    const second = once();
    expect(second).toHaveLength(2);
    expect(second.find((row) => row.user_id === 'u1')).toEqual(first[0]);
    expect(second.find((row) => row.user_id === 'u2')).toMatchObject({ quote_id: 'builtin-003', first_resonated_at: 1792400000000 });

    db.exec('DELETE FROM daily_quote_resonance_once');
    db.exec('DELETE FROM daily_quote_resonances');
    db.exec(SQL_37);
    expect(once()).toEqual([]);
  });

  it('联合主键保证累计只生效一次，外键拦住孤儿行', () => {
    db.exec(SQL_37);
    db.exec(`INSERT INTO daily_quote_resonance_once (quote_id, user_id, first_resonated_at)
             VALUES ('builtin-001', 'u1', 1792000000000)`);
    expect(() => db.exec(`INSERT INTO daily_quote_resonance_once (quote_id, user_id, first_resonated_at)
             VALUES ('builtin-001', 'u1', 1792100000000)`)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.exec(`INSERT INTO daily_quote_resonance_once (quote_id, user_id, first_resonated_at)
             VALUES ('missing-quote', 'u1', 1792000000000)`)).toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`INSERT INTO daily_quote_resonance_once (quote_id, user_id, first_resonated_at)
             VALUES ('builtin-001', 'missing-user', 1792000000000)`)).toThrow(/FOREIGN KEY/);
  });
});
