// db push 不安装手写约束与 FTS。Vitest 模板及 e2e 在这里安装同一份 SQL。
//
// 【为什么 repoRoot 由调用方传进来】本文件同时被两个 runner 加载：
//   · Vitest —— ESM，可用 `import.meta.dirname`；
//   · Playwright 的 global-setup —— 被转成 **CJS** 加载，文件里出现 `import.meta`
//     就是语法错误（"Cannot use 'import.meta' outside a module"）。
// 所以本文件自己不做 dirname 推导：路径锚点由调用方从各自能用的地方算好传进来
// （vitest 侧用 import.meta.dirname、Playwright 侧用 __dirname）。
// 这样同时修掉「相对 cwd 解析」的脆弱性（R3-725），又不把两套 runner 绑在一起。
import fs from 'node:fs';
import path from 'node:path';

const CONSTRAINT_SQL_REL = path.join(
  'prisma',
  'migrations',
  '38_daily_quote_lifecycle',
  'constraints.sql'
);
const SEARCH_SQL_REL = path.join(
  'prisma',
  'migrations',
  '39_public_blog_search',
  'migration.sql'
);
const APPEAL_PENDING_SQL_REL = path.join(
  'prisma',
  'migrations',
  '43_appeal_pending_unique',
  'migration.sql'
);

/** 手写 SQL 的绝对路径（repoRoot = 仓库根）。 */
export function constraintSqlPaths(repoRoot: string): {
  constraintSql: string;
  searchSql: string;
  appealPendingSql: string;
} {
  return {
    constraintSql: path.resolve(repoRoot, CONSTRAINT_SQL_REL),
    searchSql: path.resolve(repoRoot, SEARCH_SQL_REL),
    appealPendingSql: path.resolve(repoRoot, APPEAL_PENDING_SQL_REL),
  };
}

/**
 * 把 db push 表达不了的手写 SQL 装进测试库：
 *   · 38 的 partial unique index（每日一言活动内容）；
 *   · 39 的 FTS/触发器；
 *   · 43 的 pending 申诉 partial unique index（R3-447）。
 */
export function installTestConstraints(dbPath: string, repoRoot: string) {
  if (!dbPath.replace(/\\/g, '/').includes('/tests/.tmp/')) {
    throw new Error('拒绝向非测试库安装约束');
  }
  const { constraintSql, searchSql, appealPendingSql } = constraintSqlPaths(repoRoot);
  // 直取内置模块，避免 Playwright 的 require/ESM 加载钩子将实验模块当作源码。
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(fs.readFileSync(constraintSql, 'utf8'));
    db.exec(fs.readFileSync(searchSql, 'utf8'));
    db.exec(fs.readFileSync(appealPendingSql, 'utf8'));
  } finally {
    db.close();
  }
}
