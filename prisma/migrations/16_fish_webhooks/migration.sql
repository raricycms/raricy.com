-- 鱼干收款回调：钱到账时主动通知商户，商户不必轮询。
--
-- 背景：在此之前站外银行只能「隔几秒拉一次流水」。轮询有两个硬伤 ——
--   · 慢：对账有 10 秒滞后要求（见 docs/bot/fish-bot.md §3.3.1），端到端要十几秒；
--   · 贵：那条 20 次/分/账号是 **CPU 闸门**（每次请求跑一次 scrypt），
--     几十人的银行光轮询就能吃光。
-- 回调把「谁主动」反过来：我们推给商户。
--
-- ── 两张表 ──────────────────────────────────────────────────────────────────
-- fish_webhook_endpoints：一个账号一个地址（user_id 做主键）。1:1 是刻意的 ——
--   多个地址会让「哪个地址收哪些事件」变成一个没人管的配置问题，而当前只有
--   一种事件（收款到账）。
-- fish_webhook_deliveries：**outbox（发件箱）**。投递行与转账的两条流水**同事务**
--   写入，所以「钱记了、通知忘了」在结构上不可能发生。这是照搬
--   account_sync_ledger 的形状（写库在事务内、HTTP 在事务外），原因见
--   CLAUDE.md 的红线：远端 HTTP 绝不能在 SQLite 事务内。
--
-- ── 为什么 payload 存的是**序列化后的正文**，不像账本那样只存重建参数 ────────
-- 账本存参数是因为它要「重放时重建请求」；回调要的是**字节稳定**：签名是对
-- 正文算的，重试时正文必须一模一样，否则商户那边验签会挂。所以这里存成品。
-- 代价是事件内容改了不会追溯改写历史投递 —— 那正是我们要的。
--
-- ── status 的取值与流转 ─────────────────────────────────────────────────────
--   pending  待投递（到期时间到了才会被捞）
--   sending  已被某个 drainer 领走（**租约**，见下）
--   delivered 商户返回 2xx
--   dead     重试次数耗尽，放弃
-- **绝不物理删除**（全站口径）：dead 行留着供运维查证，见 `fish webhooks`。
--
-- ── 关于 sending 这个中间态 ─────────────────────────────────────────────────
-- 定时器与 CLI 是两个进程，可能同时扫到同一行。认领靠**条件 UPDATE**：
-- 只有把 attempts 从 n 改成 n+1 的那个调用者拿到 count===1 才允许发。
-- 但「领了之后崩了」会把行永远卡在 sending —— 所以每条 drain 开头要**回收租约**：
-- 把 updated_at 超过 LEASE_MS 的 sending 行改回 pending。
-- 结果是 **at-least-once**：极端情况下商户会收到重复回调，所以投递带
-- X-Raricy-Delivery（同一个值在重试间不变），**商户必须按它去重**。
--
-- ── 幂等 ────────────────────────────────────────────────────────────────────
-- CREATE TABLE / CREATE INDEX 都带 IF NOT EXISTS。
--
-- ⚠️ 物理外键必须写：测试库由 prisma db push 从 schema.prisma 生成、**会**建出外键，
--    不写就会「测试里外键生效、生产上不生效」（同 12_favorites 头部记录的那类分歧）。
-- ⚠️ 两张表都引用 users，tests/helpers/db.ts 的 resetDb() 必须列在 users **之前**
--    （deliveries 还要排在 endpoints 之前，或者干脆只按 users 那条线排 ——
--     当前 deliveries 没有指向 endpoints 的外键，见下）。
--
-- 【为什么 deliveries 不对 endpoints 建外键】endpoints 是按 user_id 主键的一张
-- 配置表；deliveries 记的是「某个用户的那次事件」，用户删掉配置后历史投递记录
-- 仍然是运维查证需要的（「当时到底发出去没有」）。建了外键 + CASCADE 会让撤销
-- 回调地址顺手抹掉证据，RESTRICT 又会让用户改不了配置。所以只引用 users。
--
-- 本迁移**不含数据变换**，也没有任何时间戳写入。

CREATE TABLE IF NOT EXISTS "fish_webhook_endpoints" (
    "user_id"              TEXT     NOT NULL PRIMARY KEY,
    "url"                  TEXT     NOT NULL,
    -- Fernet 密文（同 User.fishApiKeyEncrypted 的口径）。签名密钥是凭证：
    -- 泄露它就能伪造我们发给商户的回调，所以**不能明文落库**。
    "secret_encrypted"     TEXT     NOT NULL,
    "disabled_at"          DATETIME,
    -- 连续失败次数。**只用于展示，不自动停用** —— 悄悄停掉全部回调是典型的
    -- 静默失效（商户以为还在收通知，其实早就没了）。
    "consecutive_failures" INTEGER  NOT NULL DEFAULT 0,
    "last_success_at"      DATETIME,
    "last_failure_at"      DATETIME,
    "created_at"           DATETIME,
    "updated_at"           DATETIME,
    CONSTRAINT "fish_webhook_endpoints_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "fish_webhook_deliveries" (
    "id"               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    -- 接收方去重用的句柄。**重试之间不变**，随机生成（不是自增 id ——
    -- 自增 id 会暴露「站点总共发了多少条回调」这种与接收方无关的信息）。
    "delivery_id"      TEXT    NOT NULL,
    "user_id"          TEXT    NOT NULL,
    "transfer_id"      TEXT    NOT NULL,
    "event"            TEXT    NOT NULL,
    "payload"          TEXT    NOT NULL,
    "status"           TEXT    NOT NULL DEFAULT 'pending',
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at"  DATETIME NOT NULL,
    "last_error"       TEXT,
    "last_status_code" INTEGER,
    "delivered_at"     DATETIME,
    "created_at"       DATETIME,
    "updated_at"       DATETIME,
    CONSTRAINT "fish_webhook_deliveries_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "fish_webhook_deliveries_delivery_id_key"
    ON "fish_webhook_deliveries"("delivery_id");
-- 到期扫描用（定时器与 CLI 都按 status + next_attempt_at 捞）
CREATE INDEX IF NOT EXISTS "ix_fish_webhook_deliveries_due"
    ON "fish_webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "ix_fish_webhook_deliveries_user_id"
    ON "fish_webhook_deliveries"("user_id");
CREATE INDEX IF NOT EXISTS "ix_fish_webhook_deliveries_transfer_id"
    ON "fish_webhook_deliveries"("transfer_id");
