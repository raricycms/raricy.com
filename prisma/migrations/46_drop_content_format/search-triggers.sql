-- 46 的触发器替换（与 migration.sql 中同一条语句）。
--
-- 【为什么单独一份】tests/helpers/db-constraints.ts 装的是 39 的原始 SQL（含 FTS 表与
-- 五个触发器），而 39 的 public_blog_search_content_update 监听 `content, format`。
-- format 列退役后那条触发器引用不存在的列，任何 blog_contents 写入都会报
-- `no such column: OLD.format`。测试库由 `prisma db push` 建表、再装这份手写 SQL，
-- 所以在这里补一条替换，保证“真实迁移后的结构”与“测试库的结构”一致。
--
-- 语义不变：正文或正文语言变化时撤掉旧的公开检索结果。

DROP TRIGGER IF EXISTS "public_blog_search_content_update";

CREATE TRIGGER "public_blog_search_content_update" AFTER UPDATE OF content, syntax_version ON blog_contents
WHEN OLD.content IS NOT NEW.content OR OLD.syntax_version IS NOT NEW.syntax_version BEGIN
  DELETE FROM public_blog_search WHERE rowid = (SELECT rowid FROM blogs WHERE id = NEW.blog_id);
  DELETE FROM public_blog_search_state WHERE blog_id = NEW.blog_id;
END;
