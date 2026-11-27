# 讨论机器人接入说明

> 面向站外开发者。**读完本文即可实现一个讨论机器人，无需阅读本站源码。**
>
> 本文是接口契约的唯一对外口径。字段、限频数值、错误码均照实抄录，
> 若与源码不符以源码为准（但也请提 issue —— 那就是本文过期了）。

## 0. 一句话说清

**没有专用的「机器人接口」。** 机器人就是**一个普通的 core+ 用户账号**，
走和对人完全一样的 HTTP 接口。你需要的只有三件事：

1. 一个 core+ 账号（§2）
2. 一条 SSE 长连接收消息（§6）
3. 一个 POST 发消息（§7）

**这三条就能跑起来。** 此外还有三个「让它像个人而不是一台复读机」的可选信号 ——
发**表情**（§7.4）、报**正在输入**（§7.5）、报**已读**（§7.6）—— 不实现不影响收发，
但对面会感觉在跟一堵墙说话。

长回复还可以选择**流式生成**（§7.8）：先把正文分块推给站内读者作临时预览，
最后一次性发布为正式消息。**它是可选增强 —— 现有一次性 `POST /messages` 继续可用
且行为不变**，不实现流式不影响任何功能。

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
> （被禁言期间所有讨论接口返回 `403 你已被禁言，暂时无法讨论`）。
> 这是刻意设计——出问题时站长能像处理普通用户一样处理它。
>
> 流式生成（§7.8）不扩大任何可见范围：临时预览只投递给本来就能看到该频道的连接，
> 失权（禁言 / 降权 / 私聊成员关系失效 / 专注模式屏蔽大区）会立刻停止任务。

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
  "invite_code": "必填，有效且未使用的一次性邀请码",
  "turnstileToken": "可选，站点启用 Turnstile 时必填"
}
```

校验规则：

| 字段 | 规则 |
|------|------|
| `username` | 3–20 字符；仅允许字母 / 数字 / `_` / `-`；不能以 `-` 或 `_` 开头或结尾 |
| `email` | 常规邮箱格式，≤100 字符 |
| `password` | ≤100 字符 |
| `invite_code` | 必填，必须有效且未使用；与创建账号原子占用 |

**成功即自动登录**（响应会 `Set-Cookie`，见 §3）：

```json
{
  "code": 200,
  "message": "注册成功",
  "user": { "id": "u_xxx", "username": "mybot", "role": "core" }
}
```

> 📌 **注册需由人工完成一次，这是预期流程。** 机器人账号**不开放脚本自助注册**
> （数量有限）。此外，站点若启用了人机验证（Turnstile），脚本同样无法自行注册。
>
> 做法：由人工在浏览器里建号一次，之后机器人用账号密码登录即可 ——
> 后续所有交互都不再涉及人机验证。

### 2.2 成员资格与历史账号认证

**讨论接口要求 core+**。公开注册已直接创建 core；历史未认证或被取消资格的账号仍会收到 `403 需要核心用户权限`。

- **新账号**：注册时必须提供有效邀请码，成功直接为 core 并建立会话；
- **历史账号**：登录后通过 `POST /api/auth/authentic` 补码认证；或由有权限的管理人员调整资格。

---

## 3. 鉴权

本站的**会话**不是 Bearer token —— 它是一个 HttpOnly Cookie。（站内另有 Bearer 凭据，
但那是鱼干市场的**只读凭据**，与会话是两套东西，见 `docs/bot/fish-bot.md` §2.1.1。）流程：

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
2. **会话会被主动作废**：改密码、被强制下线、被禁言 / 重置密码都会让旧 Cookie
   立刻失效（服务端有 `session_version` 快照机制）。表现同样是 `401`。
   ⚠️ **被降权（core → user）不属于这一类** —— 会话**不会**失效：连接会被踢
   （见 §6.4），但重连后拿到的是 `403 需要核心用户权限`，不是 `401`。
   别把它当会话失效去重登，重登也还是 403。
3. **CSRF 校验对你无影响。** 本站对写请求校验 `Origin` / `Referer` 同源，
   **但两者都缺失时放行**。非浏览器客户端本来就不发这两个头 → 天然通过。
   ⚠️ 所以**不要**自作主张伪造一个 `Origin`，写错反而会被判定为跨源而 403。

### 3.2 会话是否仍有效

```http
GET /api/auth/me
```

⚠️ **这个接口永远返回 `200`** —— 会话缺失 / 失效 / 被作废时返回的是
`{ "code": 200, "message": "ok", "user": null }`，**不会回 `401`**。
所以判据是 **`user` 是不是 `null`**，不是状态码：

```js
const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
if (me.user === null) { /* 该重新登录了 */ }
```

> ⚠️ 按「等 401」写探活是个**静默**错误：机器人会一直拿不到用户，却永远不重登，
> 然后在下一个业务请求上一起撞 401。适合在重连前探活，但请按 `user` 判。

---

## 4. 响应信封与错误码

**所有** JSON 接口共用同一信封（SSE 除外，见 §6）：

```json
{ "code": 200, "message": "ok", ...其他数据字段 }
```

出错时 `code` 与 HTTP 状态码一致；**常规接口**只有 `code` 和 `message`：

```json
{ "code": 403, "message": "需要核心用户权限" }
```

成功时 `message` 通常是 `"ok"` 或一句中文提示（如 `"登录成功"`）。

> ⚠️ **生成接口（§7.8）的失败响应多一个稳定的机器标识 `error`**，冲突时还可能带
> `next_seq` / `status` 等辅助字段；无论哪种情况，`message` 都是提示字符串，
> 正式消息对象放在 `chat_message`（不会覆盖 `message`）。旧发送接口的 `message`
> 对象特例（§7.2）仍然存在，两者不要混用同一种解析方式。

| 状态码 | 含义 | 常见 message / 生成接口 `error` |
|--------|------|--------------|
| `400` | 参数错误 | `请求体格式错误` / `用户名和密码不能为空`；生成接口另有 `invalid_request` / `empty` / `too_long` / `reply_invalid` |
| `401` | 未登录 / 会话失效 | `请先登录` / `用户名或密码错误` |
| `403` | 权限不足 / 被禁言 / 跨源 | `需要核心用户权限` / `你已被禁言，暂时无法讨论` / `跨源请求被拒绝 (CSRF)`；生成接口另有 `forbidden` / `send_forbidden` |
| `404` | 频道不存在或不可见 | `频道不存在`；生成接口也用于任务不存在 / 回执已淘汰（`not_found`） |
| `409` | 生成任务的状态 / 序号 / 幂等参数冲突（仅 §7.8） | `序号跳跃，请按 next_seq 继续` / `client_request_id 已用于不同的生成参数` / `生成任务正在完成，无法取消` |
| `410` | 生成任务仍有过期回执，但请求已不可用（仅 §7.8） | `生成任务已过期` |
| `413` | 生成请求体、单片段或累计正文超限（仅 §7.8） | `请求内容超过限制` / `单个片段不能超过 1024 字符` / `生成正文不能超过 5000 字` |
| `429` | 触发限频 | 发消息 `发言过于频繁，请稍后再试` / `今日发言已达上限，请明日再试`；对账 `请求过于频繁，请稍后再试`；登录 `尝试过于频繁，请 15 分钟后再试`；生成接口另有 `rate_limited` / `send_rate_limited` |
| `500` | 生成完成时写库结果未知（仅 §7.8） | `消息写入结果未知，请先核对频道消息再决定是否重发`（`error: "commit_unknown"`，`retryable: false`） |
| `503` | 生成任务容量已满（仅 §7.8） | `同时进行的生成任务已达上限，请稍后再试`（`error: "capacity"`） |
| `5xx` | 服务器内部错误 | ⚠️ **常规接口不保证是本文的 JSON 形状** —— 讨论域自己从不产出 5xx，它只出现在未捕获异常时，由框架返回默认响应体。只有生成接口的 500 `commit_unknown` 是明确的 JSON 契约。**先判 HTTP 状态与能否解析 JSON，再取 `code`** |

（2026-09 核对时讨论域没有任何 503，曾删掉旧表里编出的「服务暂时不可用」；
2026-11 的生成接口（§7.8）新增了有明确语义的容量 `503`，与当时那条编造的码不是一回事。）

> ⚠️ **讨论域的接口带 `Cache-Control: no-store`**（`apiOk` / `apiErr` 统一加），
> 别在客户端缓存这些响应。⚠️ 但**别把它当全站保证**：本文档顺带提到的
> `/api/auth/*` 与 `/api/notifications/count` 走的是裸 `Response.json`，
> 没有显式设这个头 —— 想缓存什么之前先自己看一眼响应头。

---

## 5. 时间戳格式（⚠️ 与全站同一个坑）

消息里的 `created_at` 是 **ISO 8601 字符串，带 `T` 和 `Z`**：

```
"2026-09-11T20:31:05.000Z"
```

**但那个 `Z` 是假的。** 本站全库时间戳的语义是「**UTC+8 墙上时间，贴 Z 标签**」——
上面这个例子表示的是**北京时间 20:31:05**，而不是 UTC 20:31:05。

```js
// ✅ 想原样展示给用户 —— 截断即得北京时间墙上时间
const wall = created_at.slice(0, 19).replace('T', ' '); // "2026-09-11 20:31:05"

// ✅ 想得到真实瞬间（做时间差、跨时区换算）
const realMs = new Date(created_at).getTime() - 8 * 3600 * 1000;
```

```js
// ❌ 错误 —— 会整整差 8 小时
new Date(created_at).toLocaleString('zh-CN')
```

> ⚠️ 同一个坑的完整写法见 `docs/bot/comment-bot.md` §5 —— **全站一个口径**，
> 讨论区这条早些年是空格分隔的 `"YYYY-MM-DD HH:MM:SS"`，现在服务端统一走
> `toISOString()`，两种形状别混。
>
> 📌 同一形状还出现在：`message.blog.updated_at`（引用文章的更新时间）、
> `channel.last_message.created_at`。**都是同一个假 `Z`。**

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

`id:` 用于断线补齐（§6.3）。它出现在 **`message` 事件**上（值 = 消息 id），
**私聊的 `read` 事件**上也有（值 = 对方读到的那条消息 id）；`typing` 与 `resync`
不带 `id`。**`generation_snapshot` / `generation_terminal`（§7.8）也不带 `id:`**，
它们不推进补齐游标。

> ⚠️ 所以「记住最后一个 `id:`」时别假定它一定是消息 —— 保守写法是**只在 `message`
> 事件上更新游标**。用 `read` 上那个值当游标也不会漏消息（它同样是消息 id），
> 但没必要。

连接建立时服务端会先发一帧：

```
retry: 3000

: connected

```

即「断线后 3 秒重连」+ 一个注释帧（用于立刻产生字节，避免被中间层当成空响应）。

> 📌 之后服务端每 **25 秒**发一个注释帧 `: ping` 保活。标准 SSE 客户端会忽略注释帧 ——
> 你不用处理，但**别把它当成数据帧**，也别拿它去更新你的「最后一条消息」游标。

### 6.2 七种事件

| `type` | 载荷字段 | 含义 |
|--------|----------|------|
| `message` | `channel_id`, `message`, 可选 `generation_id` | 一条新消息（含你自己发的，用于多端同步） |
| `resync` | — | 积压太多补不齐，**请重新拉取**（§6.3） |
| `typing` | `channel_id`, `user_id`, `username` | 有人正在输入（不落库，3 秒后自行忽略） |
| `read` | `channel_id`, `user_id`, `message_id` | 私聊已读回执 |
| `appearance` | — | 气泡装备变化，展示客户端读取 §9.8 快照；纯文本机器人可忽略 |
| `generation_snapshot` | `generation_id`, `channel_id`, `revision`, `author`, `source` | 某条正在生成的**完整累计正文**（§7.8）；无 SSE `id` |
| `generation_terminal` | `generation_id`, `channel_id`, `revision`, `status`, `message_id?`, `error?` | 生成任务进入终态（§7.8）；无 SSE `id` |

`message` 事件的 `message` 字段就是 §11.1 的 `ChatMessageDTO`。`generation_id`
只是事件外层字段，不写库；**断线补齐的 `message` 没有它也同样有效**，客户端按
`message.id` 去重即可。

> `generation_snapshot` / `generation_terminal` 是**临时事件**：不建立消息 id，
> 不推进未读 / 已读 / 侧栏 `last_message`，也不产生 @ 提及。只有随后那条正式
> `message` 会走正常规则。生成中的正文只活在读者页面内存里，不写客户端存储。

> 这些事件里，`message` / `resync` / `typing` / `read` / `appearance` 是**收**方向：
> 别人做的动作推给你；`generation_snapshot` / `generation_terminal` 也属于收方向，
> 是别人正在生成的内容。**发**方向的三个信号 —— 让别人看到「mybot 正在输入…」
> （§7.5）、把会话标记为已读并推回执（§7.6）—— 是你主动 POST 出来的。

### 6.3 断线补齐（重要）

SSE 原生支持断线续传，**请务必实现**，否则断线期间的消息会永久丢失：

1. 客户端记住收到的**最后一个 `id:` 值**；
2. 重连时把它放进请求头 `Last-Event-ID: <该值>`；
3. 服务端把 `id` 大于它的消息按序补发；
4. 若积压超过 **100 条**补不齐，服务端改发一帧 `{"type":"resync"}`；
5. 收到 `resync` → 自己重新 `GET /api/chat/channels/lobby/messages`（§8）
   拉一次当前首页，把状态对齐。

> 生成事件（§7.8）**不参与补齐**：它们没有 SSE `id`，也不会被重放。重连后要么收到
> 活动任务的新快照，要么直接收到已发布的那条正式 `message`；不要拿生成事件去推进
> `Last-Event-ID`。

### 6.4 会被服务端主动断开的情形

- **背压**：未消费帧积压超过 **512** 帧 → 视为客户端卡死，断开（重连+补齐即可）。
- **权限变更**：被禁言 / 降权 / 专注模式里**屏蔽了讨论大区**（总开关或 `focusBlockLobby` 变化）→ 旧连接被踢，重连时重新鉴权。
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

网页输入框在输入 `@` 时显示选人提示，选择后插入 `@用户名 `（带尾随空格）。
大区提示过滤专注、禁言和静音者；私聊只提示当前会话成员。机器人直接写同样的文本即可，
无需调用选人接口。提及的用户名后必须接空白或行尾；`[@用户/用户名]` 名片不发通知。

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
| `content` | string | 否* | 正文，**按 Markdown 渲染**（见 §7.3）；写 `[@合集/表情]` 即发表情（见 §7.4） |
| `image_id` | string | 否 | 引用图床图片，需先上传（§9.2） |
| `blog_id` | string | 否 | 引用一篇博客（UUID） |
| `reply_to` | number | 否 | 引用回复的消息 id，须**同频道且未删除** |
| `pat_target_id` | string | 否 | 「拍一拍」目标用户 id。**非空即拍一拍消息**，此时正文/图片一律被忽略 |

\* 至少要有一个有效载荷，否则会报参数错误。

**长度上限**（按 `trim()` 之后计算，恰好到顶放行）：

| 场景 | 值 | 超限时的错误码 |
|------|-----|----------------|
| 纯文本消息 | **5000 字** | `tooLong` |
| 带附件（`image_id` / `blog_id`）时的 `content` | **5000 字** | `captionTooLong` |

> 两档**同值**（2026-09 起）—— 此前是 1000 / 500。服务端仍分两条错误码，客户端按
> 文案处理即可：`消息不能超过5000字` / `图片或引用消息不能超过5000字`。

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
- ❌ **不支持手写 `<img>`** —— 白名单里没有，写了会以转义文本显示出来
- ✅ 但可以用**内容引用语法**贴图与内联剪贴板（见下方「内容引用」）
- ❌ 不支持 `<iframe>` / `<svg>` / `<style>` / `<form>`
- 链接会自动加 `rel`/`target` 加固，类名为 `chat-msg__link`

#### 内容引用 `[@<内容ID>]`

正文里可以写 `[@<内容ID>]`，服务端**原样入库**，由渲染端按 ID 长度展开：

| 写法 | 长度 | 效果 |
|------|------|------|
| `[@a1b2c3d4]` | 8 位 | 内联云剪贴板的正文（该剪贴板须公开，或你是作者） |
| `[@AbCdEf1234]` | 10 位 | 内联图床图片 —— 渲染成 `/api/images/<ID>/raw` 的图，可点开放大 |
| `[@音频/AbCdEf1234]` | —— | 内联音频 —— 渲染成 `/api/audio/<ID>/raw` 的播放器（带引号里的那一段是**具名命名空间**，不按长度分流）。一条正文最多展开 3 个，见 `docs/bot/audio-bot.md` §6.3 |
| `[@vOtE12345]` | 9 位 | 投票 —— **讨论正文里不展开**，原样显示 |
| `[@123456]` | 6 位数字 | 收藏夹 —— **讨论正文里不展开**，原样显示（只有博客正文会渲染成卡片） |

要点：

- **一条消息最多展开 1 条云剪贴板**，多写的那些原样留在正文里
- 图床图片最多 50 张，超出部分原样保留
- 剪贴板正文超过 2000 字会截断，并附一句「已截断」+ 回原剪贴板的链接
- 写在**代码块 / 行内代码**里的 `[@id]` 不展开（要展示语法本身时就这么写）
- 剪贴板正文是**另一名用户**写的，它随后与你的正文走同一条净化管线
- 图片必须是**公开**的，否则别人看到的是裂图（私有图只有作者能取）

> ⚠️ **表情不在上表里** —— 它用的是另一套语法（`[@合集/表情]`，两段是**名字**而不是
> ID），见 §7.4。
>
> 📌 **用户名片**同样不在上表里：`[@用户/<用户名>]` 渲染成一枚行内名片（头像 + 用户名，
> 点进主页）。它**不算 @ 提及**（对方不会收到通知），一条消息最多 5 张。机器人发它的
> 唯一用途是「把人带进对话」—— 取数与权限见 `docs/bot/account-bot.md` §6。

> 发出去的原文**原样入库**，净化只发生在渲染时。所以你可以放心发 Markdown 源文。

---

### 7.4 表情：`[@合集/表情]`

正文里写 **`[@合集名/表情名]`**，渲染出来就是一张表情图（可以夹在句子中间，
**不会**把整行断开）：

```json
{ "content": "今天天气真好 [@猫猫/开心] 出门走走" }
```

两段都是**名字**而不是 ID：`合集名` 是素材目录名，`表情名` 是文件名去掉扩展名。

#### 先拉清单，别猜名字

```http
GET /api/stickers
Cookie: raricy_session=<JWT>
```

需要 **core+** 登录（你本来就登录着，见 §2.2）。非 core 账号返回 `403 需要核心用户权限`。
响应：

```jsonc
{
  "code": 200,
  "message": "ok",
  "collections": [
    {
      "key": "猫猫",                // ← token 的第一段用**这个**
      "title": "猫猫合集",           // ← 面板上的显示名，**不要**写进 token
      "priority": 10,               // 排序权重（降序）；对机器人没用，忽略即可
      "stickers": [
        { "name": "开心", "url": "/api/stickers/%E7%8C%AB%E7%8C%AB/%E5%BC%80%E5%BF%83" }
      ]
    }
  ],
  "empty": false                    // true = 站长一张素材都没放
}
```

拼 token 就是 `[@` + `key` + `/` + `name` + `]`，**原样抄**。`url` 是图片直链
（相对路径，域名要自己拼），发消息时用不上 —— 正文里贴图走 `image_id`（§9.2）
或 `[@<10位图片ID>]`（§7.3）。

#### 几条会咬人的规则

| 规则 | 说明 |
|------|------|
| 一条消息最多 **30 个** | 超出部分**原样显示为文本** |
| 名字写错 = 显示原文 | 不是破图、也不是空白，读者会看见你写的 `[@猫猫/并不存在]` |
| **不产生通知，也不算 @ 提及** | 表情是内容，不是叫人 |
| 限频按**一条消息**算 | 与文字消息同吃 `chatMinute` / `chatDaily`（§10） |
| 名字里不能有空白 | 两段各 ≤32 字符；字符合集是 Unicode 字母 / 数字 / `+` `·` `-` |
| 只在讨论与评论里生效 | 博客正文与剪贴板正文里 `[@猫猫/开心]` 是字面量 |

> ⚠️ 上表最后一条藏着个坑：清单里若出现**含 `_` 之类集合外字符**的表情名
> （站长把文件命名成 `开心_2.gif` 就会这样），它**列得出来、但 token 匹配不上** ——
> 发出去会显示成原文，且没有任何报错。拿到清单后按上面的字符合集过滤一遍，
> 遇到不合规的名字就跳过。

#### 图片本身不需要登录

`GET /api/stickers/<合集>/<表情>` 直接返回图片字节，**不校验登录**：表情素材是站点
素材、不属于任何账号，这条路径上没有「档位」这个概念。带 1 天浏览器缓存。所以 `url`
可以贴给你自己的管理界面 —— 但别贴进消息正文。

> 站长随时可能删掉素材、或把整个合集在 `info.json` 里标成 `ignore`（效果是
> **从清单里消失，且手打 token 也取不到图**）。所以**别把表情清单当永久配置缓存**，
> 隔一段时间重拉一次；token 失效时你的消息不会报错，只会显示成原文。

### 7.5 正在输入（typing）

一条 `POST`，**不落库、不进消息流**，只是让同频道的人短暂看到「mybot 正在输入…」：

```http
POST /api/chat/channels/lobby/typing
Cookie: raricy_session=<JWT>
```

没有请求体。成功 `{"code":200,"message":"ok"}`。

| 行为 | 说明 |
|------|------|
| 谁收得到 | 大区 → **所有在线连接**（含你自己 —— 要按 `user_id` 过滤掉自己的，否则你会看到自己在打字）；私聊 → 只有对方 |
| 显示多久 | 对方收到后约 **3 秒**淡出，服务端**不会**替你重发 |
| 服务端节流 | 同一用户 + 同一频道 **3 秒内只广播一次** |
| 被节流时 | 仍是 `200`，但响应里多一个 `{"throttled":true}` —— **不是错误** |
| 配额 | **不消耗** `chatMinute` / `chatDaily`（它不是消息） |

**推荐用法**：开始生成回复时发一次；生成超过 3 秒就**每隔 ~3 秒补发一次**，
直到把回复发出去为止。发完不用管，提示会自己淡出。

> ⚠️ 它是**尽力而为**的提示：被节流时也是 `200`，所以你无法确知对方到底看没看到。
> 不要为它设计重试或状态机 —— 掉了就掉了，下一条消息才是真的。

### 7.6 已读（read）

```http
POST /api/chat/channels/d_xxx/read
Content-Type: application/json

{ "message_id": 12345 }
```

`message_id` **可省略**（省略 = 读到该频道当前最新的一条）。作用是推进你在该频道的
读游标 —— 它决定了三件事：§9.3 里的 `unread_count`、顶栏「讨论」小红点熄不熄、
以及该会话里 @ 你的通知清不清（第 4 条）。响应：

```json
{ "code": 200, "message": "已读", "message_id": 12345 }
```

⚠️ **`message` 与 `message_id` 是两个不同的东西** —— 这里的 `message` 是字符串
`"已读"`（符合 §4 的常规信封），`message_id`（带下划线）才是数字。

响应里的 `message_id` 是**这次写完后实际生效的读游标**，不是请求值的回显：库里的游标
只增不减，重放一个更旧的 `message_id` 不会把它退回去（先读到 100、再报 80，之后仍是
100）。判断「推进成功没有」仍然只看它是否为 **`0`**。

**回执只在私聊里推给对方**（大区人多，不推；且只在游标确实前进时推一次 —— 重放更旧或
相同的 id 不会再推）：对方会实时收到
`{"type":"read","channel_id":"d_xxx","user_id":"<你>","message_id":12345}`（§6.2）。
所以「让人看到机器人已读」这件事**只有私聊做得到**。

四个**静默**行为，实现时按此预期：

1. **传了别的频道的 `message_id` → 不报错**，服务端校验它属不属于本频道，不属于
   就忽略该参数、回落成「这个频道的最新一条」。（不这么做的话，一个更大的 id 会把
   游标推高、静默吞掉未读。）
2. **没有权限 / 频道不存在 → 也是 `200`**，但 `message_id` 会是 **`0`**。
   所以「到底推进成功没有」**要看 `message_id` 是不是 0**，只看 `code` 会误判。
3. 大区也会推进游标（顶栏「讨论」小红点随之熄灭），只是不推回执。
4. **读到这个会话 = 该会话里 @ 你的通知一并标成已读**（别人 @ 你产生的那套条目，
   见 `/api/notifications/*` 与 §9.7）—— 人已经把消息看了，铃铛就不该继续吊着。
   只清**这一个会话**的「讨论提及」：别的会话、以及别种通知都不受影响。
   （网页端进频道 / 在频道里看新消息时会自己调本接口，所以它也是这个语义。）

> 为什么值得实现：不调它，§9.3 里的 `unread_count` **永远不会下降**（看过的消息也
> 一直算未读），你的机器人会以为总有新消息；而且人对机器人说话时，永远等不到那个
> 「已读」。

---

### 7.7 报到「我正在看这个会话」（viewing）

```http
POST /api/chat/channels/lobby/viewing
Cookie: raricy_session=<JWT>
```

没有请求体，成功 `{"code":200,"message":"ok"}`。

作用是让服务端知道**你人正在这个会话里看着**：别人 @ 你时，若服务端判定你正在看这个
频道，那条 @ 通知**根本不产生**（网页端开着讨论页且标签页可见时，客户端每 60 秒报一次；
标签页一关 / 一切后台就自动停报，服务端随即不再把你当成「在看」）。

| 行为 | 说明 |
|------|------|
| 谁需要它 | **只有网页端需要。** 机器人不报也完全不缺什么 —— 不报就等于「每条 @ 都发通知」 |
| 频道不存在 / 无权限 | **也是 `200`**（静默忽略）：这不是用户可感知的动作，报不上只是让通知照常发 |
| 效力多久 | 报到后约 **150 秒**内有效，过期即失效（所以要周期续报，网页端是 60 秒一次） |
| 怎么算离开 | **不用报「我走了」**：服务端以「你的 SSE 讨论流（§6）还连着吗」为准，连接一断立刻不算在看 |
| 配额 | **不消耗**任何配额（同 §7.5 正在输入、§7.6 已读） |

> ⚠️ **报到不等于已读**，两者互不代替：报到只决定「要不要发通知」，未读数与顶栏红点仍由
> §7.6 的读游标决定。网页端是两个请求（`/viewing` 与 `/read`），别指望一个顶两个。
>
> ⚠️ 被抑制的那条 @ **不会在通知列表里留下任何条目**（`/api/notifications` 数不出来），
> 但那条消息仍然是未读 —— 未读数与顶栏红点照常亮。「正在看就不打扰」不等于「当它没发生」。

### 7.8 流式生成（可选）

§7 的一次性发送**永远可用，且行为不变**。流式生成是可选增强：适合长回复、模型
逐字产出等场景 —— 先把正文分块推给站内读者作临时预览，最后**一次**发布为正式消息。
正式消息仍走同一条发送内核：权限、禁言、专注模式、正文长度、`reply_to`、
`chatMinute` / `chatDaily`、@ 提及与未读全部照旧。

三条边界先记住：

- **作者只从会话取**，请求里不能指定；`generation_id` 不是授权凭据，只有任务作者能操作。
- **临时预览不写库**、没有消息 id，不影响未读 / 已读 / 侧栏预览 / @ 提及。
- **只有 `complete` 发布正式消息**，且同一任务在回执保留期内最多发布一次。

#### 协议

| 方法与路径 | 请求体 | 成功响应（除 `code` / `message`） |
|------------|--------|-----------------------------------|
| `POST /api/chat/channels/:id/generations` | `{client_request_id, reply_to?}` | `generation_id, next_seq, idle_timeout_ms, max_duration_ms` |
| `POST /api/chat/generations/:id/chunks` | `{seq, delta}` | `accepted_seq, next_seq, revision` |
| `POST /api/chat/generations/:id/complete` | `{last_seq}` | `status, message_id?, chat_message?, error?, retryable?` |
| `POST /api/chat/generations/:id/cancel` | `{}`（可省略） | `status`（已有终态时原样返回）、`error?` |
| `GET /api/chat/generations/:id` | 无 | `status, next_seq, revision, message_id?, error?` |

创建返回的 `next_seq` 是下一个待提交序号（新任务为 1）；两个超时以响应里的数值为准。
`reply_to` 在创建时只校验形状（正整数），目标是否存在 / 已删 / 同频道要到
`complete` 才校验，失败为 `reply_invalid`。

`GET` 只用于**任务作者**查询自己的任务，不推进任何已读；终态且回执仍在时返回 `200`，
用 `status` / `error` 描述结果，不要拿 `code` 判断是否发布成功。

#### 完整示例

```bash
BASE=https://raricy.com
COOKIE='raricy_session=<JWT>'
UUID='6f1c1e0e-6a7d-4d5e-9a1b-2c3d4e5f6a7b'   # 自己生成，持久保存，重试时复用

# 1) 创建任务
curl -sS -b "$COOKIE" -H 'Content-Type: application/json' \
  -d "{\"client_request_id\":\"$UUID\"}" \
  "$BASE/api/chat/channels/lobby/generations"
```

```json
{ "code": 200, "message": "生成任务已创建",
  "generation_id": "0b6e8f9a-...", "next_seq": 1,
  "idle_timeout_ms": 120000, "max_duration_ms": 600000 }
```

```bash
GEN='0b6e8f9a-...'   # 上一步的 generation_id

# 2) 分块：seq 从 1 开始逐块 +1；delta 非空、单块 ≤1024 字符
curl -sS -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"seq":1,"delta":"第一段。"}' \
  "$BASE/api/chat/generations/$GEN/chunks"

curl -sS -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"seq":2,"delta":"第二段。"}' \
  "$BASE/api/chat/generations/$GEN/chunks"
```

每次分块成功返回：

```json
{ "code": 200, "message": "ok", "accepted_seq": 2, "next_seq": 3, "revision": 2 }
```

```bash
# 3) 完成：last_seq 必须等于最后被接受的序号（这里是 2）
curl -sS -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"last_seq":2}' \
  "$BASE/api/chat/generations/$GEN/complete"
```

```jsonc
{ "code": 200, "message": "发送成功", "status": "completed",
  "message_id": 12345, "chat_message": { /* 完整 ChatMessageDTO，见 §11.1 */ } }
```

`chat_message` 是完整的 §11.1 `ChatMessageDTO`，只在**真正执行发布的流程**里返回；
进入终态后的回执重放只给保存下来的 `message_id` 与原结果，不再带 `chat_message`。

```bash
# 4) 取消（只能在 complete 之前；已进入 finalizing 会 409）
curl -sS -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/chat/generations/$GEN/cancel"
```

```json
{ "code": 200, "message": "生成任务已结束", "status": "cancelled" }
```

#### 分块规则

- `seq` 从 **1** 开始、逐块 +1；只有 `seq === next_seq` 的片段会被接受。
- `delta` 必须非空；单块最多 **1024** 个 JavaScript 字符单位；每任务最多 **512** 块；
  累计正文（未 `trim`）最多 **5000** 字；整个 HTTP body 最多 **8 KiB**（JSON 转义也算）。
- 旧序号**同内容**重放返回原来的 `accepted_seq / next_seq / revision`，不追加、不广播；
  旧序号**不同内容**或**跳号**返回 `409 conflict`，并带当前 `next_seq`。
- 只有**新片段被接受**才续期空闲计时；重放请求不能无限续命。
- **提交节奏：每 200ms 合并一包。** 模型或上游按更细粒度产出时，先在本地缓冲，
  每 200ms 把这段时间的新增内容合成一个 `delta` 提交；不要按 token、网络帧或每个
  服务端广播帧提交。服务端快照也是 200ms 一帧，按帧提交稳态约 300 片/分钟，
  对 600 次/分钟的额度留出 2 倍余量；一次重试或抖动不会立即 `429`。
- `complete` 不再接收新正文：最后一个分块先拿到确认，再发 `complete`。
  `last_seq` 必须等于最后接受的序号；一个片段都没提交时用 `0`，此时会按空正文失败
  （`400`，`status: "failed"`，`error: "empty"`）。
- `complete` 开始后任务进入 `finalizing`，再提交分块或取消都是 `409 conflict`。
- 分块或 `complete` 的 `409` 不会结束任务：按响应里的 `next_seq` 校正后可以继续或重试；
  只有 `finalizing` 中的拒绝例外 —— 此时发布已取得唯一提交权，只能等 `complete` 的结果。

#### 幂等

- `client_request_id` 用**客户端生成的 UUID**（服务端接受 1–128 字符的字符串，
  建议就用标准 UUID）。幂等键是 `(author, channel, client_request_id)`。
- 相同参数重复创建返回**同一个** `generation_id`（`next_seq` 是任务当前值，不保证是 1）；
  `reply_to` 等元数据不一致返回 `409 conflict`。
- **网络超时不要换新 key**：保留原 `client_request_id` 重试创建。回执保留期内，
  同一 key 始终映射到同一任务（**包括已进入终态的任务**）；要开始新任务必须用新 key，
  且先确认上一条确实没有发布。
- 幂等重放**不消耗**创建限频；分块重放会照常消耗分块限频。
- 创建、分块、完成、取消的请求体都受 8 KiB 上限约束（`GET` 无请求体）。

#### 终态与重试纪律

| `status` | 含义 | 正式消息 |
|----------|------|----------|
| `active` | 可继续提交分块 | 无 |
| `finalizing` | 已开始 `complete`，正文冻结 | 尚未确定，等结果 |
| `completed` | 已发布 | 有，`message_id` 必有 |
| `failed` | 可证明没有写入 | 无 |
| `commit_unknown` | 写库结果未知 | **未知** |
| `cancelled` | 已取消 | 无 |
| `expired` | 空闲或总时长超时 | 无 |

- `failed` 的 `error` 可能是 `empty` / `too_long` / `reply_invalid` /
  `send_forbidden` / `send_rate_limited` / `not_found`。这些都能证明没有写成，
  修正原因后可以**新建任务**（新 `client_request_id`）。
- `commit_unknown`（HTTP `500`，`retryable: false`）**不得自动重发**。此时可能已经
  发布，也可能没有；先按 §8 / 正式 SSE 查询近期频道消息核对。
- **进程重启、回执被淘汰后，`404` / `410` 不能证明原请求没有发布。** 回执保留
  **15 分钟是上限**，全站最多 4096 条，超容量会提前淘汰最旧的；淘汰后接口给 `404`，
  幂等键也随之释放。核对仍以频道消息为准，源码相同不能当作唯一证据。
- 正式发言配额（`chatMinute` / `chatDaily`）**只在 `complete`** 调用发送内核时扣一次；
  可能遇到 `429 send_rate_limited`，此时任务是 `failed`，没有发布。首版不预留名额，
  若决定重试，先处理配额，再用新任务重新生成。
- `finalizing` 中重复 `complete`（同 `last_seq`）共用同一个结果；不同 `last_seq` 为 `409`。
- 终态后重放 `complete`：`completed` / `failed` / `commit_unknown` 且 `last_seq` 相同
  会原样返回保存的结果；`cancelled` 为 `409 conflict`，`expired` 为 `410 gone`；
  `last_seq` 不同同样为 `409`。
- 任务已终态后 `cancel` 返回已有 `status`（含 `completed`），**不会撤回**已发布的消息；
  `expired` 回执的 `cancel` / `complete` / `chunks` 都返回 `410 gone`。

#### 错误标识

失败响应里的 `error` 是稳定的机器标识，按它分支，不要匹配中文 `message`。
`message` **始终是提示字符串**；正式消息对象只出现在 `chat_message`。`409` 还常带
`next_seq`（有时带 `status`）辅助你回到正确序号。

| HTTP | `error` | 场景 |
|------|---------|------|
| `400` | `invalid_request` | 请求形状非法：缺字段、`seq` / `last_seq` 不是合法整数、`delta` 为空、`client_request_id` 为空或超过 128 字符、JSON 非法或不是对象 |
| `400` | `empty` | `complete` 时正文为空（没提交片段，或只有空白） |
| `400` | `too_long` | `complete` 时正文超过 5000 字 |
| `400` | `reply_invalid` | `complete` 时 `reply_to` 指向的消息不存在 / 已删除 / 不在本频道 |
| `401` | `unauthorized` | 未登录或会话失效 |
| `403` | `forbidden` | 非任务作者、禁言、非 core+、频道不可访问、专注模式屏蔽大区 |
| `403` | `send_forbidden` | `complete` 调用发送内核时被最终权限拒绝（任务转 `failed`） |
| `404` | `not_found` | 任务不存在、回执已被淘汰，或频道不存在 |
| `409` | `conflict` | 序号跳跃、异内容重放、幂等元数据冲突、`finalizing` 中提交分块 / 取消、终态后 `complete` 参数不一致 |
| `410` | `gone` | 任务仍有过期回执，`chunks` / `complete` / `cancel` 已不可用 |
| `413` | `too_large` | HTTP body 超 8 KiB、单片段超 1024 字符、片段数超 512、累计正文超 5000 字 |
| `429` | `rate_limited` | 创建或分块限频（§10 的两条生成配额） |
| `429` | `send_rate_limited` | `complete` 时正式发言配额不足，任务转 `failed` |
| `500` | `commit_unknown` | 写库结果未知，`retryable: false`，不得自动重发 |
| `503` | `capacity` | 每作者 1 个 / 全站 32 个活动任务已满 |

`complete` 返回的 `failed` 也使用同一组 HTTP / `error`（例如正文超长是
`400 too_long`、正式配额不足是 `429 send_rate_limited`），响应里同时带
`status: "failed"`；重放时原样返回保存的 HTTP 状态与结果。

#### 资源预算

| 项目 | 上限 |
|------|------|
| 每作者同时活动任务（含 `finalizing`） | **1** 个 |
| 全站同时活动任务 | **32** 个 |
| 单片段 | **1024** 字符 / HTTP body **8 KiB** |
| 每任务片段数 | **512** 个 |
| 累计正文 | **5000** 字（未 `trim` 也受限） |
| 空闲超时 | **120 秒**（最后接受片段起算） |
| 总时长 | **10 分钟**（从创建起算；`complete` 必须在此之前开始） |
| 创建限频 | **12 次/分钟/作者** |
| 分块限频 | **600 次/分钟/作者**（约 10 次/秒，含重放；建议每 200ms 合并提交一次） |
| 终态回执 | **15 分钟** / 全站 **4096** 条（保留期是上限） |
| 临时广播 | 每任务约 **5 帧/秒**，合并为最新完整快照 |

活动名额已满返回 `503 capacity`（不是 429）。临时事件没有 SSE `id`，也不占用消息游标。

#### 权限与可见性

- 每次创建、分块、完成、取消、查询都重新验证生产者：非任务作者 `403 forbidden`，
  任务不存在或回执已淘汰 `404 not_found`。
- 私聊的临时预览只投递给该频道成员（含作者自己的其他标签页）；大区广播跳过专注模式
  屏蔽大区的连接。频道的读者权限始终由服务端判定，`generation_id` 不构成任何授权。
- 失权（禁言、降权、私聊成员关系失效、专注模式屏蔽大区）会立刻终止任务并清空缓冲，
  终态为 `failed` / `forbidden`，不会再发布。
- 临时事件不建立消息 id，不推进已读、不增加未读、不更新侧栏预览、不发 @ 通知；
  正式发布只执行一次既有的 @ 提及与未读规则。

#### 读者看到什么

站内读者通过 SSE 收到 `generation_snapshot`（完整累计正文，`revision` 递增）与
`generation_terminal`（终态、`message_id`），页面按 `generation_id` 维护临时预览；
收到带 `generation_id` 的正式 `message` 后按 `message.id` 换成正式消息。断线补齐的
`message` 没有 `generation_id` 也有效。机器人一般不需要消费这两种事件，但若自己也
在读频道，应按 §6.2 的说明忽略它们对未读 / 已读的影响。

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

```json
{ "code": 200, "message": "ok",
  "users": [{ "id": "u_xxx", "username": "alice", "frame_url": null }],
  "total": 1 }
```

`frame_url` 是头像框贴图地址（`null` = 没戴 / 已过期 / 素材缺失），**判定已在服务层做完**；
响应里**没有 `role`** —— 选人弹窗不需要角色。想把自己也搜出来时加 `&include_self=1`。

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

返回的图片 id 即发消息时的 `image_id`。限频 **200 次/小时**。

（一个请求可以带多个同名 `file` 字段，此时响应里没有单个 `id`，成功的那几张在
`items[].id`、失败的带原因在 `failed[]`。限频按**张数**计。一次传一张最省事。）

### 9.3 拉会话列表与未读数

「有没有人跟我说话」的唯一来源：

```http
GET /api/chat/poll?channel=lobby&after=1000
```

| 参数 | 说明 |
|------|------|
| `channel` | 想顺带拉新消息的频道 id（省略 = 不拉消息） |
| `after` | 拉 id 大于它的消息；**要与 `channel` 一起给** |

响应里的 `channels` 是**你可见的全部频道**（大区 + 你的所有私聊）：

```jsonc
{ "code": 200, "message": "ok",
  "channels": [ /* ChatChannelDTO[]，见 §11.2 */ ],
  "channel_id": "lobby",   // 回显你传的 channel（没传就是空串）
  "messages": [ /* 只有给了 channel + after 才有；ChatMessageDTO[] */ ] }
```

对机器人最有用的几个字段是 `id`、`kind`（`lobby` / `direct`）、`peer`（私聊对方的
id 与用户名）、**`unread_count`**。

> ⚠️ **未读数不在 §8 那个接口里。** `GET .../messages` 只回消息、不带未读，
> 全站也没有第二个地方给你未读条数。想知道「有没有人跟我说话」，要么读这里的
> `unread_count`，要么实时听 SSE（§6）自己数。
>
> **两个都用是最稳的**：SSE 存在「连着但收不到」的半死状态（反代掐连接、NAT 超时），
> 那种时候只有轮询能纠正数字。本站网页端也是这么做的。

⚠️ 这是全站最重的接口（一次列表 = 若干次数据库查询），限频 **120 次/分钟**（§10）。
正常用法是**几十秒一次**，不是每秒一次。

### 9.4 在会话内搜索历史消息

```http
GET /api/chat/channels/lobby/search?q=关键词&page=1
```

返回 `{ messages, total, page, per_page }`，`per_page` 固定 **20**，结果按 id
**倒序**（新的在前）。`q` 为空 → 返回空数组（`200`），不是报错。搜的是**正文原文**
（含 Markdown 与 `[@…]` 记号）；图片消息、拍一拍、已删除的消息搜不到。

> 适合「有人 @ 我提了个老问题，去翻上下文」这类场景。**别拿它当消息同步用** ——
> 同步走 §8 或 SSE。

### 9.5 撤回（软删）自己发的消息

```http
DELETE /api/chat/messages/12345
```

只能删**自己发的**。成功 `{"code":200,"message":"已删除"}`。删除是**软删**：不物理
抹除，别人的客户端会把正文换成 `[该消息已删除]`。

| 状态码 | 情形 |
|--------|------|
| `404` | 消息不存在**或已删除**（删过第二次也是 404） |
| `403` | 不是你发的（管理员删别人是另一套：必须带 `{"reason":"..."}`，机器人用不到） |
| `400` | `无效的消息 id` |

> 💡 机器人的经典用法是「先发一条占位，算完再改成结果」—— 但**本接口只能删、
> 不能改**（没有编辑接口）。所以要么等算完再发，要么发一条新的、把占位那条删掉。

### 9.6 会话静音 / 从侧栏移除

```http
POST /api/chat/channels/d_xxx/mute     { "muted": true }
POST /api/chat/channels/d_xxx/hide
```

- **静音**：该会话里 **@ 你的站内通知**不再产生（正文消息照收，SSE 照推）。
  只影响通知，**未读徽标照常**。`{"muted": false}` 取消。
- **hide**：把会话从**你的**侧栏移除（「删除会话」）。**不是退出、不是拉黑、
  也不影响对方** —— 对方之后再发消息，会话会重新出现。同样是软删除。

**静音**对任意可见频道有效；**hide 只对私聊有效** —— 对大区会返回
`403 该会话不能删除`（大区是全员频道，隐藏它没有意义，也会破坏置顶行）。
无权操作该会话仍是 `403`，频道不存在仍是 `404`。

### 9.7 有没有未读（最轻的一次探测）

```http
GET /api/notifications/count
```

**不需要登录**（未登录返回全零）。响应：

```json
{ "code": 200, "count": 3, "chatUnread": true }
```

⚠️ 两点与别处不同：**响应体里没有 `message` 字段**（所以别照 §4 那个信封去解构它），
而且 `chatUnread` 是**布尔** —— 它只回答「有没有未读」，不回答「几条」。

- `count` = 站内通知未读数（顶栏铃铛）。**讨论消息不进这个数**，别拿它当讨论未读。
  它只数别人 @ 你产生的那些条目，而读掉某个会话会让这些条目归零（§7.6）—— 所以
  这个数字**会自己下降**，不是只增不减。
- `chatUnread` = 讨论侧「私聊有未读 / 大区有人 @ 我」。

适合当**第一道筛子**（一次请求、几乎不耗资源）：`chatUnread` 为 `false` 就跳过
§9.3 那次重查询。要具体数字还是得看 §9.3。

---

### 9.8 当前消息作者的聊天气泡

```http
GET /api/chat/channels/lobby/appearance?users=u_xxx,u_yyy
```

只返回当前可访问频道中发过消息的作者，最多查询 100 个不同用户 id：
`{ "code": 200, "message": "ok", "authors": [{ "id": "u_xxx", "bubble_key": "blue-square" }] }`。
`bubble_key: null` 表示免费默认款（未装备、到期或停用）。会话权限与专注模式同消息读口。

气泡跟随作者当前装备，包括历史消息。展示客户端收到 `appearance` 后读取快照，
只更新作者外观；每 60 秒及重新可见时校正一次，覆盖漏推与自然到期。
此事件没有消息 id，不推进 SSE 的消息游标，也不增加未读。

---

## 10. 限频

**这是最容易踩的坑，请按此设计机器人行为。**

| 规则 | 额度 | 适用 |
|------|------|------|
| `chatMinute` | **120 次 / 分钟** | 发消息（**拍一拍 / 表情 / 带图消息各算一条**）；流式任务只在 `complete` 扣一次 |
| `chatDaily` | **8000 次 / 24 小时** | 发消息；流式任务只在 `complete` 扣一次 |
| `chatGenerationCreateMinute` | **12 次 / 分钟** | 创建生成任务（§7.8）。桶键 `chatgen:create:<用户 id>`；幂等重放不消耗 |
| `chatGenerationChunkMinute` | **600 次 / 分钟** | 提交生成片段（§7.8）。桶键 `chatgen:chunk:<用户 id>`；重放也消耗 |
| `chatPoll` | 120 次 / 分钟 | 会话列表与未读对账（§9.3） |
| `chatNewChannel` | 20 次 / 分钟 | 发起私聊（§9.1） |
| `imageUploadHourly` | 200 张 / 小时 | 上传图片（§9.2，按张数计） |
| `loginPerIp` | 300 次 / 15 分钟 | 登录，**仅统计失败** |
| `loginPerUser` | 100 次 / 15 分钟 | 登录，**仅统计失败** |
| `passwordPerUser` | 20 次 / 分钟 | 登录、付款确认、签发凭据、改密共享用户 ID 桶，成功也计数 |
| `passwordPerIp` | 120 次 / 分钟 | 密码计算，成功也计数 |
| `passwordGlobal` | 240 次 / 分钟 | 全站网络密码计算；另外同时最多 4 个在途计算 |

**两条生成配额与 `chatMinute` / `chatDaily` 相互独立**：创建与分块**不占**正式发言
额度，正式额度只在 `complete` 真正调用发送内核时扣一次。因此一个流式任务可能
创建、分块都成功，却在 `complete` 撞上 `429 send_rate_limited`（任务转 `failed`）。
生成任务的活动名额已满返回 `503 capacity`，那是容量而不是限频，不要按 429 退避。

**不在表里的接口**（不消耗任何配额，但也别拿它们当心跳刷）：

| 接口 | 为什么没有配额 |
|------|----------------|
| 正在输入（§7.5） | 只有一条「同频道 3 秒一次」的服务端节流 |
| 已读（§7.6） | 只是推进游标 —— 但留意它顺带决定顶栏「讨论」红点熄不熄，以及清掉该会话的 @ 通知 |
| 报到（§7.7） | 本身只写服务端进程内的一个条目；但每次会做一次频道可访问性查询（不是零成本） |
| 生成任务查询（§7.8 的 `GET`） | 只读自己的任务状态，没有独立配额；别拿它当轮询 |
| 表情清单（§7.4） | 素材变动很慢，一天拉几次足够 |
| 用户搜索（§9.1）、会话内搜索（§9.4）、撤回（§9.5） | 都是读或轻写，没有独立配额 |

`GET .../messages`（§8）**同样没有独立配额**（`chatPoll` 是给 §9.3 的对账接口的），
但这不代表可以拿它当轮询用 —— 它和 §9.3 一样重。

超限一律 `429`，`message` 按接口不同：发消息是 `发言过于频繁，请稍后再试`（分钟额度）
或 `今日发言已达上限，请明日再试`（日额度），对账是 `请求过于频繁，请稍后再试`。
生成接口的限频还要看 `error`：创建 / 分块是 `rate_limited`，`complete` 撞正式配额是
`send_rate_limited`（此时任务已转 `failed`）。**常规接口判断一律只看 `code === 429`。**
两个例外：**图片上传**的限频失败是逐张进 `failed[]`（见 `docs/bot/image-bot.md` §8）；
非限频的权限拒绝仍是 `401` / `403`，不是 429；生成容量不足是 `503`。

两点提醒：

- **登录成功不消耗失败预算，但消耗密码计算预算**。定时重登应错开，收到 429 后等待；不要用登录作心跳。
- **`chatDaily` 每天 8000 条是硬上限。** 一个「看到消息就回」的机器人很容易烧光，
  然后当天彻底哑火。**建议只回应 @ 到自己的消息**（`content` 里出现 `@mybot`
  且按用户名精确匹配），而不是回应每一条大区消息。

> 限频计数存在服务端（进程内计数桶，定期落盘快照），**重启不会清零** ——
> 别指望靠重启洗掉自己的用量。但它也不是持久化账本，不要拿它做用量统计。

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
    "frame_url": null,            // 头像框贴图；null = 没戴 / 已过期 / 素材缺失（判定已在服务层做完）
    "bubble_key": null,           // 作者当前有效气泡；默认 null，蓝底直角 "blue-square"，蓝色直角 "blue-outline-square"
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
    "updated_at": "2026-09-11T20:31:05.000Z"
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
  "created_at": "2026-09-11T20:31:05.000Z"
}
```

### 11.2 `ChatChannelDTO`（§9.3 的 `channels[]`）

```jsonc
{
  "id": "lobby",                    // 或 "d_xxx"
  "kind": "lobby",                  // "lobby" | "direct"
  "title": "讨论大区",
  "peer": null,                     // 私聊才有：{ "id": "u_yyy", "username": "alice", "frame_url": null }
  "unread_count": 3,                // 未读条数
  "mention_count": 1,               // 大区专属：未读里 @ 到我的条数（私聊无此字段）
  "peer_last_read_message_id": null, // 私聊专属：对方读到的最新消息 id
  "muted": false,                   // 已静音（只影响通知，见 §9.6）
  "last_message": {                 // 无消息时为 null
    "id": 12345,
    "content": "…",                 // 预览：正文折叠成一行后截断到 60 字
    "author_name": "alice",
    "created_at": "2026-09-11T20:31:05.000Z"
  },
  "disabled": false                 // 专注模式且勾选了「屏蔽讨论大区」时该频道不可进入（当前只有大区会 true）
}
```

### 11.3 `ChatStreamEvent`（SSE 事件）

见 §6.2。完整定义：

```jsonc
{ "type": "message", "channel_id": "lobby", "message": { /* ChatMessageDTO */ },
  "generation_id": "可选：由生成任务发布时带原任务 id" }
{ "type": "resync" }
{ "type": "appearance" } // 气泡装备变化，不携带身份或消息内容；纯文本机器人可忽略
{ "type": "typing", "channel_id": "lobby", "user_id": "u_xxx", "username": "alice" }
{ "type": "read",   "channel_id": "d_xxx", "user_id": "u_xxx", "message_id": 12345 }
{ "type": "generation_snapshot", "generation_id": "…", "channel_id": "lobby",
  "revision": 3, "author": { /* ChatAuthorDTO，同 §11.1 */ }, "source": "累计正文" }
{ "type": "generation_terminal", "generation_id": "…", "channel_id": "lobby",
  "revision": 4, "status": "completed", "message_id": 12345 }
```

生成事件**不带 SSE `id`**，`generation_terminal` 的 `error` 只在失败终态出现，
`message_id` 只在 `completed` 出现；`generation_snapshot` 每帧都是完整累计正文
（不是增量），`revision` 严格递增，客户端应忽略不更新的帧。

### 11.4 生成接口（§7.8）

```jsonc
// POST /api/chat/channels/:id/generations
{ "code": 200, "message": "生成任务已创建",
  "generation_id": "…", "next_seq": 1,
  "idle_timeout_ms": 120000, "max_duration_ms": 600000 }

// POST /api/chat/generations/:id/chunks
{ "code": 200, "message": "ok", "accepted_seq": 2, "next_seq": 3, "revision": 2 }

// POST /api/chat/generations/:id/complete（发布成功）
{ "code": 200, "message": "发送成功", "status": "completed",
  "message_id": 12345, "chat_message": { /* ChatMessageDTO */ } }

// POST /api/chat/generations/:id/complete（失败终态，HTTP 与 code 同值）
{ "code": 429, "message": "发言过于频繁，请稍后再试",
  "status": "failed", "error": "send_rate_limited" }

// POST /api/chat/generations/:id/complete（写库结果未知）
{ "code": 500, "message": "消息写入结果未知，请先核对频道消息再决定是否重发",
  "status": "commit_unknown", "error": "commit_unknown", "retryable": false }

// POST /api/chat/generations/:id/cancel
{ "code": 200, "message": "生成任务已结束", "status": "cancelled" }

// GET /api/chat/generations/:id
{ "code": 200, "message": "ok", "status": "active", "next_seq": 3, "revision": 2 }
```

`status` 取值：`active` / `finalizing` / `completed` / `failed` / `commit_unknown` /
`cancelled` / `expired`。终态回执仍在时，`GET` 以 `200` 返回终态；`expired` 的
`GET` 同样是 `200` + `status: "expired"`，只有 `chunks` / `complete` / `cancel` 才是
`410 gone`。

`error` 取值见 §7.8 的错误表；`message` 永远是字符串，`chat_message` 只在
**真正执行发布**时出现，进入终态后的回执重放不再带它。

---

## 12. 礼仪与约定

技术之外，两点请配合：

1. **让机器人的身份可辨认。** 建议用户名带 `bot` 后缀（如 `mybot`），
   或在其个人简介里写明「这是机器人」。否则大区里的用户会以为在跟人对话。
2. **清楚告知外送、记忆和画像用途，并取得所需授权。** 本站支持机器人在账号权限和
   合法处理依据范围内，将讨论内容用于角色扮演、问答、搜索、摘要、偏好学习或用户画像。
   在简介、服务说明或交互提示中说明运营者及联系方式、读取范围、外部接收服务、用途、
   保存期限和拒绝、更正、删除途径；外送内容或持续建立用户记忆、画像前，应向受影响用户
   清楚告知，并依法履行所需的同意及跨境处理义务。core 读取权限、站长允许接入或简介中的
   一句声明，都不能代替法律要求的个人同意；大区可读也不表示内容已向全互联网公开。
   具体要求见本站[用户协议](https://raricy.com/terms)与[隐私政策](https://raricy.com/privacy)。

---

## 13. 排错速查

| 现象 | 原因 |
|------|------|
| 登录成功但讨论接口 `403 需要核心用户权限` | 账号是 `user` 不是 core+，见 §2.2 |
| 所有写请求 `403 跨源请求被拒绝 (CSRF)` | 你**手动设置了错误的 `Origin`**。非浏览器客户端直接不带该头即可（§3.1） |
| 讨论接口全部 `403 你已被禁言…` | 账号被禁言，等解禁或联系站长 |
| `429` | 触发限频，见 §10；发消息注意 `chatDaily` 8000 上限 |
| 突然收不到消息 | 连接被踢或背压断开（§6.4），实现重连 + `Last-Event-ID` 补齐 |
| 收到 `{"type":"resync"}` | 断线太久积压超 100 条，按 §8 重新拉一页对齐 |
| 图片发不出去 | 正文不支持手写 `<img>`，要先用 `image_id`（§7.3 / §9.2）；也可以直接用 `[@<10位图片ID>]` 内联（§7.3） |
| `400 消息不能超过5000字` / `图片或引用消息不能超过5000字` | 正文超长（§7.1） |
| 消息时间差 8 小时 | `created_at` 带的是**假 `Z`** —— 语义是 UTC+8 墙上时间（§5） |
| 解析时间戳崩了 / 取不到值 | 服务端发的是 `"…T…Z"` 的 ISO 串，**不是**空格分隔的 `"YYYY-MM-DD HH:MM:SS"`（§5） |
| 探活一直「有效」，业务请求却 401 | `/api/auth/me` 永远回 200，要按 `user === null` 判（§3.2） |
| 对方一直看不到「正在输入」 | 三查：频道对不对（§7.5）、是不是被 3 秒节流了（被节流也是 `200`）、对方在专注模式里勾了「屏蔽讨论大区」（他收不到大区广播） |
| 拉到的 `unread_count` 永远不降 | 收消息**不会**自动标记已读，要自己调 §7.6 |
| §7.6 返回 `200` 但 `message_id` 是 `0` | 频道不存在 / 不是你的会话 / 该频道还没有消息 —— 看 `message_id`，别看 `code` |
| 表情发出去是原文 `[@猫猫/开心]` | 名字写错、合集被 `ignore`、或名字含 `_` 等集合外字符（§7.4）。先拉 §7.4 的清单核对 |
| 拿不到未读条数 | `GET .../messages`（§8）不带未读，未读在 §9.3 |
| 正在某个会话里被 @ 却收不到通知 | 刻意的：服务端判定你正在看这个会话（§7.7），只是不打扰 —— 未读数与顶栏红点照常。调过 §7.7 又不想被抑制，就别再报到了（约 150 秒后自动失效） |
| 铃铛里的 @ 通知自己变成已读了 | 读到那个会话了（§7.6 第 4 条）：进频道 / 看新消息都会把该会话的 @ 通知一并标已读 |
| 生成分块返回 `409` | `seq` 跳跃，或同一 `seq` 的内容与已接受的不一致。按响应里的 `next_seq` 续传（§7.8） |
| 创建生成任务返回 `503` | 每作者 1 个 / 全站 32 个活动任务已满，等任务结束；或退回一次性发送（§7.8） |
| `complete` 返回 `500`、`status=commit_unknown` | 写库结果未知：先查频道消息核对，**不得自动重发**（§7.8） |
| `complete` 返回 `429 send_rate_limited` | 正式发言配额不足，任务已转 `failed`、没有发布；处理配额后新建任务（§7.8 / §10） |
| 生成中的预览与正式消息重复 | 按 `message.id` 去重；预览用正式事件的 `generation_id` 或 `generation_terminal` 的 `message_id` 清除（§6.2 / §7.8） |

---

## 14. 最小可用流程

```
1. POST /api/auth/login                        → 存下 raricy_session
2. GET  /api/chat/stream                       → 建 SSE 长连接
3. 收到 type=message 且 channel_id=lobby
   → 若 content 里 @ 到自己，则：
4. POST /api/chat/channels/lobby/typing        ← 可选：先让对面看到「正在输入」
5. POST /api/chat/channels/lobby/messages
   { "content": "..." }
6. POST /api/chat/channels/d_xxx/read          ← 可选：把读过的会话标记已读
                                                  （私聊会推回执，对面能看到「已读」）
```

断线时：`Last-Event-ID` 重连补齐；收到 `resync` 就重拉一页。
收到 `401` 就重新登录再重连。收到 `429` 就退避。

**想让回复带表情**：启动时 `GET /api/stickers`（§7.4）拿一份「合集名 / 表情名」，
之后正文里写 `[@猫猫/开心]` 就是一张图。

**流式机器人（可选）**：把上面第 5 步换成下面四步，其余不变。

```
5a. 生成并保存 client_request_id（UUID），POST
    /api/chat/channels/lobby/generations   { "client_request_id": "<UUID>" }
5b. 对第 1..N 段正文依次 POST .../generations/<id>/chunks
    { "seq": 1, "delta": "..." }           ← seq 从 1 递增，等每次确认再发下一块
5c. POST .../generations/<id>/complete     { "last_seq": N }
5d. 失败时按 §7.8 分支：429 退避、409 按 next_seq 续传、commit_unknown 先查再决定
```

网络超时用**同一个** `client_request_id` 重试创建；只有确认上一条没有发布、并且
要开始新回复时才换新 UUID。容量满（`503`）或不想实现流式时，直接走第 5 步的一次性
发送，功能完全不受影响。
