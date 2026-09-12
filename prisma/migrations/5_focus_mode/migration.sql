-- 专注模式（账号级浏览偏好）
--   • users.focus_mode —— 每用户开关（默认关；登出/游客不受影响）
--   • categories.focus_hidden —— 站长在栏目管理勾选的「专注隐藏」标记
--     （本次只加列，不做任何存量 UPDATE —— 哪些栏目算「干扰源」由站长在
--     /admin/categories 里逐板勾选，代码不写死任何 slug）
-- 列名 snake_case + @map，与既有布尔列一致。

ALTER TABLE "users" ADD COLUMN "focus_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "categories" ADD COLUMN "focus_hidden" BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS "ix_categories_focus_hidden" ON "categories"("focus_hidden");
