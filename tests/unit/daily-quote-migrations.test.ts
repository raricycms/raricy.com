// 每日一句的**真实迁移**与经典兜底数据。
//
// db push 生成的测试库不会执行 prisma/migrations/** 里的 SQL，所以「迁移写错了」
// 在 CI 里原本看不见。这里用 node:sqlite 内存库按顺序套真实迁移：
//   34 建表 + 300 条经典 → 37 共鸣身份行回填 → 38 生命周期回填。
// 每条都钉「数据变换真跑一遍」：回填值、历史行原样保留、条件唯一索引可重复安装。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import classics from '@/data/daily-quote-classics.json';
import { quoteContentKey } from '@/lib/daily-quote-service';
import { QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, quoteLength } from '@/lib/daily-quote';

// node:sqlite 比 Vite 的内置模块列表新，运行时 require 避免被解析成 npm 包。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const ROOT = path.resolve(import.meta.dirname, '../..');
const readMigration = (name: string) => fs.readFileSync(path.join(ROOT, 'prisma/migrations', name), 'utf8');
const SQL_34 = readMigration('34_daily_quotes/migration.sql');
const SQL_37 = readMigration('37_daily_quote_resonance_once/migration.sql');
const SQL_38 = readMigration('38_daily_quote_lifecycle/migration.sql');
const CONSTRAINTS_38 = readMigration('38_daily_quote_lifecycle/constraints.sql');

describe('300条经典兜底及实际迁移', () => {
  it('条目不重复、不超50字，逐条保存作者与原文来源', () => {
    expect(classics).toHaveLength(300);
    expect(new Set(classics.map((quote) => quote.content_key)).size).toBe(300);
    expect(new Set(classics.map((quote) => quote.id)).size).toBe(300);
    for (const quote of classics) {
      expect(quoteLength(quote.content)).toBeLessThanOrEqual(QUOTE_CONTENT_MAX);
      expect(quoteLength(quote.content)).toBeGreaterThan(0);
      expect(quote.content_key).toBe(quoteContentKey(quote.content));
      expect(QUOTE_CATEGORIES).toContain(quote.category);
      expect(quote.author).toBeTruthy(); expect(quote.source).toBeTruthy();
      expect(new URL(quote.source_url).hostname).toBe('zh.wikisource.org');
    }
  });

  it('手写SQL可在旧库上执行；与目录一致；重放不会覆盖审核或重复插入', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users (id TEXT PRIMARY KEY);');
      db.exec(SQL_34);
      const rows = db.prepare('SELECT id,content,content_key,category,source_name,source_url,author_name,status,typeof(created_at) AS time_type FROM daily_quotes ORDER BY id').all();
      expect(rows).toHaveLength(300);
      for (const [i, row] of rows.entries()) expect(row).toMatchObject({
        id: classics[i].id, content: classics[i].content, content_key: classics[i].content_key,
        category: classics[i].category, source_name: classics[i].source,
        source_url: classics[i].source_url, author_name: classics[i].author, status: 'approved', time_type: 'integer',
      });
      db.exec("UPDATE daily_quotes SET status='retired' WHERE id='builtin-001'");
      db.exec(SQL_34);
      expect(db.prepare('SELECT COUNT(*) AS n FROM daily_quotes').get()).toMatchObject({ n: 300 });
      expect(db.prepare("SELECT status FROM daily_quotes WHERE id='builtin-001'").get()).toMatchObject({ status: 'retired' });
      db.exec("INSERT INTO daily_quote_editions VALUES ('2026-10-21','builtin-002',1792540800000)");
      expect(() => db.exec("INSERT INTO daily_quote_editions VALUES ('2026-10-21','builtin-003',1792540800000)")).toThrow();
    } finally { db.close(); }
  });
});

describe('37_daily_quote_resonance_once（真实迁移 SQL）', () => {
  // 守三件事：
  //   1. 回填每个 (quote_id, user_id) 只有一行、时间取最早那条明细；
  //   2. 明细表一行不删、一列不改（旧流水与历史行为的唯一凭据）；
  //   3. 重复执行不产生额外身份行（INSERT OR IGNORE），空库也能迁移。
  let db: InstanceType<typeof DatabaseSync>;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT NOT NULL PRIMARY KEY);
      INSERT INTO users VALUES ('u1'), ('u2'), ('archived-user');
    `);
    db.exec(SQL_34);
  });
  afterEach(() => db.close());

  const resonances = () =>
    db.prepare('SELECT quote_id, user_id, day, paid_units, created_at FROM daily_quote_resonances ORDER BY quote_id, user_id, day').all();
  const once = () =>
    db.prepare('SELECT quote_id, user_id, first_resonated_at FROM daily_quote_resonance_once ORDER BY quote_id, user_id').all();

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

describe('38_daily_quote_lifecycle 真实迁移', () => {
  let db: InstanceType<typeof DatabaseSync>;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, archived_at INTEGER, dried_fish INTEGER);
      INSERT INTO users VALUES ('author','core',NULL,20000), ('archived','core',1,10000);
      CREATE TABLE fish_transactions(id INTEGER PRIMARY KEY, amount INTEGER);
      INSERT INTO fish_transactions VALUES(1,20000),(2,10000);`);
    db.exec(SQL_34);
    db.exec(SQL_37);
  });
  afterEach(() => db.close());

  function add(id: string, status = 'approved', submitter = 'author') {
    db.prepare(`INSERT INTO daily_quotes(id,kind,content,content_key,category,signature,source_type,submitter_id,status,created_at)
      VALUES(?,'community',?,?,'哲思','nickname','original',?,?,1)`).run(id, id, id, submitter, status);
  }

  it('全部历史回填最早社区选登，归档与下架不漏；重复期次、共鸣、收藏及资金原样保留', () => {
    add('used'); add('retired', 'retired', 'archived'); add('waiting'); add('rejected', 'rejected');
    db.exec(`INSERT INTO daily_quote_editions VALUES ('2026-01-01','used',1),('2026-06-01','used',2),('2026-10-30','retired',3);
      UPDATE daily_quotes SET review_reason='出处有误',reviewer_id='author',reviewed_at=5 WHERE id='rejected';
      INSERT INTO daily_quote_favorites VALUES ('author','used',8,false,NULL);
      INSERT INTO daily_quote_resonances VALUES ('used','author','2026-01-01',10000,1);
      INSERT INTO daily_quote_resonance_once VALUES ('used','author',1);`);
    const tables = ['daily_quote_editions', 'daily_quote_resonances', 'daily_quote_resonance_once', 'daily_quote_favorites', 'users', 'fish_transactions'];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec(SQL_38);
    expect(db.prepare('SELECT id,first_selected_day FROM daily_quotes WHERE kind=\'community\' ORDER BY id').all()).toEqual([
      { id: 'rejected', first_selected_day: null }, { id: 'retired', first_selected_day: '2026-10-30' },
      { id: 'used', first_selected_day: '2026-01-01' }, { id: 'waiting', first_selected_day: null },
    ]);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare('SELECT content,status,review_reason,reviewed_at,is_baseline FROM daily_quote_revisions WHERE quote_id=\'rejected\'').get())
      .toEqual({ content: 'rejected', status: 'rejected', review_reason: '出处有误', reviewed_at: 5, is_baseline: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_quote_revisions').get()).toEqual({ n: 304 });
  });

  it('拒稿不永久占位，活动与下架正文由条件唯一索引保护；快照不占名额', () => {
    add('same', 'rejected'); add('held', 'retired');
    db.exec(SQL_38);
    add('copy', 'pending');
    db.exec(`UPDATE daily_quotes SET content_key='same' WHERE id='copy'`);
    expect(() => db.exec(`UPDATE daily_quotes SET status='pending' WHERE id='same'`)).toThrow(/UNIQUE/);
    db.exec(`UPDATE daily_quotes SET status='rejected' WHERE id='copy'; UPDATE daily_quotes SET status='pending' WHERE id='same'`);
    expect(() => db.exec(`UPDATE daily_quotes SET content_key='held' WHERE id='same'`)).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO daily_quote_revisions(quote_id,revision,content,category,signature,source_type,created_at)
      VALUES ('same',2,'same','哲思','nickname','original',2)`)).not.toThrow();
  });

  it('空业务库可迁移，模板约束与生产迁移完全相同，条件索引可重复安装', () => {
    db.exec(SQL_38);
    db.exec(CONSTRAINTS_38); db.exec(CONSTRAINTS_38);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE name='uq_daily_quotes_active_content'").get();
    expect(index?.sql).toContain("WHERE \"status\" IN ('pending', 'approved', 'retired')");
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_quotes WHERE first_selected_day IS NOT NULL').get()).toEqual({ n: 0 });
  });
});
