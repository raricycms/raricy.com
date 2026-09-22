-- 22_audio_hosting — 音频床落库表。
--
-- 背景：新增「音频床」功能 —— 与图床平行的上传 / 配额 / 软删 / 直链骨架，但**独立计量**
-- （音频有自己的 50MB 池，不吃图片那份）。应用层见 src/lib/audio-upload.ts 与
-- src/lib/audio-service.ts。
--
-- 表结构与 image_hosting 逐字段同构，两处刻意不同：
--   · 没有 chat_messages 的反向关系 —— 音频不开「附件」链路（附件是 image_id 列，
--     不是托管域）。
--   · 限额复用同一张 QUOTA_LIMITS_MB 表，只有聚合独立。
-- id 是**应用层生成**的 10 位 base62（与图床同长），不是数据库自增 —— 靠正文里的
-- `[@音频/<id>]` 前缀与图床区分，见 docs/architecture.md §8「ID 风格」。
--
-- 下面的 DDL 是从 db push 的产物里原样抄出来的（`SELECT sql FROM sqlite_master`），
-- 只加了 IF NOT EXISTS。**别手改列顺序或约束名**：测试库由 db push 建、生产库由本文件建，
-- 两边一旦不一致，CI 全绿而生产坏掉。
--
-- ⚠️ 本迁移**不含数据变换**，也没有任何时间戳写入（created_at 由应用层 nowForDb() 给，
--    schema 里刻意没有 @default(now())）。
--
-- 同步登记：tests/helpers/db.ts 的 resetDb() 要加 'audio_hosting'（加在 users **之前**，
-- 删除是 child-first；漏登记不报错，只表现为数据在用例间残留）。

CREATE TABLE IF NOT EXISTS "audio_hosting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "is_public" BOOLEAN DEFAULT true,
    "ignore" BOOLEAN DEFAULT false,
    CONSTRAINT "audio_hosting_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ix_audio_hosting_author_id" ON "audio_hosting"("author_id");
CREATE INDEX IF NOT EXISTS "ix_audio_hosting_created_at" ON "audio_hosting"("created_at");
CREATE INDEX IF NOT EXISTS "ix_audio_hosting_id" ON "audio_hosting"("id");
CREATE INDEX IF NOT EXISTS "ix_audio_hosting_ignore" ON "audio_hosting"("ignore");
