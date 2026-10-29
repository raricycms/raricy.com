-- Prisma schema 无法表达的约束；migration.sql 包含同一段，测试库也必须安装。
CREATE UNIQUE INDEX IF NOT EXISTS "uq_daily_quotes_active_content"
ON "daily_quotes"("content_key") WHERE "status" IN ('pending', 'approved', 'retired');
