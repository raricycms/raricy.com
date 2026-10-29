import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const root = path.resolve(import.meta.dirname, '../..');
const sql = (file: string) => fs.readFileSync(path.join(root, 'prisma/migrations', file), 'utf8');
const migration = sql('38_daily_quote_lifecycle/migration.sql');
const constraints = sql('38_daily_quote_lifecycle/constraints.sql');
let db: InstanceType<typeof DatabaseSync>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, archived_at INTEGER, dried_fish INTEGER);
    INSERT INTO users VALUES ('author','core',NULL,20000), ('archived','core',1,10000);
    CREATE TABLE fish_transactions(id INTEGER PRIMARY KEY, amount INTEGER);
    INSERT INTO fish_transactions VALUES(1,20000),(2,10000);`);
  db.exec(sql('34_daily_quotes/migration.sql'));
  db.exec(sql('37_daily_quote_resonance_once/migration.sql'));
});
afterEach(() => db.close());

function add(id: string, status = 'approved', submitter = 'author') {
  db.prepare(`INSERT INTO daily_quotes(id,kind,content,content_key,category,signature,source_type,submitter_id,status,created_at)
    VALUES(?,'community',?,?,'哲思','nickname','original',?,?,1)`).run(id, id, id, submitter, status);
}

describe('38_daily_quote_lifecycle 真实迁移', () => {
  it('全部历史回填最早社区选登，归档与下架不漏；重复期次、共鸣、收藏及资金原样保留', () => {
    add('used'); add('retired', 'retired', 'archived'); add('waiting'); add('rejected', 'rejected');
    db.exec(`INSERT INTO daily_quote_editions VALUES ('2026-01-01','used',1),('2026-06-01','used',2),('2026-10-30','retired',3);
      UPDATE daily_quotes SET review_reason='出处有误',reviewer_id='author',reviewed_at=5 WHERE id='rejected';
      INSERT INTO daily_quote_favorites VALUES ('author','used',8,false,NULL);
      INSERT INTO daily_quote_resonances VALUES ('used','author','2026-01-01',10000,1);
      INSERT INTO daily_quote_resonance_once VALUES ('used','author',1);`);
    const tables = ['daily_quote_editions', 'daily_quote_resonances', 'daily_quote_resonance_once', 'daily_quote_favorites', 'users', 'fish_transactions'];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec(migration);
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
    db.exec(migration);
    add('copy', 'pending');
    db.exec(`UPDATE daily_quotes SET content_key='same' WHERE id='copy'`);
    expect(() => db.exec(`UPDATE daily_quotes SET status='pending' WHERE id='same'`)).toThrow(/UNIQUE/);
    db.exec(`UPDATE daily_quotes SET status='rejected' WHERE id='copy'; UPDATE daily_quotes SET status='pending' WHERE id='same'`);
    expect(() => db.exec(`UPDATE daily_quotes SET content_key='held' WHERE id='same'`)).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO daily_quote_revisions(quote_id,revision,content,category,signature,source_type,created_at)
      VALUES ('same',2,'same','哲思','nickname','original',2)`)).not.toThrow();
  });

  it('空业务库可迁移，模板约束与生产迁移完全相同，条件索引可重复安装', () => {
    expect(migration).toContain(constraints.trim());
    db.exec(migration);
    db.exec(constraints); db.exec(constraints);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE name='uq_daily_quotes_active_content'").get();
    expect(index?.sql).toContain("WHERE \"status\" IN ('pending', 'approved', 'retired')");
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_quotes WHERE first_selected_day IS NOT NULL').get()).toEqual({ n: 0 });
  });
});
