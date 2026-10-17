-- CLI 专用账号归档。原文与身份保留；HTTP 查询按作者的 archived_at 收敛。
-- ALTER 由迁移跟踪表保证只执行一次，不手工重放。
ALTER TABLE users ADD COLUMN archived_at DATETIME;
ALTER TABLE users ADD COLUMN archive_reason TEXT;
ALTER TABLE users ADD COLUMN archived_by TEXT;
CREATE INDEX IF NOT EXISTS ix_users_archived_at ON users(archived_at);
ALTER TABLE comment_likes ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE comment_likes ADD COLUMN deleted_at DATETIME;
ALTER TABLE notifications ADD COLUMN hidden_at DATETIME;
