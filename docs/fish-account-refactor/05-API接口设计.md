# 05 — API 接口设计

## 1. 通用约定

### 1.1 基础信息

| 项目 | 值 |
|------|-----|
| Base URL | `http://account-service:8000/api/v1` |
| 协议 | HTTP/1.1 |
| 数据格式 | JSON (`Content-Type: application/json`) |
| 字符编码 | UTF-8 |

### 1.2 认证

所有接口使用统一的 **Bearer API Key** 认证。没有 HMAC、没有特殊通道。

```
Authorization: Bearer fish_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**认证规则（唯一）：**

| 接口类型 | 认证要求 |
|----------|----------|
| 转账 (`POST /transfers`) | **必须**提供 `from_user_id` 对应的 API Key。账户服务验证：Key 存在 → SHA-256 哈希匹配 → Key 所属账户的 `user_id == from_user_id` |
| 创建账户 (`POST /accounts`) | **不需要**认证（任何注册用户都应该能创建账户）。泛用 Key 或无需认证 |
| 查询余额/流水 (`GET`) | **不需要**认证（只读，余额不是敏感信息）。可选 Key 用于频率限制 |
| 健康检查 (`GET /health`) | 不需要认证 |

**为什么余额查询不需要认证？**

小鱼干不是真实货币。余额排行榜已经是公开的（博客首页就有）。隐藏余额不会增加安全性，反而增加对接复杂度。如果未来有敏感操作（如提现），再加认证即可。

关于 API Key 的生成、哈希存储和验证逻辑，详见 [04-项目结构与数据模型 / API Key 设计](04-项目结构与数据模型.md#24-api-key-设计)。

### 1.3 幂等

所有 `POST` / `PUT` 接口支持幂等键：

```
X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

- 必须是 UUID v4 格式
- 24 小时内相同 key 返回相同结果
- GET 请求不需要（天然幂等）

### 1.4 通用响应格式

**成功：**

```json
{
    "code": 200,
    "data": { ... },
    "request_id": "uuid"
}
```

**客户端错误：**

```json
{
    "code": 400,
    "message": "人类可读的错误描述",
    "detail": { ... },
    "request_id": "uuid"
}
```

**服务端错误：**

```json
{
    "code": 500,
    "message": "内部服务错误",
    "request_id": "uuid"
}
```

### 1.5 金额格式

所有 API 中的 `amount` 字段使用**外部单位**：`1 小鱼干 = 1.0`。

支持的最大精度为 0.0001（对应内部最小单位 1）。

```json
{
    "amount": 5.0        // 5 个小鱼干
}
```

内部转换（`× 10000`）由服务端透明处理，调用方不需要感知。

### 1.6 业务类型 (entry_type)

流水表中的 `entry_type` 枚举：

| entry_type | 含义 | 说明 |
|-----------|------|------|
| `checkin` | 签到获得 | 每日签到选卡后系统发放 |
| `feed_out` | 投喂支出 | 用户给文章投小鱼干 |
| `feed_income` | 投喂收入 | 作者收到的投喂分成 (20%) |
| `feed_consume` | 投喂消耗 | 投喂中系统回收的部分 (80%) |
| `admin_grant` | 管理员发放 | 管理员通过后台/CLI 发放 |
| `admin_deduct` | 管理员扣除 | 管理员通过后台/CLI 扣除 |
| `transfer` | 用户转账 | 用户之间直接转账（未来） |

---

## 2. 接口清单

| # | 方法 | 路径 | 说明 | 幂等 |
|---|------|------|------|------|
| 1 | `GET` | `/health` | 健康检查 | — |
| 2 | `POST` | `/api/v1/accounts` | 创建账户 | ✅ |
| 3 | `GET` | `/api/v1/accounts/{user_id}/balance` | 查询余额 | — |
| 4 | `POST` | `/api/v1/accounts/balances/batch` | 批量查询余额 | — |
| 5 | `POST` | `/api/v1/transfers` | 转账（核心接口） | ✅ |
| 6 | `GET` | `/api/v1/accounts/{user_id}/ledger` | 交易流水分页 | — |

---

## 3. 接口详细规格

### 3.1 健康检查

```
GET /health
```

无需认证。

**响应 200：**
```json
{
    "status": "ok",
    "version": "0.1.0",
    "db": "connected"
}
```

---

### 3.2 创建账户

```
POST /api/v1/accounts
```

用户注册时由博客调用。账户服务不关心用户的密码/邮箱，只记录 `user_id`。**不需要认证。**

**请求体：**
```json
{
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "currency": "DRIED_FISH"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | ✅ | 博客的 user.id (UUID)，最大 36 字符 |
| `currency` | string | ❌ | 默认 `"DRIED_FISH"`，仅允许 `[A-Z_]{1,20}` |

**响应 201：**
```json
{
    "code": 201,
    "data": {
        "account_id": "a1b2c3d4-...",
        "user_id": "550e8400-...",
        "currency": "DRIED_FISH",
        "balance": 0.0,
        "api_key": "fish_sk_wPX2qV8zN7rKdLmY3xBhFjRtWcAeUoSn",
        "created_at": "2026-07-02T12:00:00Z"
    },
    "request_id": "..."
}
```

> ⚠️ **`api_key` 仅在创建时返回一次。** 账户服务不存储明文 Key（只存 SHA-256 哈希），所以无法再次查询。博客应立即加密存储此 Key。如果丢失，只能通过 API 轮换新 Key。

**错误：**
| code | 情况 |
|------|------|
| 409 | 该 `(user_id, currency)` 组合已存在（返回已有账户，**不返回 api_key**） |

> **幂等行为**：相同的 `user_id` + `currency` 重复调用返回 200（已有账户），但不返回 `api_key`（因为首次创建时已返回，服务端无法再次获取明文 Key）。

---

### 3.3 查询余额

```
GET /api/v1/accounts/{user_id}/balance?currency=DRIED_FISH
```

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| `user_id` | path | string | ✅ | 博客用户 ID |
| `currency` | query | string | ❌ | 默认 `"DRIED_FISH"` |

**响应 200：**
```json
{
    "code": 200,
    "data": {
        "user_id": "550e8400-...",
        "currency": "DRIED_FISH",
        "balance": 15.5,
        "updated_at": "2026-07-02T11:59:00Z"
    },
    "request_id": "..."
}
```

`balance` 是聚合计算值，`updated_at` 是该账户最后一笔交易的创建时间。

**如果账户不存在：**
```json
{
    "code": 200,
    "data": {
        "user_id": "unknown-user",
        "currency": "DRIED_FISH",
        "balance": 0.0,
        "updated_at": null
    },
    "request_id": "..."
}
```

> **设计决策**：不存在的账户返回 `balance: 0` 而不是 404。这样博客在渲染页面时不需要先判断"这个用户有没有账户"。

---

### 3.4 批量查询余额

```
POST /api/v1/accounts/balances/batch
```

**请求体：**
```json
{
    "user_ids": [
        "550e8400-...",
        "660e8400-...",
        "770e8400-..."
    ],
    "currency": "DRIED_FISH"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_ids` | string[] | ✅ | 最大 100 个 |
| `currency` | string | ❌ | 默认 `"DRIED_FISH"` |

**响应 200：**
```json
{
    "code": 200,
    "data": {
        "balances": {
            "550e8400-...": 15.5,
            "660e8400-...": 3.0,
            "770e8400-...": 0.0
        },
        "currency": "DRIED_FISH"
    },
    "request_id": "..."
}
```

- 不存在的 user_id 对应 `0.0`
- 超出 100 个返回 422

---

### 3.5 转账（核心接口）

```
POST /api/v1/transfers
Authorization: Bearer fish_sk_<from_user 的 API Key>   ← 必填！
X-Idempotency-Key: <uuid>                              ← 必填！
```

这是整个账户服务最关键的接口。所有资金变动——签到、投喂、管理员操作——最终都通过这个接口完成。

**核心认证逻辑：**

```
Authorization 头中的 API Key → SHA-256 哈希 → 查找 Account
                                ↓
                    Key 所属的 account.user_id
                                ↓
                    必须 == 请求体中的 from_user_id
                                ↓
                       ✓ 一致 → 执行转账
                       ✗ 不一致 → 403 Forbidden
```

**请求体：**
```json
{
    "from_user_id": "raricy-blog-system",
    "to_user_id": "550e8400-...",
    "amount": 3.0,
    "currency": "DRIED_FISH",
    "entry_type": "checkin",
    "description": "每日签到（运势值 3）",
    "metadata": {
        "fortune_value": 3,
        "checkin_date": "2026-07-02"
    }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `from_user_id` | string | ✅ | 出账方用户 ID。**必须与 Authorization Bearer token 所属账户一致** |
| `to_user_id` | string | ✅ | 入账方用户 ID（收钱不需要认证） |
| `amount` | number | ✅ | 金额（自然单位），>0，最多 4 位小数 |
| `currency` | string | ❌ | 默认 `"DRIED_FISH"` |
| `entry_type` | string | ✅ | 业务类型，见 [1.6 节](#16-业务类型-entry_type) |
| `description` | string | ❌ | 人类可读描述，最大 255 字符 |
| `metadata` | object | ❌ | 任意 JSON，存储业务上下文 |

**响应 200：**
```json
{
    "code": 200,
    "data": {
        "transaction_id": "tx-uuid-here",
        "from_user_id": "raricy-blog-system",
        "to_user_id": "550e8400-...",
        "amount": 3.0,
        "currency": "DRIED_FISH",
        "entry_type": "checkin",
        "from_balance_after": -15420.0,
        "to_balance_after": 18.5,
        "created_at": "2026-07-02T12:00:00Z"
    },
    "request_id": "..."
}
```

- `from_balance_after`：出账方转账后的余额。系统账户的余额通常是负数（发行在外的鱼干总量）
- `to_balance_after`：入账方转账后的余额

**错误：**
| code | 情况 | detail 包含 |
|------|------|------------|
| 400 | 余额不足 | `{"user_id": "...", "required": 5.0, "available": 3.0}` |
| 400 | 请求参数无效（amount ≤ 0 等） | 字段级错误 |
| 401 | API Key 无效 | — |
| 403 | API Key 有效但不属于 `from_user_id` | `{"key_belongs_to": "user-a", "claimed_from_user": "user-b"}` |
| 409 | 幂等冲突：相同 key 但不同请求体 | 首次请求的摘要 |
| 422 | 参数校验失败（Pydantic） | 字段级错误信息 |

**幂等示例：**

```
请求 1: POST /transfers
         Authorization: Bearer fish_sk_A
         Idempotency-Key: "abc-123"
         Body: { from: "user-a", to: "user-b", amount: 5.0 }
         → 200 OK, 扣款 5，记录幂等键

请求 2: POST /transfers（网络重试，完全相同的请求）
         Authorization: Bearer fish_sk_A
         Idempotency-Key: "abc-123"
         Body: { from: "user-a", to: "user-b", amount: 5.0 }
         → 200 OK, 返回相同 tx_id（未重复扣款）

请求 3: POST /transfers（相同幂等键，但 body 不同）
         Idempotency-Key: "abc-123"
         Body: { from: "user-a", to: "user-c", amount: 3.0 }
         → 409 Conflict（相同 key 但不同内容）
```

**典型调用场景：**

```
场景 1：签到（博客系统用自己的 Key 发鱼干）
  curl -X POST /api/v1/transfers \
    -H "Authorization: Bearer fish_sk_BLOG_SYSTEM_KEY" \
    -H "X-Idempotency-Key: checkin-userA-2026-07-02" \
    -d '{"from_user_id":"raricy-blog-system","to_user_id":"user-a","amount":3,"entry_type":"checkin"}'

场景 2：投喂（博客替用户 A 用其 Key 转账给作者 B）
  curl -X POST /api/v1/transfers \
    -H "Authorization: Bearer fish_sk_USER_A_KEY" \    ← 用户 A 的 Key
    -H "X-Idempotency-Key: feed-blog123-userA-5" \
    -d '{"from_user_id":"user-a","to_user_id":"user-b","amount":5,"entry_type":"feed_out"}'

场景 3：用户直接操作（不经过博客，未来场景）
  手机 App 拿着用户自己的 API Key 直接调账户服务
  → 博客完全不参与，账户服务独立运作
```

---

### 3.6 交易流水分页

```
GET /api/v1/accounts/{user_id}/ledger?page=1&per_page=20&entry_type=checkin&start=2026-06-01&end=2026-07-01
```

| 参数 | 位置 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|------|
| `user_id` | path | string | ✅ | — | 博客用户 ID |
| `page` | query | int | ❌ | 1 | 页码，≥1 |
| `per_page` | query | int | ❌ | 20 | 每页条数，1-100 |
| `entry_type` | query | string | ❌ | — | 筛选业务类型，支持逗号分隔：`checkin,feed_out` |
| `start` | query | date | ❌ | — | 起始日期（含），ISO 8601 |
| `end` | query | date | ❌ | — | 结束日期（含），ISO 8601 |
| `currency` | query | string | ❌ | `DRIED_FISH` | 币种 |

**响应 200：**
```json
{
    "code": 200,
    "data": {
        "entries": [
            {
                "id": "entry-uuid",
                "transaction_id": "tx-uuid",
                "direction": "DEBIT",
                "amount": 3.0,
                "entry_type": "checkin",
                "description": "每日签到（运势值 3）",
                "counterparty": "raricy-blog-system",
                "balance_after": 18.5,
                "metadata": {
                    "fortune_value": 3,
                    "checkin_date": "2026-07-02"
                },
                "created_at": "2026-07-02T12:00:00Z"
            }
        ],
        "pagination": {
            "page": 1,
            "per_page": 20,
            "total": 156,
            "pages": 8,
            "has_prev": false,
            "has_next": true
        }
    },
    "request_id": "..."
}
```

**关于 `balance_after`：**

每笔 entry 后的余额。这是实时计算的——查询时对每条 entry，按时间顺序累积 `DEBIT - CREDIT`。对于分页查询，需要先确定第一页的"期初余额"，然后逐条叠加。

这个字段是可选的（查询开销略高）。如果不传 `include_balance=true`（未来可加此参数），则不计算 `balance_after`。

---

## 4. 错误码汇总

| HTTP 状态码 | code | 含义 |
|-------------|------|------|
| 200 | 200 | 成功 |
| 201 | 201 | 创建成功（账户创建） |
| 400 | 400 | 请求参数错误或余额不足 |
| 401 | 401 | API Key 无效（格式错误、已撤销、不存在） |
| 403 | 403 | API Key 有效但不属于 `from_user_id`（试图花别人的钱） |
| 404 | 404 | 资源不存在 |
| 409 | 409 | 幂等键冲突（相同 key 但不同请求体） |
| 422 | 422 | Pydantic 参数校验失败 |
| 429 | 429 | 请求频率超限 |
| 500 | 500 | 内部服务错误 |
| 503 | 503 | 数据库不可用 |

---

## 5. 与博客现有 API 的对照迁移表

| 博客现有接口 | 新账户服务接口 | 变化 |
|-------------|---------------|------|
| `GET /auth/fish/api/balance` | `GET /api/v1/accounts/{user_id}/balance` | user_id 从 session 变为 path param；调用方需要传 user_id |
| `POST /auth/fish/api/balance/batch` | `POST /api/v1/accounts/balances/batch` | 接口格式一致 |
| `GET /auth/fish/api/balance/<user_id>` | `GET /api/v1/accounts/{user_id}/balance` | 路径统一 |
| `GET /auth/fish/api/transactions?page=&type=` | `GET /api/v1/accounts/{user_id}/ledger?page=&entry_type=` | `type` 重命名为 `entry_type`；增加日期筛选 |
| `GET /auth/fish/api/leaderboard` | `GET /api/v1/accounts/leaderboard` *(未来)* | 不变，但底层从物化视图读 |
| CLI: `flask fish grant` | 博客 CLI → `POST /api/v1/transfers` | 博客 CLI 变成 HTTP client 调用 |
| (无 — 用户注册时) | `POST /api/v1/accounts` | 新增：注册时创建账户 |

---

## 6. 频率限制

| 接口 | 限制 | 说明 |
|------|------|------|
| `GET /balance` | 100 次/秒/服务 | 余额查询高频，宽松限制 |
| `POST /balances/batch` | 20 次/秒/服务 | 批量查询 |
| `POST /transfers` | 10 次/秒/服务 | 转账低频，严格限制 |
| `GET /ledger` | 30 次/秒/服务 | 流水查询 |

频率限制用 FastAPI 的 `slowapi` 中间件实现，基于服务 IP 计数（不是用户 ID——因为调用方是博客后端，只有一个 IP）。
