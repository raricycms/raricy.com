-- 聊天消息引用博客（「引用博客」链接卡）。
--
-- 设计要点（见 src/lib/chat-service.ts 的 attach… 与 sendMessage）：
--   • chat_messages.blog_id —— 被引用博客的 UUID 主键（blogs.id 是 TEXT UUID）。
--   • 与 image_id / reply_to 同策略：业务层解析、不加物理外键 —— 博客软删
--     （blogs.ignore=1）或任何清理都不该被聊天消息行挡住。
--   • 消息只存引用不存快照；渲染时按当前 Blog 行解析，软删后前端显示占位。
--   • 幂等由 _raricy_migrations 跟踪表保证（对齐 5_focus_mode 写法）。

ALTER TABLE "chat_messages" ADD COLUMN "blog_id" TEXT;
