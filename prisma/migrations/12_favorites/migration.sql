-- 收藏夹：用户自建的博客收藏夹 + 条目。
--
-- 设计要点（见 src/lib/favorite-service.ts 的文件头「六条不变量」）：
--   • favorites.public_id —— 6 位数字的对外把手，**仅公开收藏夹有值**；私密收藏夹恒为 NULL。
--     「私密收藏夹没有 6 位 id」不是「有 id 但不显示」：没有把手，二维码 / bot / [@id] /
--     复制链接就全都无处可泄，不依赖每个展示点都记得不显示。
--   • favorites.id 用 TEXT UUID（不是自增整数）：所有者管理页 /favorite/mine/<id> 的路由
--     参数就是它，自增整数顺序可枚举 —— 那会把「私密收藏夹不可被他人读」压在「每条路由
--     都记得判所有权」上。UUID 让漏判从越权降级成无害。
--   • 软删除 deleted/deleted_at（对齐 BlogLike），永不物理删。
--   • (favorite_id, blog_id) 唯一 —— 同一个博客可进同一用户的**多个**收藏夹，所以唯一粒度
--     是「收藏夹 × 博客」而不是「用户 × 博客」。
--   • 两个外键都**建物理外键**（与 BlogLike 一致，而不是 chat_messages.image_id 那种
--     「跨域引用不建外键」）：收藏夹属于博客域，且 blogs / users 全站软删，
--     没有「站长硬删挡不住」的问题。测试库由 prisma db push 从 schema.prisma 生成、
--     **会**建出外键，因此这里必须写出对应的 REFERENCES，否则测试库与生产库形态不一致
--     （表现为测试里外键生效、生产上不生效）。
--
-- ⚠️ 排期注意：favorites 引用 users、favorite_items 引用 favorites 与 blogs，
--    所以 tests/helpers/db.ts 的 resetDb() 必须按「先删子表」的顺序列出这三张表。
--
-- 幂等：CREATE TABLE / CREATE INDEX 都带 IF NOT EXISTS。注意 SQLite 的
-- CREATE TABLE IF NOT EXISTS 不会补建已存在表缺失的列，但本迁移只建新表，无此问题。

CREATE TABLE IF NOT EXISTS "favorites" (
    "id"         TEXT    NOT NULL PRIMARY KEY,
    "public_id"  TEXT,
    "user_id"    TEXT    NOT NULL,
    "title"      TEXT    NOT NULL,
    "is_public"  INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME,
    "deleted"    INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "favorite_items" (
    "id"          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "favorite_id" TEXT    NOT NULL,
    "blog_id"     TEXT    NOT NULL,
    "created_at"  DATETIME,
    "deleted"     INTEGER NOT NULL DEFAULT 0,
    "deleted_at"  DATETIME,
    CONSTRAINT "favorite_items_favorite_id_fkey" FOREIGN KEY ("favorite_id")
        REFERENCES "favorites" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "favorite_items_blog_id_fkey" FOREIGN KEY ("blog_id")
        REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- public_id 唯一（SQLite 的 UNIQUE 允许任意多个 NULL → 私密收藏夹可以有任意多行）
CREATE UNIQUE INDEX IF NOT EXISTS "ix_favorites_public_id"
    ON "favorites"("public_id");
CREATE INDEX IF NOT EXISTS "ix_favorites_user_id"
    ON "favorites"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_favorite_item"
    ON "favorite_items"("favorite_id", "blog_id");
CREATE INDEX IF NOT EXISTS "ix_favorite_items_favorite_id"
    ON "favorite_items"("favorite_id");
CREATE INDEX IF NOT EXISTS "ix_favorite_items_blog_id"
    ON "favorite_items"("blog_id");
