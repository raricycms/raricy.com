import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import classics from '@/data/daily-quote-classics.json';
import { quoteContentKey } from '@/lib/daily-quote-service';
import { QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, quoteLength } from '@/lib/daily-quote';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../../prisma/migrations/34_daily_quotes/migration.sql'), 'utf8');

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
      db.exec(sql);
      const rows = db.prepare('SELECT id,content,content_key,category,source_name,source_url,author_name,status,typeof(created_at) AS time_type FROM daily_quotes ORDER BY id').all();
      expect(rows).toHaveLength(300);
      for (const [i, row] of rows.entries()) expect(row).toMatchObject({
        id: classics[i].id, content: classics[i].content, content_key: classics[i].content_key,
        category: classics[i].category, source_name: classics[i].source,
        source_url: classics[i].source_url, author_name: classics[i].author, status: 'approved', time_type: 'integer',
      });
      db.exec("UPDATE daily_quotes SET status='retired' WHERE id='builtin-001'");
      db.exec(sql);
      expect(db.prepare('SELECT COUNT(*) AS n FROM daily_quotes').get()).toMatchObject({ n: 300 });
      expect(db.prepare("SELECT status FROM daily_quotes WHERE id='builtin-001'").get()).toMatchObject({ status: 'retired' });
      db.exec("INSERT INTO daily_quote_editions VALUES ('2026-10-21','builtin-002',1792540800000)");
      expect(() => db.exec("INSERT INTO daily_quote_editions VALUES ('2026-10-21','builtin-003',1792540800000)")).toThrow();
    } finally { db.close(); }
  });
});
