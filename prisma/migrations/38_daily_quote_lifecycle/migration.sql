-- 社区稿只选登一次；未通过稿件按版本原稿重审。
-- 由迁移跟踪表保证只执行一次。包含归档 / 下架稿的全部历史，不清理旧重复，不修改资金。
BEGIN TRANSACTION;
ALTER TABLE "daily_quotes" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "daily_quotes" ADD COLUMN "first_selected_day" TEXT;
UPDATE "daily_quotes" SET "first_selected_day" = (
  SELECT MIN("day") FROM "daily_quote_editions" WHERE "quote_id" = "daily_quotes"."id"
) WHERE "kind" = 'community';

CREATE TABLE IF NOT EXISTS "daily_quote_revisions" (
  "quote_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_name" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "review_reason" TEXT,
  "reviewer_id" TEXT,
  "reviewed_at" DATETIME,
  "created_at" DATETIME NOT NULL,
  "is_baseline" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("quote_id", "revision"),
  FOREIGN KEY ("quote_id") REFERENCES "daily_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- created_at 是本次捕获基线的本站时间；不假装是早已丢失的版本提交时间。
INSERT INTO "daily_quote_revisions"
  ("quote_id", "revision", "content", "category", "signature", "source_type", "source_name",
   "status", "review_reason", "reviewer_id", "reviewed_at", "created_at", "is_baseline")
SELECT "id", 1, "content", "category", "signature", "source_type", "source_name",
       "status", "review_reason", "reviewer_id", "reviewed_at",
       CAST(strftime('%s', 'now', '+8 hours') AS INTEGER) * 1000, true
FROM "daily_quotes";

DROP INDEX IF EXISTS "daily_quotes_content_key_key";
CREATE INDEX IF NOT EXISTS "ix_daily_quotes_content_key" ON "daily_quotes"("content_key");
-- Prisma schema 无法表达的约束；migration.sql 包含同一段，测试库也必须安装。
CREATE UNIQUE INDEX IF NOT EXISTS "uq_daily_quotes_active_content"
ON "daily_quotes"("content_key") WHERE "status" IN ('pending', 'approved', 'retired');
COMMIT;
