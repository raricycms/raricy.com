-- 26_blog_anonymous_comments —— 评论区「匿名发言」。
--
-- 三件事：
--   1. blog_anon_identities —— 「谁在哪篇文章下的化名是几号」的身份分配表；
--   2. blogs.allow_anonymous_comments（默认 true）+ blogs.anon_identity_count（发号器）；
--   3. blog_comments.anon_seq（非空 ⇔ 这条是匿名评论，值 = 化名序号）。
--   4. admin_action_logs.hide_target —— 匿名评论被删时，日志照公示但**当事人不公开**。
--
-- 【身份与存储的口径】`blog_comments.author_id` 仍是**真实**用户，一个字节都不动 ——
--   删除日志的 target_user_id、申诉、限频、作者自删全靠它。匿的是**展示层**：
--   DTO 的 author.id 置空、用户名换成化名、头像换成按化名哈希的 identicon、无头像框。
--   所以本迁移不碰任何存量评论的作者列。
--
-- 【为什么要有序列表，而不是读时现算】「第几个匿名评论的人」是这篇文章的历史事实。
--   现算（按评论时间取第 k 个）会在删评论或作者注销时漂移 —— 同一个人的化名会**无声改名**。
--   表里那一行才是权威；顺序 = 首次匿名评论的先后，一经分配终身不变。
--
-- 【为什么还要一个发号器列】拿 `COUNT(*)` / `MAX(seq)+1` 发号，两个人同时首次匿名评论
--   会撞进同一个号 —— 违反「不同的人在同一篇文章下必然不同号」。用 `increment` 原子自增
--   取号，(blog_id, seq) 唯一索引兜底。
--
-- 【本迁移没有数据变换】四条 ALTER TABLE ADD COLUMN 全带常量默认值，SQLite 会用它填满
--   存量行（存量文章一律「允许匿名评论」、存量评论一律非匿名、存量日志一律不隐藏当事人
--   —— 都是正确的语义）。没有一条 UPDATE，因此不存在「只可执行一次」的顾虑。
--
-- 【形态必须与 prisma db push 生成的一致】测试库由 schema.prisma 经 db push 生成，
--   从不跑本目录。类型映射：Int → INTEGER、Boolean → BOOLEAN、DateTime → DATETIME。
--   ⚠️ 复合唯一约束：Prisma 在 SQLite 上**忽略** `@@unique(..., name:)`，物理索引名是
--   派生名 `<表>_<列...>_key`；本文件照派生名手写（写成 uq_* 就会与 db push 漂移）。
--
-- ── 幂等与崩溃自愈 ──────────────────────────────────────────────────────────
-- ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS（SQLite 不支持），四条语句里任何一条
-- 半途失败都会让重跑撞上 `duplicate column`。所以显式 BEGIN IMMEDIATE 让四条要么全成、
-- 要么全不成（同 21_fish_units_1e4 / 24_drop_fortune_columns 的理由：prisma db execute
-- 把整份脚本当一条命令发送，SQLite 在 autocommit 下**逐条**提交，不是一个事务）。
-- 文件末尾那条哨兵与上面同一事务：COMMIT 之后跟踪行已在库里，下次 migrate up 整份跳过。

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS "blog_anon_identities" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blog_id"    TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    -- 1-based 化名序号：1 = 第一个匿名评论的人（化名见 src/lib/anon-identity.ts）。
    "seq"        INTEGER NOT NULL,
    -- 由应用写 nowForDb()，不在 SQL 里取时间（同全仓口径，见 src/lib/db-time.ts）。
    -- NOT NULL：schema 里 createdAt 是必填（对齐 prisma db push 的形状）。
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "blog_anon_identities_blog_id_fkey" FOREIGN KEY ("blog_id")
        REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blog_anon_identities_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 一个人在一篇文章下只有一个号（重复的匿名评论复用同一行）。
CREATE UNIQUE INDEX IF NOT EXISTS "blog_anon_identities_blog_id_user_id_key"
    ON "blog_anon_identities"("blog_id", "user_id");
-- 一篇文章里一个号只归一个人 —— 发号器偶发重号时在这里当场报错，而不是静默两个人同名。
CREATE UNIQUE INDEX IF NOT EXISTS "blog_anon_identities_blog_id_seq_key"
    ON "blog_anon_identities"("blog_id", "seq");
CREATE INDEX IF NOT EXISTS "ix_blog_anon_identities_blog_id"
    ON "blog_anon_identities"("blog_id");
CREATE INDEX IF NOT EXISTS "ix_blog_anon_identities_user_id"
    ON "blog_anon_identities"("user_id");

ALTER TABLE "blogs" ADD COLUMN "allow_anonymous_comments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "blogs" ADD COLUMN "anon_identity_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "blog_comments" ADD COLUMN "anon_seq" INTEGER;
ALTER TABLE "admin_action_logs" ADD COLUMN "hide_target" BOOLEAN NOT NULL DEFAULT false;

-- 哨兵：与上面几条同一事务。checksum 由 migrate.mjs 的 markApplied 随后 upsert 成真值。
INSERT INTO _raricy_migrations (name, applied_at, checksum)
  SELECT '26_blog_anonymous_comments', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending'
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '26_blog_anonymous_comments');

COMMIT;
