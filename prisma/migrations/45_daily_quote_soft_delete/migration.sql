-- 45_daily_quote_soft_delete —— 管理员删除「审核未通过」投稿的软删标记。
--
-- 只加一列，不改状态、不删版本、不动审计日志：
--   · 删除后行仍然是 `status='rejected'`，因此活动正文条件唯一索引照旧不把它当占位；
--   · 作者「我的投稿」与所有读口按 `deleted_at IS NULL` 过滤；
--   · 管理端「已删除」列表可恢复（置回 NULL），版本与审核历史原样保留。
ALTER TABLE "daily_quotes" ADD COLUMN "deleted_at" DATETIME;
