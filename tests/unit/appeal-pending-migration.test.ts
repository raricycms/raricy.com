// 迁移 43_appeal_pending_unique —— 隔离临时库上的验证（R3-447）。
//
// 【为什么单独一份】这条迁移只加一个 **partial unique index**（同日志 + 同申诉人只有一条
// pending）。它无法用 Prisma schema 表达，测试库靠 `tests/helpers/db-constraints.ts` 安装
// 同一段 SQL；生产靠 migrate 跑本迁移。这里用内存 SQLite 把迁移 SQL **原样**执行一遍，
// 钉住三件事：
//   1) 重复 pending 插入被拒（原子约束真的生效）；
//   2) 已处置（accepted/rejected）的历史行仍可重复（审计历史不能挡）；
//   3) 上线前预检 SQL 真能数出存量重复（否则「有重复时建索引失败」会让人摸不着头脑）。
//
// 不读生产库、不改已应用迁移；表结构在本文件里按 schema 的最小形状建（只覆盖本索引
// 涉及的列），索引语义与真实表一致。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { constraintSqlPaths } from '../helpers/db-constraints';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const ROOT = path.resolve(import.meta.dirname, '../..');
const MIGRATION_PATH = path.join(
  ROOT,
  'prisma',
  'migrations',
  '43_appeal_pending_unique',
  'migration.sql'
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

/** 上线前只读预检：数出存量重复 pending（本迁移不会自动清理）。 */
const PREFLIGHT_SQL = `
  SELECT log_id, appellant_id, COUNT(*) AS n
    FROM admin_action_appeals
   WHERE status = 'pending'
   GROUP BY log_id, appellant_id
  HAVING n > 1
`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE admin_action_appeals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  DATETIME,
      updated_at  DATETIME,
      log_id      INTEGER NOT NULL,
      appellant_id TEXT   NOT NULL,
      content     TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',
      decision    TEXT,
      decided_by  TEXT,
      decided_at  DATETIME
    );
  `);
  return db;
}

function insert(db: InstanceType<typeof DatabaseSync>, logId: number, appellantId: string, status = 'pending') {
  db.prepare(
    `INSERT INTO admin_action_appeals (log_id, appellant_id, content, status)
     VALUES (?, ?, '申诉内容', ?)`
  ).run(logId, appellantId, status);
}

describe('43_appeal_pending_unique —— 隔离库验证', () => {
  it('迁移 SQL 与测试库安装的是同一份（db-constraints 指向它）', () => {
    const { appealPendingSql } = constraintSqlPaths(ROOT);
    expect(fs.existsSync(appealPendingSql), 'db-constraints 指向的迁移 SQL 不存在').toBe(true);
    expect(fs.readFileSync(appealPendingSql, 'utf8'), '两处安装的必须是同一份 SQL').toBe(
      migrationSql
    );
  });

  it('迁移后：重复 pending 被拒；accepted / rejected 历史行可重复', () => {
    const db = freshDb();
    try {
      db.exec(migrationSql);

      insert(db, 1, 'u1');
      expect(() => insert(db, 1, 'u1'), '同一日志 + 同一申诉人的第二条 pending 必须被拒').toThrow(
        /UNIQUE/
      );
      // 不同申诉人 / 不同日志不受影响
      expect(() => insert(db, 1, 'u2')).not.toThrow();
      expect(() => insert(db, 2, 'u1')).not.toThrow();
      // 已处置的历史行可以有多条（审计历史不能被唯一约束挡掉）
      expect(() => insert(db, 1, 'u1', 'accepted')).not.toThrow();
      expect(() => insert(db, 1, 'u1', 'rejected')).not.toThrow();
      expect(() => insert(db, 1, 'u1', 'rejected')).not.toThrow();
      // pending → accepted 之后再申诉一条 pending：原 pending 已不在，允许
      db.prepare(`UPDATE admin_action_appeals SET status='accepted' WHERE id=1`).run();
      expect(() => insert(db, 1, 'u1')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('迁移可重复执行（IF NOT EXISTS）；预检 SQL 能数出存量重复', () => {
    const db = freshDb();
    try {
      // 先造两条存量重复 pending（模拟历史并发写入、索引尚未建立）
      insert(db, 7, 'u7');
      insert(db, 7, 'u7');
      const dup = db.prepare(PREFLIGHT_SQL).all();
      expect(dup, '预检 SQL 必须数出存量重复（上线前据此决定处置）').toEqual([
        { log_id: 7, appellant_id: 'u7', n: 2 },
      ]);

      // 有存量重复时建唯一索引会响亮失败 —— 这正是「先预检再上线」的理由
      expect(() => db.exec(migrationSql)).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }

    const clean = freshDb();
    try {
      clean.exec(migrationSql);
      expect(() => clean.exec(migrationSql), 'IF NOT EXISTS 让重复执行安全').not.toThrow();
      expect(clean.prepare(PREFLIGHT_SQL).all()).toEqual([]);
    } finally {
      clean.close();
    }
  });
});
