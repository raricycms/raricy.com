-- 气泡持有账与装备指针。定义在代码中，添加款式无需迁移。
-- 装备两列是持有账的副本，只由 bubble-service 写；续期/撤销必须同事务同步。
-- 到期懒判定，不清理、不物删。唯一约束包含墓碑，再授予复活原行。
CREATE TABLE IF NOT EXISTS "user_bubbles" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL,
  "bubble_key" TEXT NOT NULL,
  "expires_at" DATETIME,
  "source" TEXT NOT NULL DEFAULT 'cli',
  "created_at" DATETIME,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "deleted_at" DATETIME,
  CONSTRAINT "user_bubbles_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_bubbles_user_id_bubble_key_key"
  ON "user_bubbles"("user_id", "bubble_key");
CREATE INDEX IF NOT EXISTS "ix_user_bubbles_user_id" ON "user_bubbles"("user_id");
-- SQLite ADD COLUMN 无 IF NOT EXISTS，重复执行由 _raricy_migrations 阻止。
ALTER TABLE "users" ADD COLUMN "equipped_bubble_key" TEXT;
ALTER TABLE "users" ADD COLUMN "equipped_bubble_expires_at" DATETIME;
