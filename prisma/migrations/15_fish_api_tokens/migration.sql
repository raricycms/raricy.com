-- 站点签发的**只读**鱼干凭据：只能查余额与流水，**不能转账**，可单独吊销。
--
-- 为什么需要它：在此之前，站外机器人/银行唯一的凭据就是**账号密码**。那把钥匙
-- 既能查也能转，泄露即被搬空；而且它是全账号一把 —— 改密码会把所有机器人一起废掉，
-- 反过来机器人泄露也只能靠改密码补救。于是「拿到更大额度」（见 service-accounts.ts
-- 的服务账号白名单）与「只给最小权限」这两件事根本没法同时成立。
--
-- 与 oauth_access_tokens 的关系：形状同源（只存 SHA-256、scopes 空格分隔、
-- revoked_at / last_used_at），但**刻意不共用一张表**：
--   • oauth_access_tokens.application_id 是 NOT NULL 且外键到 oauth_applications
--     —— 自签凭据没有第三方应用，塞个假应用或把它改可空都会污染 OAuth 的语义；
--   • 两者授权的东西根本不是一回事：OAuth 那张授权的是「第三方读用户资料」，
--     这张授权的是「用户自己读自己的余额/流水」。生命周期、吊销入口、限频桶全不同。
--
-- ★ id 用自增整数而不是 token_hash 做主键 ★（与 oauth_access_tokens 的取舍不同）
--   token_hash 只需唯一即可。改用整数 id 是因为：自助页与运维 CLI 都要「按列表里的
--   那一行吊销」，用整数当把手比让用户/站长复制一串 64 位十六进制可靠得多。
--   安全性不受影响 —— 明文仍然只存哈希，整数 id 反推不出任何东西。
--
-- scopes 现在是常量 'read'。**不要**给它加 write / transfer：
--   转账那条路的全部价值就在「必须是本人在场、且当场输一次密码」（见
--   src/app/api/fish/market/pay/route.ts 的 step-up 注释）。给凭据开转账等于把
--   收银台辛苦建立的那道闸门从后门拆掉。
--
-- expires_at NOT NULL：本表**不提供永不过期**的凭据。一张永不过期的读取凭据是
--   典型的「设好就忘」，而它一年后还在读用户的账。到期静默 401 确实烦人，所以
--   自助页把到期时间显示出来，文档也要求机器人按到期时间轮换。
--
-- 幂等：CREATE TABLE / CREATE INDEX 都带 IF NOT EXISTS。
--
-- ⚠️ 物理外键必须写：测试库由 prisma db push 从 schema.prisma 生成、**会**建出外键，
--    这里不写就会「测试里外键生效、生产上不生效」（同 12_favorites 头部记录的那类分歧）。
--    users 全站软删，没有「站长硬删挡不住」的问题，所以照常建。
--
-- ⚠️ 排期注意：本表引用 users，tests/helpers/db.ts 的 resetDb() 必须把它列在 users **之前**。

CREATE TABLE IF NOT EXISTS "fish_api_tokens" (
    "id"           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token_hash"   TEXT     NOT NULL,
    "user_id"      TEXT     NOT NULL,
    "label"        TEXT,
    "scopes"       TEXT     NOT NULL DEFAULT 'read',
    "expires_at"   DATETIME NOT NULL,
    "revoked_at"   DATETIME,
    "last_used_at" DATETIME,
    "created_at"   DATETIME,
    CONSTRAINT "fish_api_tokens_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 唯一而非主键：见头部「为什么用自增 id 做把手」。库泄露时哈希不可逆，仍然是只存哈希。
CREATE UNIQUE INDEX IF NOT EXISTS "fish_api_tokens_token_hash_key"
    ON "fish_api_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "ix_fish_api_tokens_user_id"    ON "fish_api_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "ix_fish_api_tokens_expires_at" ON "fish_api_tokens"("expires_at");

-- 本迁移**不含数据变换**，也没有任何时间戳写入。
