-- 公开正文索引。逐字符编码为带位置的 FTS 词项，支持中文单字和短语；不存用户引用资源。
-- 历史正文由 npm run search:rebuild 回填，未就绪时页面明确降级为元数据搜索。
CREATE TABLE IF NOT EXISTS public_blog_search_state (blog_id TEXT PRIMARY KEY, version TEXT NOT NULL, body_status TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS public_blog_search USING fts5(
  blog_id UNINDEXED, body UNINDEXED, folded UNINDEXED, tokens, version UNINDEXED, body_status UNINDEXED,
  tokenize='unicode61', detail=full
);
-- 所有写入者（包括 CLI）改变正文、格式、可见性或软删除时，先原子撤掉旧结果。
CREATE TRIGGER IF NOT EXISTS public_blog_search_content_update AFTER UPDATE OF content, format ON blog_contents
WHEN OLD.content IS NOT NEW.content OR OLD.format IS NOT NEW.format BEGIN
  DELETE FROM public_blog_search WHERE rowid = (SELECT rowid FROM blogs WHERE id = NEW.blog_id);
  DELETE FROM public_blog_search_state WHERE blog_id = NEW.blog_id;
END;
CREATE TRIGGER IF NOT EXISTS public_blog_search_blog_update AFTER UPDATE OF visibility, ignore ON blogs
WHEN OLD.visibility IS NOT NEW.visibility OR OLD.ignore IS NOT NEW.ignore BEGIN
  DELETE FROM public_blog_search WHERE rowid = NEW.rowid;
  DELETE FROM public_blog_search_state WHERE blog_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS public_blog_search_blog_delete AFTER DELETE ON blogs BEGIN
  DELETE FROM public_blog_search WHERE rowid = OLD.rowid;
  DELETE FROM public_blog_search_state WHERE blog_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS public_blog_search_content_delete AFTER DELETE ON blog_contents BEGIN
  DELETE FROM public_blog_search WHERE blog_id = OLD.blog_id;
  DELETE FROM public_blog_search_state WHERE blog_id = OLD.blog_id;
END;
CREATE TRIGGER IF NOT EXISTS public_blog_search_content_insert AFTER INSERT ON blog_contents BEGIN
  DELETE FROM public_blog_search WHERE blog_id = NEW.blog_id;
  DELETE FROM public_blog_search_state WHERE blog_id = NEW.blog_id;
END;
