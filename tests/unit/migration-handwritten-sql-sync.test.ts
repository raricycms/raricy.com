// 手写 SQL 与迁移 SQL 的**副本同步**（R3-726）。
//
// 背景：Prisma schema 表达不了 partial unique index / FTS / 触发器，这些 DDL 只能手写。
// 于是迁移 38 出现「两份真相」：`migration.sql` 尾部与 `constraints.sql` 各存一份，
// 而测试库由 `db-constraints.ts` 安装后者、生产由 `migrate` 执行前者 —— 两份漂移时
// 测试库会**静默与生产不同构**，部署时才炸。
//
// 本文件做静态对账（不碰数据库）：`constraints.sql` 必须逐字出现在 `migration.sql` 里。
// 改其中一份时另一份会红，迫使人要么一起改、要么把 constraints 改成从 migration 生成。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MIGRATION_38 = path.join(ROOT, 'prisma', 'migrations', '38_daily_quote_lifecycle');

function readNormalized(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
}

describe('迁移 38 的手写约束与 migration.sql 保持同一份', () => {
  it('constraints.sql 的内容逐字出现在 migration.sql 中', () => {
    const constraints = readNormalized(path.join(MIGRATION_38, 'constraints.sql'));
    const migration = readNormalized(path.join(MIGRATION_38, 'migration.sql'));

    expect(constraints.length, 'constraints.sql 不该是空文件').toBeGreaterThan(0);
    expect(
      migration,
      '38 的两份副本已漂移：constraints.sql（测试库安装的那份）没有逐字出现在 migration.sql 里'
    ).toContain(constraints);
  });

  it('constraints.sql 只包含 schema 无法表达的 DDL（不是整份迁移的复制）', () => {
    const constraints = readNormalized(path.join(MIGRATION_38, 'constraints.sql'));
    // 若有人把整份 migration 抄进来，这里会红 —— 那不是「补约束」，而是制造第三份真相。
    expect(constraints, 'constraints.sql 不该包含事务控制').not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(constraints.length, 'constraints.sql 不应整段复制 migration').toBeLessThan(2000);
  });
});
