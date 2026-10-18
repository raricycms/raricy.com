-- 30_saved_chat_messages —— 私聊消息保存箱
--
-- 【这是「消息保存」，不是收藏夹】收藏夹是「可分享的合辑」：公开夹有 6 位句柄 /
--   二维码 / [@ID] / bot 接口，私密夹也能复制成公开、能导出 JSON。私聊消息恰好相反 ——
--   只有会话当事人能看。两者共用一个容器就得给每个出口加一条例外（隐藏复制、隐藏导出、
--   隐藏二维码……），所以这里**单开一张薄表**：没有句柄、没有复制、没有导出、没有 bot
--   出口。不是「藏起来」，是**没有那些东西**。
--
-- 【只存指针，不存正文】消息会被作者 / 管理员软删（chat_messages.is_deleted）。保存箱
--   若存正文快照，就等于给删除语义开后门；读时按当前消息行解析，删了就给占位。
--
-- 【形态】对齐 favorite_items / user_frames：自增 id（join 行）+ 非可选 deleted +
--   配对 deleted_at + 唯一约束 + created_at 无默认（写路径显式 nowForDb()）。
--   ⚠️ 唯一约束是**物理**的、包含墓碑行：取消保存再保存必须**复活旧行**（翻转
--   deleted），不能新插 —— 会撞唯一约束。见 saved-message-service 的 saveMessage。
--
-- ⚠️ 【唯一索引的名字】Prisma 在 SQLite 上忽略 `@@unique(..., name: "…")`，物理索引
--   一律用派生名 `<表>_<列…>_key`。这里的 "saved_chat_messages_user_id_message_id_key"
--   就是 db push 生成的那个（从 sqlite_master 原样抄出，见 20_user_frames 的同款注解）。
--   手写别用 uq_xxx —— 那会与测试库（db push 生成）漂移。
--
-- ⚠️ 排期注意：本表引用 users 与 chat_messages，所以 tests/helpers/db.ts 的 resetDb()
--   必须把它排在 **chat_messages 与 users 之前**删。漏登记不报错（那里的 .catch()
--   会吞掉），表现为数据在用例间残留 —— 那种失败看起来像业务 bug。
--
-- 本迁移**不含数据变换**。

CREATE TABLE IF NOT EXISTS "saved_chat_messages" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id"    TEXT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "created_at" DATETIME,
    "deleted"    BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" DATETIME,
    CONSTRAINT "saved_chat_messages_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "saved_chat_messages_message_id_fkey" FOREIGN KEY ("message_id")
        REFERENCES "chat_messages" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 同一用户对同一条消息只有一行（再保存 = 复活墓碑行）。
CREATE UNIQUE INDEX IF NOT EXISTS "saved_chat_messages_user_id_message_id_key"
    ON "saved_chat_messages"("user_id", "message_id");
-- 保存箱唯一的列表查询：where user_id + order by id desc + 游标 —— 复合索引一次覆盖。
CREATE INDEX IF NOT EXISTS "ix_saved_chat_messages_user_id_id"
    ON "saved_chat_messages"("user_id", "id");
-- 反查「这条消息被谁保存过」（以及按消息 id 过滤的 ids 读口）。
CREATE INDEX IF NOT EXISTS "ix_saved_chat_messages_message_id"
    ON "saved_chat_messages"("message_id");
