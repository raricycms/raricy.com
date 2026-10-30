// db push 不安装条件索引。Vitest 模板与兜底建库在这里补齐；e2e 通过 Prisma 执行同一 SQL。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const CONSTRAINT_SQL_PATH = path.resolve('prisma/migrations/38_daily_quote_lifecycle/constraints.sql');
export const SEARCH_SQL_PATH = path.resolve('prisma/migrations/39_public_blog_search/migration.sql');
export function installTestConstraints(dbPath: string) {
  if (!dbPath.replace(/\\/g, '/').includes('/tests/.tmp/')) throw new Error('拒绝向非测试库安装约束');
  const { DatabaseSync } = createRequire(path.resolve('package.json'))('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try { db.exec(fs.readFileSync(CONSTRAINT_SQL_PATH, 'utf8')); db.exec(fs.readFileSync(SEARCH_SQL_PATH, 'utf8')); }
  finally { db.close(); }
}
