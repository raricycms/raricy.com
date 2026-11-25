-- 46_drop_content_format —— 正文格式不再单独存列（正文语言由正文自己决定）。
--
-- 删除项与依据：
--   • blog_contents.format / clip_text.format：'markdown' | 'reactive'。
--     2026-11 起渲染只按源码编译（read-render 没有 format 输入），写入闸门也不再
--     接受调用方「声明」格式 —— 识别出增强语法就按增强语法保存。列因此变成
--     纯冗余：它与 syntax_version 一一对应（非 NULL = reactive），对外的 `format`
--     由 src/lib/content-format.ts 的 contentFormatFromSyntaxVersion 派生。
--   • 对外契约不变：GET 仍回 `format`（派生值），POST/PUT 仍接受该字段但只校验
--     白名单（拼错值照旧 400），不再影响存储。`content_format_mismatch` 这个错误码
--     随之退役 —— 没有「声明的格式」就没有格式不匹配。
--
-- 明确保留：
--   • syntax_version：现在是「正文里有没有增强语法」的唯一存储，同时服务升级审计。
--   • blogs.renderer_override / clipboards.renderer_override：对外 bot 契约字段，
--     退役需产品/文档批次（同 42）。
--
-- ── 回填：DROP 之前先让两列对齐 ───────────────────────────────────────────────
-- 理论上有 format='reactive' 但 syntax_version IS NULL 的行是 0 行（35 起的写闸门
-- 两者同写）；真库若有人手工改过，这里按当前语法版本补上，免得删列后那篇正文
-- 从 reactive 变成 markdown。反向（format='markdown' 且 syntax_version 非 NULL）
-- 不需要处理：派生看 syntax_version，增强语法内容本来就会被识别成 reactive。
--
-- ── 触发器：39 的公开检索失效触发器引用了 format，必须先换掉 ────────────────
-- 39_public_blog_search 的 public_blog_search_content_update 监听
-- `UPDATE OF content, format` 并在 WHEN 里比较 OLD.format —— 列一删就是坏触发器
-- （写入直接报 `no such column: OLD.format`）。所以：先删旧触发器 → 删列 →
-- 按**同一语义**重建，监听 content, syntax_version（格式变化现在只体现为
-- syntax_version 变化）。tests/helpers/db-constraints.ts 装的是同一条语句
-- （46 目录下的 search-triggers.sql）。
--
-- ⚠️ 顺序不能反：SQLite 的 DROP COLUMN 遇到引用该列的触发器会直接失败。
--
-- ── 为什么用 ALTER TABLE … DROP COLUMN（而不是重建表）───────────────────────
-- SQLite 3.35+ 原生支持（Prisma 6 自带 3.46），仓内先例：42_retire_residual /
-- 24_drop_fortune_columns。被删列无索引 / 外键；触发器按上面那一步先换掉。
-- DROP COLUMN 没有 IF EXISTS，**除崩溃恢复外别手工重跑本文件**。
--
-- ── 事务与幂等 ──────────────────────────────────────────────────────────────
-- 触发器替换、回填与删列必须同一事务（自带 BEGIN + 哨兵，理由同 24 / 42）：
-- 半途失败时旧触发器不能已经消失。
--
-- ⚠️ 停服迁移：列一删，旧代码里 `select format` 立刻 `no such column`。

BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS "public_blog_search_content_update";

UPDATE "blog_contents" SET "syntax_version" = 'local-draft-3'
  WHERE "format" = 'reactive' AND "syntax_version" IS NULL;
UPDATE "clip_text" SET "syntax_version" = 'local-draft-3'
  WHERE "format" = 'reactive' AND "syntax_version" IS NULL;

ALTER TABLE "blog_contents" DROP COLUMN "format";
ALTER TABLE "clip_text" DROP COLUMN "format";

CREATE TRIGGER "public_blog_search_content_update" AFTER UPDATE OF content, syntax_version ON blog_contents
WHEN OLD.content IS NOT NEW.content OR OLD.syntax_version IS NOT NEW.syntax_version BEGIN
  DELETE FROM public_blog_search WHERE rowid = (SELECT rowid FROM blogs WHERE id = NEW.blog_id);
  DELETE FROM public_blog_search_state WHERE blog_id = NEW.blog_id;
END;

-- 哨兵：与上面几条同一事务。checksum 由 migrate.mjs 的 markApplied 随后 upsert 成真值。
INSERT INTO _raricy_migrations (name, applied_at, checksum)
  SELECT '46_drop_content_format', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending'
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '46_drop_content_format');

COMMIT;
