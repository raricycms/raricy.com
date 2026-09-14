# 鱼干机器人接入说明（无状态接口）

> 面向站外开发者。**读完本文即可写一个会转账的机器人，无需阅读本站源码。**
>
> 本文是这几个接口的唯一对外口径。字段、限频数值、错误码均照实抄录，
> 若与源码不符以源码为准（也请提 issue —— 那就是本文过期了）。

## 0. 一句话说清

**这条路径不需要先登录。** 把 `username` + `password` 放进请求体，
一次 POST 就完成一笔转账（或查余额 / 查流水）—— 不签发 cookie、不要求先调
`/api/auth/login`，因此运行环境不需要保存会话。

```bash
curl -X POST https://raricy.com/api/fish/market/transfer \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "mybot",
    "password": "********",
    "to_username": "alice",
    "amount": 1
  }'
```

> ⚠️ **先读 §1 的「重试 = 再转一笔」。** 这是本文档里最容易让机器人亏钱的一条。

## 1. 能力边界与三条硬约束

| 能做什么 | 接口 |
|----------|------|
| 从**自己**的账号转出鱼干给任意用户（零手续费） | `POST /api/fish/market/transfer` |
| 查**自己**的余额 | `POST /api/fish/market/balance` |
| 查**自己**的流水 | `POST /api/fish/market/transactions` |

三条硬约束：

1. **只能动自己的账号。** 凭据是谁的，就只能以谁的名义转账/查询 ——
   没有「管理员代操作」这类接口。
2. **重试 = 再转一笔。** 服务端**不做请求去重**：每一次成功返回 200 的调用都是
   一笔新交易（幂等键带随机后缀，见 §6）。网络超时**不代表**没成交 ——
   请先查流水（`transfer_all`）确认，再决定要不要重发。**别无脑重试。**
3. **被禁言的账号一律 403**，机器人没有豁免。出问题时站长能像处理普通用户一样处理它。

## 2. 鉴权

### 2.1 两种方式，二选一

| 方式 | 怎么带 | 适用 |
|------|--------|------|
| **会话（浏览器）** | Cookie `raricy_session` | 站内页面；脚本若已 `POST /api/auth/login` 也可以 |
| **凭据（本文档）** | body 里的 `username` + `password` | 站外脚本 / 机器人：单次发包、无状态 |

同时给出两者时**以会话为准**（浏览器里带着登录态又传凭据属误用，按会话走不会出现
「用自己的号却按别人的号记账」）。

### 2.2 凭据说明

- `username` 字段**用户名或邮箱都认**（与网页登录一致）。
- 校验的是账号密码本身（werkzeug/scrypt 哈希），与网页登录**完全同一份凭据**：
  改密码后旧凭据立即失效。
- 密码只用于本次校验：不写日志、不回显、不落库、不换取任何长期凭证。

## 3. 接口

所有接口：`POST`，`Content-Type: application/json`，成功一律返回
`{"code": 200, ...}`（另有 HTTP 200）。

> **为什么查余额/流水也是 POST**：凭据必须放在请求体里。GET 只能把密码塞进 URL，
> 那会原样进 nginx access log、浏览器历史、Referer —— 等于把密码写进日志文件。

### 3.1 转账

```http
POST /api/fish/market/transfer
{
  "username": "mybot",        // 必填（无会话时）
  "password": "********",     // 必填（无会话时）
  "to_username": "alice",     // 收款人，二选一：用户名
  "to_user_id": "u_xxx",      //           或用户 id
  "amount": 1,                // 必填，> 0 且最多 1 位小数（最小 0.1）
  "note": "机器人转账"        // 可选，≤ 30 字，双方流水里都能看到
}
```

成功：

```json
{
  "code": 200,
  "message": "已转给 alice 1 条小鱼干",
  "amount": 1,
  "balance": 41.5,
  "recipient": { "id": "u_xxx", "username": "alice" }
}
```

`balance` 是转账**之后**发送者的余额（鱼干）。收款人会收到一条站内通知。

字段口径：

| 字段 | 规则 |
|------|------|
| `amount` | 必须是数字或数字字符串；`> 0`；**最多 1 位小数**（`0.1` 起，`0.05` → 400）。鱼干在库内是 0.1 的整数倍，投喂分成产生的小数（如 `3.8`）可以原样转出 |
| 收款人 | `to_username` 精确匹配（区分大小写）；用户名不存在 → 404。两个都没给 → 400 |
| `note` | 超过 30 字 → 400（不静默截断）；换行/连续空白会被压成单个空格 |
| 给自己转 | 400 |

### 3.2 查余额

```http
POST /api/fish/market/balance
{ "username": "mybot", "password": "********" }
```

```json
{ "code": 200, "message": "ok", "user_id": "u_xxx", "username": "mybot", "balance": 42.5 }
```

### 3.3 查流水

```http
POST /api/fish/market/transactions
{
  "username": "mybot",
  "password": "********",
  "page": 1,            // 可选，默认 1（非法值回落默认，不报错）
  "per_page": 20,       // 可选，默认 20，上限 100
  "type": "transfer_all" // 可选，与网页筛选条同口径
}
```

`type` 取值：`checkin`（签到）/ `feed_all`（投喂，含收与支）/ `transfer_all`
（转账，含转出与转入）/ `admin_grant`（管理员赠送）/ `system_compensate`（系统补偿）。
不传则返回全部。

```json
{
  "code": 200,
  "message": "ok",
  "user_id": "u_xxx",
  "username": "mybot",
  "transactions": [
    {
      "id": 123,
      "amount": -1,
      "type": "transfer",
      "description": "转给「alice」：机器人转账",
      "referenceType": "user",
      "referenceId": "u_alice",
      "relatedUserId": "u_alice",
      "createdAt": "2026-09-14T11:52:03.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "per_page": 20,
  "pages": 1,
  "has_prev": false,
  "has_next": false
}
```

> `amount` 正数为入账、负数为支出；单位是**鱼干**。`createdAt` 是本站时钟
> （UTC+8 墙上时间贴 Z 标签，见 `docs/architecture.md` §6.2），**不是**标准 UTC 瞬间。

## 4. 限频

| 维度 | 配额 | 说明 |
|------|------|------|
| 无状态接口 · 每账号 | **20 次/分钟** | **成功也计数** —— 每次请求都要跑一次 scrypt（密码哈希校验），不封顶就是 CPU 放大器 |
| 无状态接口 · 每 IP | **120 次/分钟** | 同上，成功也计数 |
| 凭据校验失败 · 每账号 | **100 次/15 分钟** | 与网页登录 `/api/auth/login` **共用同一个桶**（同一份凭据、同一个预算） |
| 凭据校验失败 · 每 IP | **300 次/15 分钟** | 同上 |
| 转账 · 每发送者 | **30 次/小时**、**200 次/天** | 参数校验一过就计数（余额不足也算一次：它在计数之后才被判）；金额非法 / 收款人不存在 / 给自己转在计数**之前**被拒，不占额度 |

超限一律 **429**。设计意图：

- 正常机器人（几分钟查一次余额、偶尔转一笔）离配额很远；
- 循环里 `while(true) transfer` 的写法会在 20 次/分钟后被挡；
- 撞库从哪个门进来都一样贵（与网页登录共用失败预算）。

## 5. 错误码

| HTTP | 何时 | 机器人该怎么做 |
|------|------|----------------|
| 400 | 金额非法 / 超 1 位小数 / 余额不足 / 给自己转 / 缺收款人 / 留言超长 | 改参数，别重试 |
| 401 | 用户名或密码错误 / 两边都没带凭据 | 检查凭据（用户不存在与密码错误**返回同一条文案**，不给枚举留信道） |
| 403 | 账号被禁言 | 停手，联系站长 |
| 404 | `to_username` 不存在 | 检查用户名 |
| 429 | 见 §4 | 退避；**不要**立刻重试 |
| 503 | 账户微服务不可用 | 本地写入已被补偿回滚（等价于这笔没发生），可稍后重试**一次** |

非 JSON 请求体 → 400；`username`/`password` 字段缺失（且无会话）→ 401。

## 6. 幂等与重试（读两遍）

服务端**不做请求去重**。每次成功返回 200 的转账都是一笔真实成交：

- 幂等键由服务端生成（`transfer-{hash}-{时间戳}-{随机后缀}`），
  **随机后缀保证两笔同额转账不会被账户服务当成重放静默吞掉** ——
  这是保证「两次转账真的转两次」的机制，不是去重机制；
- 因此**网络超时 / 连接中断时，你无法从本地状态判断这笔到底成没成**。
  正确做法：先查流水（`type: "transfer_all"`）看有没有这笔，再决定是否重发；
- 服务端的账本（`account_sync_ledger`）保证「本地记了账 ⇒ 远端一定也记了」，
  但**不保证**「你发了一次 ⇒ 只成交一笔」—— 后者要由调用方自己保证。

## 7. 安全建议

1. **给机器人单独建号**，不要拿站长/主账号的密码跑脚本 ——
   凭据泄露的损失以那个账号的鱼干余额为上限。
2. **只给它需要的鱼干量**。转账不可撤回，机器人被劫持 = 余额被搬空。
3. 凭据**只放在请求体里**，走 HTTPS。别写进 URL、别写进前端页面、
   别提交进代码仓库（用环境变量）。
4. 密码即身份：这个接口的强度**等于**密码的强度。定期更换，
   改了密码记得同步机器人配置（旧凭据立即失效）。
5. 机器人**也会被禁言**、也会被限频 —— 这不是 bug，是刻意的：出问题时站长
   能用处理普通用户的手段处理它，不需要额外的黑名单机制。

## 8. 一个完整的例子

```bash
BASE=https://raricy.com
USER=mybot
PASS=$BOT_PASSWORD   # 环境变量，别写死在脚本里

# 1. 先看看还有多少鱼干
curl -s -X POST $BASE/api/fish/market/balance \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}"

# 2. 转账 1 条给 alice
curl -s -X POST $BASE/api/fish/market/transfer \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\",\"to_username\":\"alice\",\"amount\":1,\"note\":\"谢谢帮忙\"}"

# 3. 超时了？先查最近 5 条流水，别急着重发
curl -s -X POST $BASE/api/fish/market/transactions \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\",\"type\":\"transfer_all\",\"per_page\":5}"
```
