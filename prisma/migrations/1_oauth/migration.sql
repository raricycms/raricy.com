-- 1_oauth: OAuth 2.0 Authorization Code 表（外部应用身份绑定）
--
-- 严格对齐 prisma/schema.prisma 中三张新模型的列名 / 类型 / 索引。
-- 走手工 SQL 应用（schema 头已注明不要 prisma migrate），apply 后跑
-- `npx prisma generate` 增量更新客户端即可。
--
-- 设计要点：
--   • 主键 = SHA-256(明文)：64 字符 hex，永不重复也无需自增。
--   • redirect_uris / scopes 是 JSON 字符串（SQLite 无数组类型，应用层 parse）。
--   • authorization_codes / access_tokens 对 application/user 用 CASCADE，
--     但 applications.created_by_id 用 RESTRICT（防 owner 被误删导致应用悬挂）。
--   • 索引覆盖 OAuth 服务的关键查询路径：client_id 查找、(app,user) 关联查询、
--     expires_at 周期清理。

CREATE TABLE IF NOT EXISTS "oauth_applications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "homepage_url" TEXT,
    "redirect_uris" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" DATETIME,
    "disabled_at" DATETIME,
    CONSTRAINT "oauth_applications_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_applications_client_id_key" ON "oauth_applications"("client_id");
CREATE INDEX IF NOT EXISTS "ix_oauth_apps_client_id" ON "oauth_applications"("client_id");
CREATE INDEX IF NOT EXISTS "ix_oauth_apps_created_by_id" ON "oauth_applications"("created_by_id");

CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
    "code_hash" TEXT NOT NULL PRIMARY KEY,
    "application_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "created_at" DATETIME,
    CONSTRAINT "oauth_authorization_codes_application_id_fkey"
        FOREIGN KEY ("application_id") REFERENCES "oauth_applications" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oauth_authorization_codes_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ix_oauth_codes_app_user" ON "oauth_authorization_codes"("application_id", "user_id");
CREATE INDEX IF NOT EXISTS "ix_oauth_codes_expires_at" ON "oauth_authorization_codes"("expires_at");

CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "application_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "last_used_at" DATETIME,
    "created_at" DATETIME,
    CONSTRAINT "oauth_access_tokens_application_id_fkey"
        FOREIGN KEY ("application_id") REFERENCES "oauth_applications" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oauth_access_tokens_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ix_oauth_tokens_app_user" ON "oauth_access_tokens"("application_id", "user_id");
CREATE INDEX IF NOT EXISTS "ix_oauth_tokens_user_id" ON "oauth_access_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "ix_oauth_tokens_expires_at" ON "oauth_access_tokens"("expires_at");