-- 在线聊天区：频道 / 成员（读游标）/ 消息。
--
-- 设计要点（见 src/lib/chat-service.ts）：
--   • chat_channels.kind = 'lobby'（全局「聊天大区」，固定 id='lobby'，迁移时种子化）
--                       | 'direct'（1 对 1 私聊，双方成员行在建频道时创建）
--   • chat_members.last_read_message_id 是读游标：未读数 = 该频道内 id > 游标 且未软删的消息数。
--     大区成员行懒创建（用户首次拉频道列表时），游标基线 = 当时的最大消息 id，
--     避免「从未进过聊天室却把全量历史算作未读」。
--   • chat_messages.id 用自增整数：天然单调，作为增量拉取（?after=<id>）与读游标的基准。
--   • 软删除 is_deleted=1（对齐评论），永不物理删（作者本人 / 管理员删他人需原因入审计）。
--   • 正文纯文本入库（前端 JSX 自动转义）；图片只存 image_hosting.id 引用（图床负责字节与
--     MIME 校验），不在此表建 image 外键 —— 站长硬删图床图片时不应被聊天消息挡住。

CREATE TABLE IF NOT EXISTS "chat_channels" (
    "id"         TEXT    NOT NULL PRIMARY KEY,
    "kind"       TEXT    NOT NULL DEFAULT 'direct',
    "created_at" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "chat_members" (
    "id"                   INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel_id"           TEXT    NOT NULL,
    "user_id"              TEXT    NOT NULL,
    "last_read_message_id" INTEGER NOT NULL DEFAULT 0,
    "created_at"           DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel_id" TEXT    NOT NULL,
    "author_id"  TEXT    NOT NULL,
    "content"    TEXT    NOT NULL DEFAULT '',
    "image_id"   TEXT,
    "reply_to"   INTEGER,
    "is_deleted" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS "ix_chat_members_user_id"
    ON "chat_members"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_member_channel_user"
    ON "chat_members"("channel_id", "user_id");
CREATE INDEX IF NOT EXISTS "ix_chat_messages_channel_id_id"
    ON "chat_messages"("channel_id", "id");

-- 全局「聊天大区」频道（幂等种子）。core+ 用户均可看可发言。
INSERT OR IGNORE INTO "chat_channels" ("id", "kind", "created_at")
    VALUES ('lobby', 'lobby', '2024-01-01T00:00:00.000Z');
