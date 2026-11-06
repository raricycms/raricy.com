-- 42_retire_residual —— 退役机制留下的表/列（R3-018。产品口径：新增迁移删除）。
--
-- 删除项与依据：
--   • reactive_snapshots 表：正文同版本静态快照机制已整条退出（R3-106 —— 每请求
--     segments / 快照 ID / 两次 SHA-256 已停算，source-map.ts 已删；阅读只按当前
--     源码编译）。复核时该表在 src/ 已零读写，只剩测试断言 count()===0。
--     ⚠️ 不可逆：R3-018 未查生产库行数；上真库前先确认
--       SELECT COUNT(*) FROM reactive_snapshots; 为 0，或先备份。
--   • users.fish_api_key_encrypted 列：站外账户微服务签发的用户 API Key 的 Fernet
--     密文。该服务已于 2026-09 搬进站内，全仓零读者（docs/legacy-constraints.md:21
--     原记录「留着不删」；本轮按退役决定清掉）。不可逆：存量密文随列消失，
--     且已没有任何解密路径会用到它（secret-box.ts 只剩回调密钥一处用途）。
--   • profile_blocks.sort 列：2026-10 主页改版后手机端由桌面 (x, y) 投影
--     （src/lib/profile-blocks.ts 的 projectMobile），读路径只序 (y, x)、保存路径
--     也不再写它（src/lib/profile-service.ts:27-32/454）。迁移 32 当年加入，现删。
--
-- 明确保留：
--   • account_sync_ledger：现在是转账 / 补偿幂等登记的唯一存储，只是名字是历史
--     （语义以 src/lib/fish-idempotency.ts 头部为准）。
--   • blogs.renderer_override：对外 bot 契约（docs/bot/blog-bot.md 的 GET 响应），
--     退役需产品/文档批次，本轮不动。
--
-- ── 为什么用 ALTER TABLE … DROP COLUMN（而不是重建表）───────────────────────
-- SQLite 3.35+ 原生支持（Prisma 6 自带 3.46），仓内先例：10_drop_notify_chat 与
-- 24_drop_fortune_columns（后者的头部把「为什么不是重建表」写透了，本次沿用）。
-- 被删列都没有索引 / 外键 / 触发器引用；重建 users / profile_blocks 要把它们的
-- 外键与索引一起重来一遍，风险更大。
--
-- ── 事务与幂等 ──────────────────────────────────────────────────────────────
-- 三条 DDL 必须同一事务（runner 会给无 BEGIN 的迁移包一层，但本文件沿用 24 的
-- 「自带 BEGIN + 哨兵」写法：哨兵让「COMMIT 成功、跟踪行尚未来得及写」的崩溃窗口
-- 也能自愈）。DROP COLUMN 没有 IF EXISTS，**除崩溃恢复外别手工重跑本文件**。
--
-- ── 上真库前的自检（DROP COLUMN 会重解析整个 schema）────────────────────────
-- 与 24 相同，先确认没有 view / trigger 引用被删列：
--   sqlite3 <db> "SELECT type, name, sql FROM sqlite_master WHERE type IN ('view','trigger');"
--
-- ⚠️ 停服迁移：表/列一删，旧代码的相关查询立刻 `no such table` / `no such column`。

BEGIN IMMEDIATE;

DROP TABLE IF EXISTS "reactive_snapshots";
ALTER TABLE "users" DROP COLUMN "fish_api_key_encrypted";
ALTER TABLE "profile_blocks" DROP COLUMN "sort";

-- 哨兵：与上面三条同一事务。checksum 由 migrate.mjs 的 markApplied 随后 upsert 成真值。
INSERT INTO _raricy_migrations (name, applied_at, checksum)
  SELECT '42_retire_residual', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending'
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '42_retire_residual');

COMMIT;
