// resetDb 的表清单必须与 schema.prisma 对得上。
//
// 【为什么值得一条静态守卫】`resetDb` 漏一张表**不会报任何错**：它只表现为
// 「上个用例的数据残留」，症状千奇百怪却不指向测试基建（这正是 R3-721 里
// `reactive_source_migrations` 的处境）。而剩余两种失败模式（外键顺序、只读库）
// 现在会直接抛错让用例红，所以「清单缺表」是唯一还会静默的。
//
// 本文件不碰数据库：清单与 schema 是同一份静态事实，对账即可。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RESET_TABLES } from '../helpers/db';
import { constraintSqlPaths } from '../helpers/db-constraints';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

/**
 * schema.prisma 里所有 model 的表名。
 * `@@map("…")` 只出现在 model 上（索引用的是 `map:`，不是 `@@map`），所以直接扫足够。
 */
const SCHEMA_TABLES = [...SCHEMA.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]);

/**
 * 只存在于测试库、不是 Prisma model 的表 —— 由 `tests/helpers/db-constraints.ts`
 * 安装的手写 SQL（迁移 39 的 FTS 虚表与它自己的状态表）创建。
 */
const TEST_ONLY_TABLES = ['public_blog_search', 'public_blog_search_state'];

describe('resetDb 表清单与 schema 对账', () => {
  it('清单本身没有重复项', () => {
    expect(new Set(RESET_TABLES).size).toBe(RESET_TABLES.length);
  });

  it('schema 里的每张表都在清单里（漏一张 = 用例间静默残留）', () => {
    const reset = new Set<string>(RESET_TABLES);
    const missing = SCHEMA_TABLES.filter((table) => !reset.has(table));
    expect(
      missing,
      `resetDb 漏了这些 schema 表（数据会跨用例残留）：${missing.join(', ')}`
    ).toEqual([]);
  });

  it('清单里多出来的只能是被登记的测试专用表', () => {
    const schema = new Set(SCHEMA_TABLES);
    const extra = RESET_TABLES.filter((table) => !schema.has(table));
    expect(
      [...extra].sort(),
      `清单出现既不在 schema、也不在测试专用白名单的表：${extra.join(', ')}`
    ).toEqual([...TEST_ONLY_TABLES].sort());
  });

  it('测试专用表确实由约束脚本创建（白名单不是摆设）', () => {
    const { searchSql } = constraintSqlPaths(ROOT);
    expect(fs.existsSync(searchSql), '约束脚本指向的迁移 39 SQL 不存在').toBe(true);
    const sql = fs.readFileSync(searchSql, 'utf8');
    for (const table of TEST_ONLY_TABLES) {
      expect(sql, `${table} 不在迁移 39 的 SQL 里`).toContain(table);
    }
  });
});
