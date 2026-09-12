# 聊天机器人接入说明

> 面向站外开发者。**读完本文即可实现一个聊天机器人，无需阅读本站源码。**
>
> 本文是接口契约的唯一对外口径。字段、限频数值、错误码均照实抄录，
> 若与源码不符以源码为准（但也请提 issue —— 那就是本文过期了）。

## 0. 一句话说清

**没有专用的「机器人接口」。** 机器人就是**一个普通的 core+ 用户账号**，
走和对人完全一样的 HTTP 接口。你需要的只有三件事：

1. 一个 core+ 账号（§2）
2. 一条 SSE 长连接收消息（§6）
3. 一个 POST 发消息（§7）

无需申请 token、无需白名单、无需站长开任何开关。

---

## 1. 能力边界（先读这段）

机器人账号能看到什么，完全由「它是不是这个会话的成员」决定：

| 范围 | 能读 | 能发 | 说明 |
|------|:----:|:----:|------|
| **大区**（`channel_id` = `lobby`） | ✅ | ✅ | 任何 core+ 都可读写，**不需要加入成员表** |
| **私聊**：别人主动发给机器人 | ✅ | ✅ | 机器人在成员表里 |
| **私聊**：机器人主动发起 | ✅ | ✅ | 见 §9.1 用户搜索 |
| **私聊**：别人与别人之间 | ❌ | ❌ | 非成员，读返回 403 / 404 |

**大区是全局唯一的**，其频道 id 字面量就是字符串 `lobby`，不随部署变化。

> ⚠️ 机器人**享受不到任何豁免**：它同样受限频约束（§10），也同样**会被禁言**
> （被禁言期间所有聊天接口返回 `403 你已被禁言，暂时无法聊天`）。
> 这是刻意设计——出问题时站长能像处理普通用户一样处理它。

---

## 2. 准备账号

### 2.1 注册

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "mybot",
  "email": "bot@example.com",
  "password": "********",
  "invite_code": "可选，填有效邀请码则直接升为 core",
  "turnstileToken": "可选，站点启用 Turnstile 时必填"
}
```

校验规则：

| 字段 | 规则 |
|------|------|
| `username` | 3–20 字符；仅允许字母 / 数字 / `_` / `-`；不能以 `-` 或 `_` 开头或结尾 |
| `email` | 常规邮箱格式，≤100 字符 |
| `password` | ≤100 字符 |

**成功即自动登录**（响应会 `Set-Cookie`，见 §3）：

```json
{
  "code": 200,
  "message": "注册成功",
  "user": { "id": "u_xxx", "username": "mybot", "role": "user" }
}
```

> 📌 **注册需由人工完成一次，这是预期流程。** 机器人账号**不开放脚本自助注册**
> （数量有限）。此外，站点若启用了人机验证（Turnstile），脚本同样无法自行注册。
>
> 做法：由人工在浏览器里建号一次，之后机器人用账号密码登录即可 ——
> 后续所有交互都不再涉及人机验证。

### 2.2 提权到 core+

注册出来是 `user`，**聊天接口要求 core+**，否则一律 `403 需要核心用户权限`。
两条路：

- **注册时带有效邀请码** → 直接是 core（推荐，全自动）；
- **让站长在服务器上执行**：`npm run cli -- promote-core mybot`

---

## 3. 鉴权

本站**没有 Bearer token**，会话是一个 HttpOnly Cookie。流程：

```http
POST /api/auth/login
Content-Type: application/json

{ "username": "mybot", "password": "********" }
```

响应头：

```
Set-Cookie: raricy_session=<JWT>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000
```

| 属性 | 值 |
|------|-----|
| Cookie 名 | `raricy_session` |
| 有效期 | **30 天** |
| `HttpOnly` | 是 |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | 站点走 HTTPS 时为是 |

之后**每个请求带上** `Cookie: raricy_session=<JWT>` 即可。

响应体：

```json
{ "code": 200, "message": "登录成功",
  "user": { "id": "u_xxx", "username": "mybot", "role": "core" } }
```

### 3.1 三个必须处理的点

1. **Cookie 会过期**（30 天）。收到 `401` 就重新登录一次，然后**重连 SSE**。
2. **会话会被主动作废**：改密码、被降权等都会让旧 Cookie 立刻失效（服务端有
   `session_version` 快照机制）。表现同样是 `401`。
3. **CSRF 校验对你无影响。** 本站对写请求校验 `Origin` / `Referer` 同源，
   **但两者都缺失时放行**。非浏览器客户端本来就不发这两个头 → 天然通过。
   ⚠️ 所以**不要**自作主张伪造一个 `Origin`，写错反而会被判定为跨源而 403。

### 3.2 会话是否仍有效

```http
GET /api/auth/me
```

`200` 返回当前用户；`401` 表示需要重新登录。适合在重连前探活。

---

## 4. 响应信封与错误码

**所有** JSON 接口共用同一信封（SSE 除外，见 §6）：

```json
{ "code": 200, "message": "ok", ...其他数据字段 }
```

出错时 `code` 与 HTTP 状态码一致，且**只有** `code` 和 `message`：

```json
{ "code": 403, "message": "需要核心用户权限" }
```

成功时 `message` 通常是 `"ok"` 或一句中文提示（如 `"登录成功"`）。

> ⚠️ **有一个例外**：发送消息接口（§7）成功时 `message` 是一个**对象**而非字符串。
> 已在 §7.2 单独说明 —— 无论哪个接口，**判断成功请一律只看 `code`**。

| 状态码 | 含义 | 常见 message |
|--------|------|--------------|
| `400` | 参数错误 | `请求体格式错误` / `用户名和密码不能为空` |
| `401` | 未登录 / 会话失效 | `请先登录` / `用户名或密码错误` |
| `403` | 权限不足 / 被禁言 / 跨源 | `需要核心用户权限` / `你已被禁言，暂时无法聊天` / `跨源请求被拒绝 (CSRF)` |
| `404` | 频道不存在或不可见 | `频道不存在` |
| `429` | 触发限频 | `操作过于频繁，请稍后再试` |
| `503` | 服务暂时不可用 | — |

> ⚠️ **一律 `Cache-Control: no-store`**，别在客户端缓存这些响应。

---

## 5. 时间戳格式

消息里的 `created_at` 是字符串，格式为 `"YYYY-MM-DD HH:MM:SS"`（如
`"2026-09-11 20:31:05"`）。

> 这是**东八区墙上时间**，字符串里**不带时区标记**，也**不是 UTC**。
> 若你的机器人要按真实时刻计算，需自行按 UTC+8 解释。
> 直接原样展示给用户则不会有问题。

---

## 6. 收消息：SSE 长连接

```http
GET /api/chat/stream
Cookie: raricy_session=<JWT>
Accept: text/event-stream
```

**一条连接覆盖机器人可见的全部频道**——大区广播 + 它的所有私聊。
不用轮询、不用分频道建连。

### 6.1 帧格式

标准 SSE 帧，事件类型放在 **JSON 体内**（而不是 SSE 的 `event:` 字段），
所以只需监听默认消息事件：

```
id: 12345
data: {"type":"message","channel_id":"lobby","message":{...}}

```

`id:` **只出现在消息事件上**，用于断线补齐（§6.3）。

连接建立时服务端会先发一帧：

```
retry: 3000

: connected

```

即「断线后 3 秒重连」+ 一个注释帧（用于立刻产生字节，避免被中间层当成空响应）。

### 6.2 四种事件

| `type` | 载荷字段 | 含义 |
|--------|----------|------|
| `message` | `channel_id`, `message` | 一条新消息（含你自己发的，用于多端同步） |
| `resync` | — | 积压太多补不齐，**请重新拉取**（§6.3） |
| `typing` | `channel_id`, `user_id`, `username` | 有人正在输入（不落库，3 秒后自行忽略） |
| `read` | `channel_id`, `user_id`, `message_id` | 私聊已读回执 |

`message` 事件的 `message` 字段就是 §11.1 的 `ChatMessageDTO`。

### 6.3 断线补齐（重要）

SSE 原生支持断线续传，**请务必实现**，否则断线期间的消息会永久丢失：

1. 客户端记住收到的**最后一个 `id:` 值**；
2. 重连时把它放进请求头 `Last-Event-ID: <该值>`；
3. 服务端把 `id` 大于它的消息按序补发；
4. 若积压超过 **100 条**补不齐，服务端改发一帧 `{"type":"resync"}`；
5. 收到 `resync` → 自己重新 `GET /api/chat/channels/lobby/messages`（§8）
   拉一次当前首页，把状态对齐。

### 6.4 会被服务端主动断开的情形

- **背压**：未消费帧积压超过 **512** 帧 → 视为客户端卡死，断开（重连+补齐即可）。
- **权限变更**：被禁言 / 降权 / 开启专注模式 → 旧连接被踢，重连时重新鉴权。
- **网络**：按 `retry: 3000` 的节奏自动重连。

> 断开是**常态**，不是错误。一个健壮的机器人应当把「断开 → 重连 → 补发」
> 做成默认路径，而不是异常分支。

### 6.5 服务端响应头（无需处理，但别自作聪明）

服务端会带 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`。
**这不是给你的**，是为了绕过 Next 的压缩中间件和 nginx 缓冲，否则事件会被攒着
一次性发出、实时性归零。你用普通 SSE 客户端读即可，**不要**尝试自己加
`Accept-Encoding` 或改动这些头。

---

## 7. 发消息

大区的 `channel_id` 固定为 `lobby`：

```http
POST /api/chat/channels/lobby/messages
Cookie: raricy_session=<JWT>
Content-Type: application/json

{ "content": "你好，我是机器人" }
```

### 7.1 请求字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `content` | string | 否* | 正文，**按 Markdown 渲染**（见 §7.3） |
| `image_id` | string | 否 | 引用图床图片，需先上传（§9.2） |
| `blog_id` | string | 否 | 引用一篇博客（UUID） |
| `reply_to` | number | 否 | 引用回复的消息 id，须**同频道且未删除** |
| `pat_target_id` | string | 否 | 「拍一拍」目标用户 id。**非空即拍一拍消息**，此时正文/图片一律被忽略 |

\* 至少要有一个有效载荷，否则会报参数错误。

### 7.2 成功响应（⚠️ 信封例外）

**这个接口的 `message` 字段是对象，不是字符串** —— 见下方警告：

```json
{ "code": 200, "message": { /* ← 这里直接是 ChatMessageDTO，见 §11.1 */ } }
```

> ⚠️ **不要按 §4 的常规信封解析本接口。** 本站其他接口的 `message` 都是
> 人类可读的提示字符串，唯独发送消息这个接口，`message` 字段被消息对象
> **覆盖**了（服务端实现里 `data` 的展开顺序导致了覆盖，原本的 `"发送成功"`
> 提示被丢弃）。
>
> 稳妥的写法：**成功只看 `code === 200`**，然后再去取消息对象，不要依赖
> `message` 是字符串。如果你的客户端此前按字符串处理，这里会拿到一个对象。

### 7.3 正文是 Markdown，但有白名单

正文经 `marked` → `DOMPurify` 白名单净化后渲染。**允许的标签**：

```
p br hr strong b em i u s del code pre blockquote ul ol li a
h1 h2 h3 h4 h5 h6 table thead tbody tr th td input
```

要点：

- ✅ 支持 GFM 任务列表（`- [x] 完成`）、表格、代码块、引用、链接
- ❌ **不支持 `<img>`** —— 白名单里没有。贴图必须走 `image_id`（§9.2）
- ❌ 不支持 `<iframe>` / `<svg>` / `<style>` / `<form>`
- 链接会自动加 `rel`/`target` 加固，类名为 `chat-msg__link`

> 发出去的原文**原样入库**，净化只发生在渲染时。所以你可以放心发 Markdown 源文。

---

## 8. 读历史消息

```http
GET /api/chat/channels/lobby/messages?limit=50
GET /api/chat/channels/lobby/messages?before=1000&limit=50
GET /api/chat/channels/lobby/messages?after=1000&limit=50
```

| 查询参数 | 说明 |
|----------|------|
| `limit` | 1–100，默认 **50**（超出会被夹到区间内） |
| `before` | 取 id **小于**它的消息（向历史回溯） |
| `after` | 取 id **大于**它的消息（追赶新消息） |

三者关系：`after` 优先于 `before`；都不给则取**最新的一页**。

**返回的 `messages` 一律按 id 升序**（从旧到新），无论你用的是哪种模式。

响应：

```json
{ "code": 200, "message": "ok", "messages": [ /* ChatMessageDTO[] */ ] }
```

> 💡 **消息 id 是全局自增的**（大区和所有私聊共用一个序列）。所以 id 可以直接
> 当作全局游标使用，不需要按频道分别维护。

---

## 9. 其他可能用到的接口

### 9.1 搜索用户（用于主动私聊）

```http
GET /api/chat/users?q=<关键词>&limit=30&offset=0
```

返回 `core+` 用户（排除自己）。拿到 `user_id` 后发起私聊：

```http
POST /api/chat/channels
{ "user_id": "u_xxx" }
```

响应里的 `channel.id` 就是私聊的 `channel_id`，之后与使用 `lobby` 完全一致。
**已存在的会话会被复用**，不会重复创建。

> 此接口限频 `20 次/分钟`（防脚本批量建空会话骚扰他人侧栏）。

### 9.2 上传图片（正文不能贴图）

```http
POST /api/images
Content-Type: multipart/form-data

<二进制文件>
```

返回的图片 id 即发消息时的 `image_id`。限频 **75 次/小时**。

---

## 10. 限频

**这是最容易踩的坑，请按此设计机器人行为。**

| 规则 | 额度 | 适用 |
|------|------|------|
| `chatMinute` | **30 次 / 分钟** | 发消息 |
| `chatDaily` | **800 次 / 24 小时** | 发消息 |
| `chatPoll` | 120 次 / 分钟 | 历史消息接口（§8 全系列） |
| `chatNewChannel` | 20 次 / 分钟 | 发起私聊（§9.1） |
| `imageUploadHourly` | 75 次 / 小时 | 上传图片（§9.2） |
| `loginPerIp` | 300 次 / 15 分钟 | 登录，**仅统计失败** |
| `loginPerUser` | 100 次 / 15 分钟 | 登录，**仅统计失败** |

超限一律 `429`。两点提醒：

- **登录成功不消耗配额**（只统计失败），所以定时重登不会把自己挡在门外。
- **`chatDaily` 每天 800 条是硬上限。** 一个「看到消息就回」的机器人很容易烧光，
  然后当天彻底哑火。**建议只回应 @ 到自己的消息**（`content` 里出现 `@mybot`
  且按用户名精确匹配），而不是回应每一条大区消息。

> 限频计数**存在服务端内存中，重启即清零**，不要依赖它做持久化的用量统计。

---

## 11. 数据结构

### 11.1 `ChatMessageDTO`

```jsonc
{
  "id": 12345,                    // 全局自增，可作游标
  "channel_id": "lobby",
  "author": {
    "id": "u_xxx",
    "username": "alice",
    "avatar_url": "https://...",  // 可能为空字符串
    "is_admin": false
  },
  "content": "你好",              // Markdown 原文
  "image": {                      // 无图为 null
    "id": "img_xxx",
    "url": "https://...",
    "mime_type": "image/png"
  },
  "image_missing": false,         // 引用了图但图已不存在
  "blog": {                       // 无引用为 null
    "id": "uuid",
    "title": "标题",
    "description": "...",
    "author": "alice",            // 作者 username，可能为 null
    "updated_at": "2026-09-11 20:31:05"
  },
  "blog_missing": false,          // 引用了博客但已被删除
  "pat": {                        // 拍一拍消息才有，否则 null
    "target_id": "u_yyy",
    "target_name": "bob"          // 目标已不存在时为 "某位用户"
  },
  "reply": {                      // 引用回复才有，否则 null
    "id": 12300,
    "content": "被引用的正文",
    "author_name": "carol",       // 可能为 null
    "is_deleted": false,
    "image_url": null             // 被引用的是图片消息时的缩略图
  },
  "is_deleted": false,            // 软删除；正文会被替换为 "[该消息已删除]"
  "created_at": "2026-09-11 20:31:05"
}
```

### 11.2 `ChatStreamEvent`（SSE 事件）

见 §6.2。完整定义：

```jsonc
{ "type": "message", "channel_id": "lobby", "message": { /* ChatMessageDTO */ } }
{ "type": "resync" }
{ "type": "typing", "channel_id": "lobby", "user_id": "u_xxx", "username": "alice" }
{ "type": "read",   "channel_id": "d_xxx", "user_id": "u_xxx", "message_id": 12345 }
```

---

## 12. 礼仪与约定

技术之外，两点请配合：

1. **让机器人的身份可辨认。** 建议用户名带 `bot` 后缀（如 `mybot`），
   或在其个人简介里写明「这是机器人」。否则大区里的用户会以为在跟人对话。
2. **别把聊天内容外送而不告知。** 如果你打算把大区消息发给第三方服务
   （AI 模型、日志平台等），请先和站长沟通，并在机器人简介里说明用途 ——
   大区里的其他用户并没有同意自己的发言被送往站外。

---

## 13. 排错速查

| 现象 | 原因 |
|------|------|
| 登录成功但聊天接口 `403 需要核心用户权限` | 账号是 `user` 不是 core+，见 §2.2 |
| 所有写请求 `403 跨源请求被拒绝 (CSRF)` | 你**手动设置了错误的 `Origin`**。非浏览器客户端直接不带该头即可（§3.1） |
| 聊天接口全部 `403 你已被禁言…` | 账号被禁言，等解禁或联系站长 |
| `429` | 触发限频，见 §10；发消息注意 `chatDaily` 800 上限 |
| 突然收不到消息 | 连接被踢或背压断开（§6.4），实现重连 + `Last-Event-ID` 补齐 |
| 收到 `{"type":"resync"}` | 断线太久积压超 100 条，按 §8 重新拉一页对齐 |
| 图片发不出去 | 正文不支持 `<img>`，要先用 `image_id`（§7.3 / §9.2） |
| 消息时间差 8 小时 | `created_at` 是东八区墙上时间，不是 UTC（§5） |

---

## 14. 最小可用流程

```
1. POST /api/auth/login                        → 存下 raricy_session
2. GET  /api/chat/stream                       → 建 SSE 长连接
3. 收到 type=message 且 channel_id=lobby
   → 若 content 里 @ 到自己，则：
4. POST /api/chat/channels/lobby/messages
   { "content": "..." }
```

断线时：`Last-Event-ID` 重连补齐；收到 `resync` 就重拉一页。
收到 `401` 就重新登录再重连。收到 `429` 就退避。
