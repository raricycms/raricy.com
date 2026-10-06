// 原样执行迁移 27：db push 生成的服务测试库覆盖不到历史仓位补方向这一段。
// 每条用例各建一个内存库，先套真实迁移 18 / 23，再执行一次 27，不接触运行库。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// node:sqlite 比 Vite 的内置模块列表新，运行时 require 避免被解析成 npm 包。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const ROOT = path.resolve(import.meta.dirname, '../..');
const readMigration = (name: string) => fs.readFileSync(path.join(ROOT, 'prisma/migrations', name, 'migration.sql'), 'utf8');
const SQL_18 = readMigration('18_market_positions');
const SQL_23 = readMigration('23_market_leverage');
const SQL_27 = readMigration('27_market_direction');
let db: InstanceType<typeof DatabaseSync>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT NOT NULL PRIMARY KEY, dried_fish INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE fish_transactions (
      id INTEGER NOT NULL PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, type TEXT NOT NULL
    );
    INSERT INTO users VALUES ('historical-user', 999880);
    INSERT INTO fish_transactions VALUES
      (1, 'historical-user', 2000000, 'grant'),
      (2, 'historical-user', -1000000, 'market_buy'),
      (3, 'historical-user', -500000, 'market_buy'),
      (4, 'historical-user', 599880, 'market_sell'),
      (5, 'historical-user', -100000, 'market_buy');
  `);
  db.exec(SQL_18);
  db.exec(SQL_23);
  db.exec(`
    INSERT INTO market_positions (
      id, user_id, symbol, stake_units, entry_price, entry_quote_at, open_tx_id, open_key,
      status, exit_price, exit_quote_at, payout_units, close_tx_id, closed_at, created_at,
      leverage, liquidation_price
    ) VALUES
      ('open', 'historical-user', 'BTCUSDT', 1000000, 80000, '2026-10-06T18:00:00.000Z', 2, 'open-key',
       'open', NULL, NULL, NULL, NULL, NULL, '2026-10-06T18:00:00.000Z', 37, 80000 * (1 - 1.0 / 37)),
      ('closed', 'historical-user', 'BTCUSDT', 500000, 80000, '2026-10-06T18:01:00.000Z', 3, 'closed-key',
       'closed', 96000, '2026-10-06T18:05:00.000Z', 599880, 4, '2026-10-06T18:05:00.000Z',
       '2026-10-06T18:01:00.000Z', 1, 0),
      ('liquidated', 'historical-user', 'BTCUSDT', 100000, 80000, '2026-10-06T18:02:00.000Z', 5, 'liq-key',
       'liquidated', 80000 * (1 - 1.0 / 3), '2026-10-06T18:10:00.000Z', 0, NULL,
       '2026-10-06T18:10:00.000Z', '2026-10-06T18:02:00.000Z', 3, 80000 * (1 - 1.0 / 3));
  `);
});

afterEach(() => db.close());

const positions = () => db.prepare('SELECT * FROM market_positions ORDER BY id').all();
const balance = () => db.prepare('SELECT dried_fish FROM users WHERE id = ?').get('historical-user')?.dried_fish;
const ledgerTotal = () => db.prepare('SELECT SUM(amount) AS total FROM fish_transactions WHERE user_id = ?').get('historical-user')?.total;

describe('27_market_direction（真实迁移 SQL）', () => {
  it('持仓、平仓、爆仓历史行全部补 long，原有每一列与鱼干账目保持原值', () => {
    const beforePositions = positions();
    const beforeUsers = db.prepare('SELECT * FROM users').all();
    const beforeTransactions = db.prepare('SELECT * FROM fish_transactions ORDER BY id').all();
    expect(balance()).toBe(ledgerTotal());

    db.exec(SQL_27);

    const oldColumns = positions().map(({ direction, ...row }) => {
      expect(direction).toBe('long');
      return row;
    });
    expect(oldColumns).toEqual(beforePositions);
    expect(db.prepare('SELECT * FROM users').all()).toEqual(beforeUsers);
    expect(db.prepare('SELECT * FROM fish_transactions ORDER BY id').all()).toEqual(beforeTransactions);
    expect(balance()).toBe(ledgerTotal());
  });

  it('方向列形状正确：新行不传默认 long，显式 short 可写，NULL 被拒', () => {
    db.exec(SQL_27);
    const column = db.prepare('PRAGMA table_info(market_positions)').all().find((row) => row.name === 'direction');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'long'" });
    const insert = db.prepare(`
      INSERT INTO market_positions (id, user_id, symbol, stake_units, entry_price, entry_quote_at, open_key)
      VALUES (?, 'historical-user', 'BTCUSDT', 10000, 80000, '2026-10-06T18:20:00.000Z', ?)
    `);
    insert.run('new-long', 'new-long-key');
    db.exec(`
      INSERT INTO market_positions (id, user_id, symbol, stake_units, entry_price, entry_quote_at, open_key, direction)
      VALUES ('new-short', 'historical-user', 'BTCUSDT', 10000, 80000, '2026-10-06T18:20:00.000Z', 'new-short-key', 'short')
    `);
    expect(db.prepare('SELECT direction FROM market_positions WHERE id = ?').get('new-long')?.direction).toBe('long');
    expect(db.prepare('SELECT direction FROM market_positions WHERE id = ?').get('new-short')?.direction).toBe('short');
    expect(() => db.exec("UPDATE market_positions SET direction = NULL WHERE id = 'new-short'")).toThrow(/NOT NULL/);
  });

  it('迁移保留索引与外键，开仓键去重和用户外键仍生效', () => {
    const indexes = db.prepare('PRAGMA index_list(market_positions)').all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(market_positions)').all();
    expect(indexes).toHaveLength(3);
    expect(foreignKeys).toHaveLength(1);
    db.exec(SQL_27);
    expect(db.prepare('PRAGMA index_list(market_positions)').all()).toEqual(indexes);
    expect(db.prepare('PRAGMA foreign_key_list(market_positions)').all()).toEqual(foreignKeys);
    const insert = db.prepare(`
      INSERT INTO market_positions (id, user_id, symbol, stake_units, entry_price, entry_quote_at, open_key, direction)
      VALUES (?, ?, 'BTCUSDT', 10000, 80000, '2026-10-06T18:20:00.000Z', ?, 'short')
    `);
    expect(() => insert.run('duplicate', 'historical-user', 'open-key')).toThrow(/UNIQUE/);
    expect(() => insert.run('orphan', 'missing-user', 'new-key')).toThrow(/FOREIGN KEY/);
  });
});
