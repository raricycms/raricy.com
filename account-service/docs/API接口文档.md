# API 接口文档

> **文档版本**：与代码 v0.1.0 同步，最后更新 2026-07-03

## 通用约定

### 基础 URL

```
http://<host>:8000
```

### 认证

**所有端点**必须携带 `X-Internal-Token` header（博客与 account-service 之间的共享密钥）。

**转账端点**额外要求 `Authorization: Bearer <api_key>`，且 API Key 必须属于 `from_user_id`。

```
X-Internal-Token: <共享密钥>
Authorization: Bearer fish_sk_<32字节随机>
```

### 响应格式

#### 成功

```json
{
  "code": 200,
  "data": { ... },
  "request_id": "a1b2c3d4-...",
  "message": "ok"
}
```

`code` 字段反映 HTTP 状态码。`data` 结构因接口而异。

#### 错误

```json
{
  "code": 401,
  "message": "Invalid or missing internal token",
  "detail": null,
  "request_id": "a1b2c3d4-..."
}
```

### 速率限制

| 端点 | 限制 |
|------|------|
| `POST /api/v1/accounts` | 20/秒 |
| `GET /api/v1/accounts/{user_id}/balance` | 100/秒 |
| `POST /api/v1/accounts/balances/batch` | 20/秒 |
| `POST /api/v1/transfers` | 10/秒 |
| `GET /api/v1/accounts/{user_id}/ledger` | 30/秒 |

超限返回 429 Too Many Requests。

### 金额精度

所有 `amount` 和 `balance` 字段使用 **自然单位**（1 = 1 小鱼干）。Pydantic 自动将字符串或数字转为 Decimal，**推荐使用字符串**（如 `"3.0"`）以避免浮点精度损失。服务端以 BIGINT 内部单位存储（1 小鱼干 = 10,000 内部单位）。

---

## 接口列表

### 1. 健康检查

```
GET /health
```

**无需认证。**

**响应 200：**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "db": "connected"
}
```

`status` 可能值：`"ok"`（数据库可连接）、`"degraded"`（数据库不可达）。

---

### 2. 开户

```
POST /api/v1/accounts
```

创建新账户，或认领已存在的未认领账户，或返回已存在的已认领账户信息。

**请求头：**
```
Content-Type: application/json
X-Internal-Token: <token>
```

**请求体：**

```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "currency": "DRIED_FISH"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | 是 | 博客系统的用户 UUID，最长 36 字符 |
| `currency` | string | 否 | 币种代码，默认 `DRIED_FISH`，格式 `^[A-Z_]{1,20}$` |

**响应 201（新创建或认领成功）：**

```json
{
  "code": 201,
  "data": {
    "account_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "currency": "DRIED_FISH",
    "balance": "0.0",
    "api_key": "fish_sk_abc123def456...",
    "created_at": "2026-07-02T12:00:00Z"
  },
  "request_id": "...",
  "message": "ok"
}
```

**响应 200（账户已存在且已认领）：**

```json
{
  "code": 200,
  "data": {
    "account_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "currency": "DRIED_FISH",
    "balance": "42.5",
    "created_at": "2026-07-02T12:00:00Z"
  },
  "request_id": "...",
  "message": "ok"
}
```

> **注意：** 200 响应 **不含** `api_key` 字段。API Key 仅在创建/认领时返回一次。

**三种情况：**

| 账户状态 | 响应码 | 是否返回 API Key |
|----------|--------|------------------|
| 不存在 | 201 | ✅ 是（新生成） |
| 未认领（由转账自动创建） | 201 | ✅ 是（认领生成） |
| 已认领 | 200 | ❌ 否 |

**错误：**
| 状态码 | 说明 |
|--------|------|
| 401 | `X-Internal-Token` 缺失或无效 |
| 422 | 请求体格式错误（如 `user_id` 超长、`currency` 格式不符） |

---

### 3. 查询余额

```
GET /api/v1/accounts/{user_id}/balance?currency=DRIED_FISH
```

**请求头：**
```
X-Internal-Token: <token>
```

**路径参数：**
| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 博客系统的用户 UUID |

**查询参数：**
| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `currency` | string | 否 | `DRIED_FISH` | 币种代码 |

**响应 200：**

```json
{
  "code": 200,
  "data": {
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "currency": "DRIED_FISH",
    "balance": "42.5",
    "updated_at": "2026-07-02T12:30:00Z"
  },
  "request_id": "...",
  "message": "ok"
}
```

> **用户不存在时返回 `balance: "0.0"` 和 `updated_at: null`，不返回 404。**

---

### 4. 批量查询余额

```
POST /api/v1/accounts/balances/batch
```

**请求头：**
```
Content-Type: application/json
X-Internal-Token: <token>
```

**请求体：**

```json
{
  "user_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660e8400-e29b-41d4-a716-446655440001"
  ],
  "currency": "DRIED_FISH"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_ids` | string[] | 是 | 用户 ID 列表，最少 1 个，最多 100 个 |
| `currency` | string | 否 | 币种代码，默认 `DRIED_FISH` |

**响应 200：**

```json
{
  "code": 200,
  "data": {
    "balances": {
      "550e8400-e29b-41d4-a716-446655440000": "42.5",
      "660e8400-e29b-41d4-a716-446655440001": "0.0"
    },
    "currency": "DRIED_FISH"
  },
  "request_id": "...",
  "message": "ok"
}
```

> 不存在的 `user_id` 对应余额为 `"0.0"`。

**错误：**
| 状态码 | 说明 |
|--------|------|
| 422 | `user_ids` 为空或超过 100 个 |

---

### 5. 转账

```
POST /api/v1/transfers
```

核心接口——执行一笔复式记账转账。每笔转账产生两条流水（一个 CREDIT + 一个 DEBIT）。

**请求头：**
```
Content-Type: application/json
X-Internal-Token: <token>
Authorization: Bearer fish_sk_<from_user的API Key>
X-Idempotency-Key: <唯一幂等键>
```

`X-Idempotency-Key` 格式要求：1-64 字符，仅允许 `[a-zA-Z0-9_-]`。

**请求体：**

```json
{
  "from_user_id": "00000000-0000-0000-0000-000000000000",
  "to_user_id": "550e8400-e29b-41d4-a716-446655440000",
  "amount": "3.0",
  "currency": "DRIED_FISH",
  "entry_type": "checkin",
  "description": "每日签到（运势值 3）",
  "metadata": {
    "fortune_value": 3
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `from_user_id` | string | 是 | 转出方用户 ID，最长 36 字符 |
| `to_user_id` | string | 是 | 接收方用户 ID，最长 36 字符 |
| `amount` | Decimal (>0) | 是 | 转账金额（自然单位），字符串 `"3.0"` 或数字 `3.0` 均可（推荐字符串） |
| `currency` | string | 否 | 币种代码，默认 `DRIED_FISH` |
| `entry_type` | string | 是 | 业务类型，最长 32 字符。见下方枚举表 |
| `description` | string | 否 | 人类可读描述，最长 255 字符 |
| `metadata` | object | 否 | 任意业务上下文（如 `{"fortune_value": 3, "blog_id": "..."}`） |

**entry_type 常用值：**

| 值 | 含义 | 典型场景 |
|----|------|---------|
| `checkin` | 签到 | 系统 → 用户 |
| `admin_grant` | 管理员发放 | 系统 → 用户 |
| `feed_consume` | 投喂支出 | 用户 → 系统（投喂者扣 100% 鱼干） |
| `feed_income` | 被投喂收入 | 系统 → 用户（被打赏者获分成，目前为 80%） |
| `transfer` | 转账 | 用户 → 用户 |
| `purchase` | 购买 | 用户 → 系统 |

**响应 200：**

```json
{
  "code": 200,
  "data": {
    "transaction_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "from_user_id": "00000000-0000-0000-0000-000000000000",
    "to_user_id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": "3.0",
    "currency": "DRIED_FISH",
    "entry_type": "checkin",
    "from_balance_after": "-999999.0",
    "to_balance_after": "3.0",
    "created_at": "2026-07-02T12:00:00Z"
  },
  "request_id": "...",
  "message": "ok"
}
```

**错误：**

| 状态码 | 说明 |
|--------|------|
| 400 | 余额不足（非系统账户）。响应含 `detail.required` 和 `detail.available` |
| 400 | `X-Idempotency-Key` 缺失或格式非法 |
| 401 | `X-Internal-Token` 缺失或无效 |
| 401 | API Key 无效（`Authorization` header 缺失或 key 不存在） |
| 403 | API Key 不属于 `from_user_id`（key 与声明的发送方不匹配） |
| 409 | 幂等键冲突：同一 key 但请求体不同 |

**幂等行为：**
- 相同 key + 相同请求体 → 返回缓存的转账结果（200），不重复执行
- 相同 key + 不同请求体 → 409 Conflict
- Key 24 小时后过期，过期后可重用

**自动开户：**
- 如果 `to_user_id` 对应的账户不存在，自动创建（但 `api_key_hash = NULL`，处于"未认领"状态）
- 如果 `from_user_id` 账户未认领（`api_key_hash = NULL`），转账会因无法通过 API Key 认证而失败

**系统账户透支：**
- `from_user_id` 为系统账户（`raricy-blog-system`）时，跳过余额检查，允许透支

---

### 6. 交易流水

```
GET /api/v1/accounts/{user_id}/ledger
```

**请求头：**
```
X-Internal-Token: <token>
```

**路径参数：**
| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 用户 ID |

**查询参数：**
| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | int | 否 | `1` | 页码（1-based），≥1 |
| `per_page` | int | 否 | `20` | 每页条数，1-100 |
| `currency` | string | 否 | `DRIED_FISH` | 币种代码 |
| `entry_type` | string | 否 | — | 类型筛选，逗号分隔（如 `checkin,admin_grant`） |
| `start` | date | 否 | — | 起始日期（含），格式 `YYYY-MM-DD` |
| `end` | date | 否 | — | 结束日期（含），格式 `YYYY-MM-DD` |

**响应 200：**

```json
{
  "code": 200,
  "data": {
    "entries": [
      {
        "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "transaction_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "direction": "DEBIT",
        "amount": "3.0",
        "entry_type": "checkin",
        "description": "每日签到（运势值 3）",
        "counterparty": "raricy-blog-system",
        "balance_after": "3.0",
        "metadata": {
          "fortune_value": 3
        },
        "created_at": "2026-07-02T12:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "per_page": 20,
      "total": 1,
      "pages": 1,
      "has_prev": false,
      "has_next": false
    }
  },
  "request_id": "...",
  "message": "ok"
}
```

**条目字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `direction` | string | `DEBIT`（收到，钱**进入**本账户）或 `CREDIT`（支出，钱**离开**本账户）。余额公式：`SUM(DEBIT) − SUM(CREDIT)` |
| `amount` | string | 金额（自然单位） |
| `counterparty` | string\|null | 对手方用户 ID |
| `balance_after` | string | 该笔交易后的 running balance |
| `metadata` | object | 转账时传入的业务上下文 |

> 用户不存在时返回空列表，不返回 404。

---

## 错误码速查

| 状态码 | 含义 | 常见原因 |
|--------|------|---------|
| 200 | 成功 | — |
| 201 | 已创建 | 开户/认领成功 |
| 400 | 请求错误 | 余额不足、幂等键格式非法、幂等键缺失 |
| 401 | 未认证 | `X-Internal-Token` 缺失/无效 或 API Key 无效 |
| 403 | 禁止 | API Key 不属于声明的 `from_user_id` |
| 404 | 未找到 | —（本服务目前不使用此状态码） |
| 409 | 冲突 | 幂等键相同但请求体不同 |
| 422 | 校验失败 | 请求体格式错误（Pydantic 校验失败） |
| 429 | 请求过多 | 触发速率限制 |
| 500 | 服务器错误 | 内部异常（DEBUG 模式下返回异常类型名） |
