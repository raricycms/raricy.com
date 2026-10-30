// db push 不安装手写约束与 FTS。Vitest 模板及 e2e 在这里安装同一份 SQL。
import fs from 'node:fs';
import path from 'node:path';

export const CONSTRAINT_SQL_PATH = path.resolve('prisma/migrations/38_daily_quote_lifecycle/constraints.sql');
export const SEARCH_SQL_PATH = path.resolve('prisma/migrations/39_public_blog_search/migration.sql');
export function installTestConstraints(dbPath: string) {
  if (!dbPath.replace(/\\/g, '/').includes('/tests/.tmp/')) throw new Error('拒绝向非测试库安装约束');
  // 直取内置模块，避免 Playwright 的 require/ESM 加载钩子将实验模块当作源码。
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try { db.exec(fs.readFileSync(CONSTRAINT_SQL_PATH, 'utf8')); db.exec(fs.readFileSync(SEARCH_SQL_PATH, 'utf8')); }
  finally { db.close(); }
}
