-- 评论附件：引用图床图片 + 引用博客（对齐 chat_messages 的 image_id / blog_id 功能）。
--
-- 设计要点（见 src/lib/comment-service.ts 的 attachAttachments / createComment）：
--   • blog_comments.image_id —— 引用的图床图片（images.id）。评论只存引用不存快照，
--     渲染期按当前 ImageHosting 行解析；图被软删 → image_missing 占位。
--   • blog_comments.quote_blog_id —— 被引用博客的 UUID（blogs.id 是 TEXT UUID）。
--     ⚠️ 列名**不是** blog_id：blog_comments.blog_id 早已被「评论所属文章」占用
--     （带物理外键的 blog 关系）。两个语义完全不同，共用一个名字会让「按 blogId 查
--     某篇文章的评论」这类查询变成灾难。故引用博客叫 quote_blog_id。
--   • 两者都**不加物理外键**（与 chat_messages 的 image_id / blog_id 同策略）：
--     图床清理 / 博客软删不该被历史评论行挡住。
--   • 幂等由 _raricy_migrations 跟踪表保证（对齐 7_chat_blog_quote / 8_chat_pat 写法：
--     SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，重复执行会报 duplicate column）。
--
-- 历史评论两个字段均为 NULL —— 界面上等价于「无附件的纯文字评论」，无需回填。

ALTER TABLE "blog_comments" ADD COLUMN "image_id" TEXT;
ALTER TABLE "blog_comments" ADD COLUMN "quote_blog_id" TEXT;
