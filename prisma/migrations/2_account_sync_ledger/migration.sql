-- 账户微服务同步账本：远端 HTTP 调用移出 SQLite 事务的落地机制。
-- 写路径改为「本地事务提交 + 账本登记 pending → 提交后调远端 → 成功标 synced /
-- 失败补偿本地写入标 compensated / 补偿也失败标 failed（可幂等重放）」。
-- 见 src/lib/fish-sync.ts 与 CLAUDE.md「鱼干写路径」。

CREATE TABLE IF NOT EXISTS "account_sync_ledger" (
    "id"              INTEGER PRIMARY KEY AUTOINCREMENT,
    "idempotency_key" TEXT    NOT NULL,
    "operation"       TEXT    NOT NULL,
    "payload"         TEXT    NOT NULL,
    "status"          TEXT    NOT NULL DEFAULT 'pending',
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "last_error"      TEXT,
    "created_at"      DATETIME,
    "updated_at"      DATETIME
);

CREATE INDEX IF NOT EXISTS "ix_account_sync_ledger_status"    ON "account_sync_ledger"("status");
CREATE INDEX IF NOT EXISTS "ix_account_sync_ledger_created_at" ON "account_sync_ledger"("created_at");

-- 幂等键唯一：重放安全的关键（重复登记同一笔直接被约束拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS "account_sync_ledger_idempotency_key_key"
    ON "account_sync_ledger"("idempotency_key");
