-- 博客对外可见性三档：'private' / 'link' / 'public'。
--
-- 'private' = 仅站内 core+ 可见（**这就是本站一直以来的样子**，所以存量文章保持不变）
-- 'link'    = 拿到链接的任何人（含未登录访客）可读；不进 sitemap、不许索引
-- 'public'  = 任何人可读 + 进 sitemap + 允许索引
--
-- 设计要点（见 src/lib/blog-service.ts 文件头的「可见性四条不变量」）：
--   • 只影响**非 core 的查看者**。core+ 在博客域是全读的，压根不看这一列 ——
--     所以这个迁移对站内成员的任何入口都是零行为变化。
--   • 存 TEXT 不存 INTEGER：SQLite 没有 enum（Prisma 在 sqlite provider 上也不支持
--     enum），而本库已有字符串枚举的先例（admin_action_logs.visibility）。再引入
--     一套整数编码等于给「可见性」这一个概念造两种方言。
--   • **刻意不加 CHECK 约束**：schema.prisma 表达不了它，而测试库是由 prisma db push
--     从 schema.prisma 生成的 —— 加下去会让测试库与生产库形态不一致（同 12_favorites
--     头部警告过的那类分歧，表现为「生产拦得住、测试拦不住」）。并且 SQLite 改/删
--     CHECK 要整表重建，而「转型」意味着大概率还会加第四档，那时代价会从一条 ALTER
--     变成一次 12 步重建。取值白名单交给 TS（BLOG_VISIBILITIES + parseVisibility）。
--
-- ★ 存量迁移就是这条 DEFAULT，**没有也不需要 UPDATE 语句** ★
--   ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT <常量> 对既有行返回该默认值，
--   全站存量文章一次性成为 'private'。下一个人来找「把老文章刷成 private 的那条
--   UPDATE」时会扑空 —— 它就是这里。**这个默认值不许改成 'link'/'public'**：
--   那等于把全站私密文章一次放出去。
--
-- NOT NULL 而非可空：谓词必须是全域的，不能留「NULL 算哪一档」的第三态。
--
-- 幂等：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS（重复执行会报 duplicate
-- column），一次性的保证来自 _raricy_migrations 跟踪表（同 11_comment_attachments）。
--
-- 本迁移**不含数据变换**，也没有任何时间戳写入。

ALTER TABLE "blogs" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';

CREATE INDEX IF NOT EXISTS "ix_blogs_visibility" ON "blogs"("visibility");
