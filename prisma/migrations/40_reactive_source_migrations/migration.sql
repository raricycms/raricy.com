-- 正文变换完成标记与全部正文/快照写入同一事务，确保数据迁移只执行一次。
CREATE TABLE IF NOT EXISTS "reactive_source_migrations" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "completed_at" TEXT NOT NULL
);
