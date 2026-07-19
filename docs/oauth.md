# OAuth 2.0 身份绑定系统

raricy.com 作为 **OAuth 2.0 Authorization Server**，让外部第三方应用以标准协议读取 raricy 用户的基础资料（id / username / avatar）。

> **版本范围**：v1 仅支持 `profile` scope，不开放任何写操作；access_token 长期有效（90 天），不发放 refresh_token。

---

## 1. 协议

- **Grant Type**：`authorization_code`（RFC 6749 §4.1）
- **客户端鉴权**：`client_secret_basic`（HTTP Basic）优先，body 内 `client_id` + `client_secret` 兜底
- **Scope**：`profile`（v1 唯一可用）
- **Access Token TTL**：90 天
- **Refresh Token**：v1 不发放；吊销走 `/api/oauth/revoke`

---

## 2. 端点

| 端点 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/oauth/authorize` | GET | raricy session | 授权确认页（浏览器） |
| `/api/oauth/authorize` | POST | raricy session | 用户点「同意」后 mint code + 302 回调 |
| `/api/oauth/token` | POST | client (HTTP Basic / body) | code → access_token |
| `/api/oauth/userinfo` | GET | `Authorization: Bearer` | 返回 `{sub, username, avatar_url}` |
| `/api/oauth/revoke` | POST | session **或** bearer | 吊销 token（RFC 7009） |
| `/api/oauth/connections` | GET | raricy session | 当前用户已绑定的应用列表 |
| `/api/oauth/connections/[id]` | DELETE | raricy session | 解除单个绑定 |
| `/api/admin/oauth/applications` | GET / POST | owner | 列出 / 创建应用 |
| `/api/admin/oauth/applications/[id]` | PATCH / DELETE | owner | 更新 / 软禁用 |

---

## 3. 注册流程

应用必须由站长登记。两种方式：

### 3a. CLI（推荐自动化 / 脚本场景）

```bash
npm run cli -- oauth create-app "cattca-game" \
  --homepage "https://cattca.example.com" \
  -d "CattCa 站点的用户绑定" \
  --redirect-uri "https://cattca.example.com/oauth/callback"

# 输出：
#   client_id:     AbCdEf123...
#   client_secret: XyZ_987...   ← 仅此一次
```

### 3b. 管理页（人工 / 临时调整）

1. 用站长账号登录
2. 访问 `/admin/oauth`
3. 填写名称、说明、主页、回调 URI（一行一个）
4. 点击「创建」→ 弹窗显示 `client_id` + `client_secret` → **立即复制保存**

禁用 / 启用：同页「已注册的应用」列表里点击对应按钮。

---

## 4. 集成示例（curl）

```bash
# 0) 应用信息
CLIENT_ID="AbCdEf123..."
CLIENT_SECRET="XyZ_987..."
REDIRECT_URI="https://cattca.example.com/oauth/callback"

# 1) 把用户引导到 raricy 授权页
#    （如果未登录会先跳 /login；登录后会带 next= 跳回此 URL）
AUTH_URL="https://raricy.com/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("'$REDIRECT_URI'", safe=""))')&state=xyz&scope=profile"
# 在浏览器或 302 跳到 AUTH_URL

# 2) 用户同意 → 外部应用收到 redirect：?code=XXX&state=xyz
CODE="用户授权后从回调 URL 中获取的 code"

# 3) 用 code 换 access_token
TOK_RES=$(curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("'$REDIRECT_URI'", safe=""))')" \
  https://raricy.com/api/oauth/token)
# 响应：{"access_token":"...","token_type":"Bearer","expires_in":7776000,"scope":"profile"}
ACCESS_TOKEN=$(echo "$TOK_RES" | jq -r .access_token)

# 4) 读取用户资料
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" https://raricy.com/api/oauth/userinfo
# 响应：{"sub":"<user_id>","username":"...","avatar_url":"https://raricy.com/api/avatar/<user_id>"}

# 5) 用户主动解除（在 raricy 网站 settings 页） 或应用替用户登出：
curl -sS -X POST -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$ACCESS_TOKEN\"}" \
  https://raricy.com/api/oauth/revoke
# 200 {} — 之后该 token 在 /userinfo 立即返回 invalid_token
```

---

## 5. userinfo 响应 schema

```jsonc
{
  "sub":        "8a5268d8-abff-4241-bb57-bc526229cf00",   // OIDC 风格的稳定用户 ID
  "username":   "oauth_test_1vi7nn",                       // raricy 用户名
  "avatar_url": "https://raricy.com/api/avatar/8a5268d8-..." // null 表示未设头像（用占位图）
}
```

被封号（`isBanned = true`）用户的 token 立即失效（userinfo 返回 `error: invalid_token`）。

---

## 6. 安全说明

| 项 | 实现 |
|----|------|
| Token 存储 | DB 仅存 SHA-256 哈希作为 PK；原始 token 仅在响应里出现一次 |
| `client_secret` 存储 | werkzeug 兼容 scrypt（自带盐），与 `User.passwordHash` 同款 |
| `redirect_uri` 校验 | **精确字符串相等**（OAuth 2.0 Security BCP §4.1；无通配 / 前缀 / 子串） |
| 客户端鉴权 | HTTP Basic 优先（RFC 6749 §2.3.1） |
| 授权码单次使用 | Prisma 原子 `update where {codeHash, usedAt: null}` 保证恰好一次 |
| 授权码 TTL | 10 分钟 |
| `redirect_uri` 一致性 | token 端再次校验与授权时一致（防 code 截获重定向） |
| Token 比较时序 | 用 SQL PK 存在性查询；`client_secret` 走 `timingSafeEqual` |
| CSRF | `/api/oauth/authorize` 保留；`/token` `/userinfo` `/revoke` 豁免（client_secret 鉴权） |
| 限频 | authorize 30/min/user · token 60/min/clientId · userinfo 600/min/user |
| 日志 | 原始 token / code / secret **永不**写入日志 |

`SECRET_KEY` 轮换**不影响** `client_secret`（scrypt 自带盐），但需注意：轮换 SECRET_KEY 不会让存量 client_secret 失效，也不影响 OAuth 服务。

---

## 7. 限频

通过 `src/lib/rate-limit.ts` 进程内桶（重启丢失）。多实例部署时建议改 Redis。

| Key 格式 | 限制 |
|----------|------|
| `oauth:authorize:${userId}` | 30 / 分钟 |
| `oauth:token:${clientId}` | 60 / 分钟 |
| `oauth:userinfo:${userId}` | 600 / 分钟 |

---

## 8. v1 限制与未来扩展点

| 现状 | 未来扩展 |
|------|----------|
| 仅 `profile` scope | 加 `email` / `notifications` 等读 scope；写 scope 需配合更严的 consent UI |
| 无 refresh_token | 加 `grant_type=refresh_token`（v1 用 revocation + 长 TTL 兜底） |
| 软禁用（`disabledAt`） | 硬删除（FK CASCADE 已就位） |
| 站长手工注册 | 自助申请 + admin 审批流 |
| 站内吊销走 settings 页 | 加 `/api/oauth/revoke` 站外调用方接口（已实现，但仅 owner + self） |
| 仅 HTTP / HTTPS redirect | 加自定义 scheme 支持（mobile app） |
| 单站点 cookie | 加 PKCE（RFC 7636）防 code 截获 + 适配 SPA / mobile |
| `state` 仅透传 | 加 server-side state 校验防 CSRF on `/oauth/authorize` GET |