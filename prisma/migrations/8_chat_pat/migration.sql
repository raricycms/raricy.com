-- 聊天消息「拍一拍」。
--
-- 设计要点（见 src/lib/chat-service.ts 的 sendMessage / attachImagesAndReplies）：
--   • chat_messages.pat_target_id —— 被拍用户的 id。非空即拍一拍消息：正文/图片/
--     引用博客一律为空，前端渲染为居中灰字系统行「A 拍了拍 B」。
--   • 与 blog_id / image_id 同策略：业务层解析、不加物理外键 —— 用户行若有清理
--     也不该被聊天消息挡住；username 读时解析，不存快照。
--   • 幂等由 _raricy_migrations 跟踪表保证（对齐 7_chat_blog_quote 写法）。

ALTER TABLE "chat_messages" ADD COLUMN "pat_target_id" TEXT;
