-- 删除 users.notify_chat（聊天通知总开关）。
--
-- 为什么删：聊天消息不再进通知列表（私聊 / 大区 @ 都不再产生通知行，见
-- src/lib/chat-service.ts 的 sendMessage）—— 聊天未读改由顶栏徽标体现
-- （notification-service 的未读数 + chat-service.getChatUnreadSummary）。
-- 开关失去可控制的送达面，遂连同设置页入口一并移除；静音（chat_members.muted_at）
-- 仍然有效：静音会话不计入顶栏徽标。
--
-- 9_chat_prefs 才刚加上这一列，且聊天功能尚未上线（真实库还没有 chat_* 表），
-- 故直接删除、无需数据迁移。DROP COLUMN 无法写成 IF EXISTS，幂等由
-- _raricy_migrations 跟踪表保证（对齐 8_chat_pat 写法）。

ALTER TABLE "users" DROP COLUMN "notify_chat";
