-- 聊天偏好：静音会话 / 会话隐藏 / 聊天通知总开关。
--
-- 设计要点（见 src/lib/chat-service.ts 的 listChannelsForUser 与
-- src/lib/notification-service.ts 的 sendCoalescedChatNotification）：
--   • chat_members.muted_at —— 非空即该会话静音：不产生通知（铃铛不响），
--     但侧栏未读徽标照常显示（静音 ≠ 已读）。
--   • chat_members.hidden_after_message_id —— 会话隐藏（用户主动「删除会话」）。
--     存「隐藏时的频道最大消息 id」而不是时间戳：判断「隐藏后有没有新消息」只需
--     比较 id（id 全局自增），不需要额外的时间比较，也不受时钟/时区影响。
--     新消息 id 更大 → 会话重新出现在侧栏（微信语义）。
--   • users.notify_chat —— 聊天通知总开关（私聊消息 / 大区 @我）。默认开。
--     这是「账号级」开关，静音是「会话级」，两者独立。
--
-- 三列都可空/有默认值，不需要回填存量数据。
-- 幂等由 _raricy_migrations 跟踪表保证（对齐 5_focus_mode / 8_chat_pat 写法）。

ALTER TABLE "chat_members" ADD COLUMN "muted_at" DATETIME;
ALTER TABLE "chat_members" ADD COLUMN "hidden_after_message_id" INTEGER;
ALTER TABLE "users" ADD COLUMN "notify_chat" BOOLEAN NOT NULL DEFAULT true;
