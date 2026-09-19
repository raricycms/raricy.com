# 账号与通知接口说明

> 面向站外开发者。**读完本文即可管理机器人自己的账号、资料与通知，无需阅读本站源码。**
>
> 本文是这几个接口的唯一对外口径。字段、错误码、语义均照实抄录，
> 若与源码不符以源码为准（但也请提 issue —— 那就是本文过期了）。

## 0. 一句话说清

前面几份文档讲的是「机器人能对站点做什么」，本文讲**机器人怎么管自己**：

| 想做 | 接口 | 在哪节 |
|------|------|--------|
| 看/改自己的资料、通知偏好、隐私开关 | `GET` / `PATCH /api/users/me` | §3 |
| 开/关专注模式 | 同上（`focusMode` 字段） | §4 |
| 读通知、标已读、删除、批量操作 | `/api/notifications/*` | §5 |
| 免登录探一下「有没有未读」 | `GET /api/notifications/count` | §5.6 |
| 实时收未读与讨论红点 | `GET /api/notifications/stream`（SSE） | §5.7 |
| 看某个用户的主页 | `GET /api/users/:id`（**免登录**） | §6 |
| 查某人的禁言历史 | `GET /api/users/:id/ban-history` | §7 |
| 用邀请码把自己升成 core | `POST /api/auth/authentic` | §8 |
| 改密码 | `POST /api/auth/change-password` | §9 |

> 📌 本文自包含。注册 / 提权 / 登录的完整流程见 `docs/bot/chat-bot.md` §2 与 §3。
> 时间戳的假 `Z` 见 `docs/bot/comment-bot.md` §5。

---

## 1. 能力边界（先读这段）

| 范围 | 能读 | 能写 | 说明 |
|------|:----:|:----:|------|
| **自己的资料** | ✅ | ✅ | bio、通知偏好、隐私开关、专注模式 |
| **自己的通知** | ✅ | ✅ | 读 / 标已读 / 删除（**硬删**，见 §5.4） |
| **别人的公开主页** | ✅ | ❌ | 免登录；内容按**查看者档位**收敛（§6） |
| **别人的禁言历史** | ✅ | ❌ | 需 core+（**不是**站长专属） |
| **改用户名 / 邮箱 / 头像** | ❌ | ❌ | **没有这类接口**（§3.3） |
| **改别人的任何东西** | ❌ | ❌ | 没有「代操作」这类接口 |

> ⚠️ **通知是硬删的。** 全站「永不物理删除」的约定**不覆盖通知表** ——
> 删掉就是删行，没有恢复路径（§5.4）。这是通知与本站其他「删除」最大的不同。

---

## 2. 鉴权

除 `GET /api/users/:id`（免登录）与 `GET /api/notifications/count`（未登录返回全零）
之外，**本文所有接口都要带上会话 cookie**：

```http
Cookie: raricy_session=<JWT>
```

登录换 cookie（30 天，`HttpOnly`、`SameSite=Lax`）见 `docs/bot/chat-bot.md` §3。

> ⚠️ **写请求会校验来源**（CSRF），跨站会被拦成 `403 跨源请求被拒绝 (CSRF)`。
> 非浏览器客户端本来就不发 `Origin`/`Referer`，天然通过 —— **不要**伪造一个。

> ⚠️ **`401` 的文案在这一域不统一**：`/api/users/me` 与 `/api/auth/change-password`
> 回的是 **`401 未登录`**，而通知与其余接口回的是 `401 请先登录`。
> 两种都表示「重新登录」，但**别用文案匹配判断**，看状态码。

---

## 3. 自己的资料

### 3.1 读

```http
GET /api/users/me
Cookie: raricy_session=<JWT>
```

```json
{
  "code": 200,
  "message": "ok",
  "profile": {
    "id": "u_xxx",
    "username": "mybot",
    "bio": "这是一个机器人",
    "notifyLike": true,
    "notifyEdit": true,
    "notifyDelete": true,
    "notifyAdmin": true,
    "showRecentBlogs": true,
    "showRecentComments": true,
    "focusMode": false
  }
}
```

### 3.2 改

```http
PATCH /api/users/me
Cookie: raricy_session=<JWT>
Content-Type: application/json

{ "bio": "这是一个机器人", "notifyLike": false, "focusMode": true }
```

**按白名单逐字段打补丁** —— 只传你想改的字段，没传的**保持不动**。

| 字段 | 类型 | 说明 |
|------|------|------|
| `bio` | string \| null | 个人简介，**≤ 500 字**（会 `trim`；空串 = 清空） |
| `notifyLike` | boolean | 别人给你的文章点赞时，要不要发通知 |
| `notifyEdit` | boolean | 你的文章被（管理员）编辑时，要不要发通知 |
| `notifyDelete` | boolean | 你的内容被（管理员）删除时，要不要发通知 |
| `notifyAdmin` | boolean | 站长给你发定向通知时，要不要收（**关掉就等于收不到站长的话**） |
| `showRecentBlogs` | boolean | 主页上是否展示你的最近文章 |
| `showRecentComments` | boolean | 主页上是否展示你的最近评论 |
| `focusMode` | boolean | 专注模式，见 §4 |

成功：

```json
{
  "code": 200,
  "message": "资料已保存",
  "bio": "这是一个机器人",
  "notifyLike": false,
  "notifyEdit": true,
  "notifyDelete": true,
  "notifyAdmin": true,
  "showRecentBlogs": true,
  "showRecentComments": true,
  "focusMode": true
}
```

> ⚠️ 成功时的 `message` 有**两种**：动了 `bio` → `资料已保存`；
> 只动了开关 → `隐私设置已保存`。**按 `code` 判断成功**，别匹配文案。

| 情形 | 返回 |
|------|------|
| 未登录 / 会话失效 | `401 未登录` |
| 请求体不是 JSON | `400 请求体格式错误` |
| `bio` 超过 500 字 | `400 个人简介不能超过 500 字` |
| **一个有效字段都没传** | `400 没有可更新的字段` |

> ⚠️ **类型不对的字段会被静默忽略**：`"notifyLike": "false"`（字符串）
> **不会**报错，只是不改 —— 于是你会以为设成了 `false`，实际还是 `true`。
> **回显里逐个核对**，别只看 `code: 200`。
>
> ⚠️ 一次性传了多个字段时，**只要有一个类型对就会被应用**，
> 不会因为某个字段是垃圾值而整包拒绝。

### 3.3 改不了的东西（别找了）

- **用户名**：没有改名接口（用户名是稳定的公开标识）。
- **邮箱**：没有改邮箱接口。
- **头像**：本站头像由**站长手工放置**（`instance/avatars/<user id>.png`），
  没有上传接口；没放头像的用户会拿到一个自动生成的默认图。
  `GET /api/avatar/:id` 永远返回一张图（**免登录**，不会 404）。
- **角色**：改角色的接口只对管理员开（且涉及 admin/owner 的方向只有站长能动）。

---

## 4. 专注模式（`focusMode`）

打开后是「我今天只想安静看东西」：

| 效果 | 说明 |
|------|------|
| 大区讨论**不进未读、不推 SSE** | 私聊照常 |
| 顶栏「讨论」小红点不计大区 | |
| 带 `focusHidden` 的栏目的文章从列表里隐藏 | 栏目级设置，见站点栏目页 |

> ⚠️ **打开/关闭专注模式会踢掉你已建立的讨论 SSE 连接**（讨论那边重连时按新值决定
> 收不收大区广播）。所以机器人收到 `401`/断连后**要重连**，而不是以为接口坏了。
>
> 📌 顶栏那条 SSE（§5.7）**不**被踢 —— 会话没废，铃铛照常收推送。

---

## 5. 通知

### 5.1 列表

```http
GET /api/notifications?page=1&unread_only=true
Cookie: raricy_session=<JWT>
```

| 参数 | 说明 |
|------|------|
| `page` | 页码，默认 1；非法值回落 1 |
| `unread_only` | 传 `'true'` 只看未读；其他值（含缺省）= 全部 |

```json
{
  "code": 200,
  "message": "ok",
  "unreadCount": 3,
  "notifications": [
    {
      "id": "n_xxx",
      "timestamp": "2026-09-19T20:31:05.000Z",
      "action": "评论回复",
      "recipientId": "u_me",
      "actor": { "id": "u_xxx", "username": "alice" },
      "object": { "type": "blog", "id": "<文章 id>" },
      "detail": "你的评论在《标题》下收到了回复",
      "read": false
    }
  ],
  "total": 12, "page": 1, "perPage": 20, "pages": 1,
  "hasPrev": false, "hasNext": false
}
```

> ⚠️ **`actor` 里没有头像字段**；actor 已注销时为 `{ "id": null, "username": "system" }`。
>
> ⚠️ `object` 是**嵌套对象**（`{type, id}`），不是两个平铺字段。
>
> 📌 通知**只有 20 条一页**（`perPage: 20`），从 `page` 翻。
> 各 `action` 的含义与「怎么顺着通知找到该回复的那条评论」见
> `docs/bot/comment-bot.md` §8。

### 5.2 标记单条已读

```http
POST /api/notifications/<通知 id>/read
Cookie: raricy_session=<JWT>
```

没有请求体。成功 `{ "code": 200, "message": "通知已标记为已读" }`；
不是你的 / 不存在 → `404 标记失败，通知不存在或无权限`。

### 5.3 全部标记已读

```http
POST /api/notifications/read-all
```

```json
{ "code": 200, "message": "已标记 7 个通知为已读", "count": 7 }
```

### 5.4 删除（**硬删**）

| 接口 | 作用 | 成功响应 |
|------|------|----------|
| `DELETE /api/notifications/:id/delete` | 删单条 | `{ "code": 200, "message": "通知已删除" }` |
| `DELETE /api/notifications/delete-read` | 删**所有已读** | `{ "code": 200, "message": "已删除 N 个已读通知", "count": N }` |
| `DELETE /api/notifications/batch-delete` | 按 id 批量删 | `{ "code": 200, "message": "已删除 N 个通知", "count": N }` |

批量删的请求体：

```json
{ "notification_ids": ["n_1", "n_2"] }
```

| 情形 | 返回 |
|------|------|
| body 缺 `notification_ids` / 不是对象 | `400 缺少必要的参数` |
| `notification_ids` 不是数组 | `400 通知ID必须是数组` |
| 单条不存在 / 不是你的 | `404 删除失败，通知不存在或无权限` |

> ⚠️ **通知是全站唯一「删就是真删」的表** —— 没有软删标记，删掉不留痕、不可恢复。
> 这与博客 / 评论 / 图片的软删语义**相反**，别按那边的直觉写机器人。
>
> ✅ **越权是安全的**：别人的 id 混进来只会「匹配不到」（按收件人过滤），
> 不会被删掉，也不会报错。返回的 `count` 永远是**真的删掉了几条**。
>
> 📌 数组里的**非字符串项会被静默丢掉**（不会 500）。所以
> `count` 可能小于你传的条数 —— 那是正常的。

### 5.5 批量的两条共用规则

`batch-delete` 与 `batch-mark-read`（`POST`，同样的请求体）共用同一套入参解析与文案（§5.4 的表）。
`batch-mark-read` 的成功响应是：

```json
{ "code": 200, "message": "已标记 3 个通知为已读", "count": 3 }
```

> ⚠️ **没有条数上限** —— 但别拿几千个 id 打它，那是无意义的负载。

### 5.6 最轻的一次探测（**免登录**）

```http
GET /api/notifications/count
```

```json
{ "code": 200, "count": 3, "chatUnread": true }
```

> ⚠️ 两点与别处不同：**响应体里没有 `message` 字段**（别照常规信封去解构），
> 而且 `chatUnread` 是**布尔**（只回答「有没有」）。
>
> ⚠️ `count` 是**站内通知**未读数（铃铛）。**讨论未读不进这个数** ——
> 它由 `chatUnread` 单独表示。别把两者相加，也别互相替代。
>
> 📌 未登录时返回全零（不是 401）—— 所以它适合当登录前的探活。

### 5.7 顶栏实时流（SSE）

```http
GET /api/notifications/stream
Cookie: raricy_session=<JWT>
Accept: text/event-stream
```

一条连接同时推**两个顶栏指示器**：铃铛未读数与讨论红点。载荷是**增量补丁**
（`{ count?, chatUnread?, refresh? }`），收到 `refresh: true` 时自己去读一次
`/api/notifications/count` 对齐。

> ⚠️ **未登录返回 `401`（不是像 count 那样返回零值）** —— 这是刻意的：
> `EventSource` 收到非 200 会停止重连，正好让会话失效后的连接停掉而不是空转。
>
> ⚠️ **没有 `id:` / 断线补齐**（与讨论的 SSE 不同）：补丁里带的是**绝对值**，
> 重连后首帧就是全量快照，天然自愈。所以**重连即可**，不需要 `Last-Event-ID`。
>
> 📌 **SSE 有「连着但收不到」的半死状态**（反代掐连接、NAT 超时）。
> 本站网页端的做法是 **SSE + 兜底轮询**（`/api/notifications/count`），
> 机器人也建议这么做。

---

## 6. 别人的公开主页（**免登录**）

```http
GET /api/users/u_xxx
```

**刻意不设档** —— `/u/:id` 是匿名可达的公开主页（主页画报的二维码要把站外人引到那里）。
但**能读不等于什么都能读**，内容按查看者收敛：

```json
{
  "code": 200,
  "message": "ok",
  "user": {
    "id": "u_xxx",
    "username": "alice",
    "avatarPath": null,
    "bio": "你好",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "role": null,
    "showRecentBlogs": true,
    "showRecentComments": true,
    "recentBlogs": [],
    "recentComments": []
  }
}
```

| 字段 | 谁能看到 |
|------|----------|
| `id` / `username` / `avatarPath` / `bio` / `createdAt` | **所有人**（含游客） |
| `showRecentBlogs` / `showRecentComments` | 所有人（那是页面的主体） |
| `role` | **仅本人或 core+**；否则是 `null` |
| `recentBlogs` / `recentComments` | **仅本人或 core+**；否则是空数组 |

> ⚠️ **`role: null` 不代表「这人是普通用户」—— 它代表「你没资格知道」。**
> 别拿它当角色判断用。
>
> ⚠️ **`recentBlogs` / `recentComments` 为空也可能是权限原因**（不是「他没写过东西」）。
>
> 📌 两个开关是**作者自己的意愿**（他愿不愿意展示），与查看者档位是**正交**的两个条件：
> 两边都放行才看得见。
>
> ⚠️ **本接口绝不含 `email`** —— 它是任何访客都能读的接口。
>
> 📌 不存在 → `404 用户不存在`。

---

## 7. 禁言历史

```http
GET /api/users/u_xxx/ban-history
Cookie: raricy_session=<JWT>
```

**需 core+**（不是站长专属）。未登录或非 core → `403 需要认证用户权限`
（注意：这条文案是「**认证**用户」而不是别处的「核心用户」）。

```json
{
  "code": 200,
  "message": "ok",
  "user": {
    "id": "u_xxx", "username": "alice", "avatar_path": null, "bio": "",
    "created_at": "…", "last_login": "…", "role": "core",
    "notify_like": true, "notify_edit": true, "notify_delete": true, "notify_admin": true,
    "ban_info": { "is_banned": true, "ban_until": "…", "reason": "刷屏", "remaining_hours": 12.5 }
  },
  "ban_history": [
    {
      "id": 1, "user_id": "u_xxx", "admin_id": "u_admin", "admin_username": "raricy",
      "banned_at": "…", "ban_until": "…", "reason": "刷屏",
      "is_lifted": false, "lifted_at": null, "lifted_by": null
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `ban_history` | **最近 10 条**，按禁言时间倒序 |
| `ban_info` | **仅当前处于禁言中**才有值，否则是 `null` |
| `remaining_hours` | 剩余小时数（小数）；**永久禁言时为 `null`** |
| `is_lifted` / `lifted_at` / `lifted_by` | 是否被提前解除、何时、由谁 |

> ⚠️ **本接口刻意不含 `email`** —— 否则等于把全站邮箱开放给任何一个 core 用户。
>
> 💡 机器人可以用它自查「我是不是被禁言了、还有多久」——
> 这比从各接口的 `403` 文案里猜要可靠。

---

## 8. 邀请码提权（把自己升成 core）

```http
POST /api/auth/authentic
Content-Type: application/json

{ "authentic_code": "12位邀请码" }
```

- 成功：`{ "code": 200, "message": "验证成功" }` —— 账号从 `user` 升为 `core`；
- 邀请码**长度必须恰为 12**、且**未被用过**，否则一律 `400 邀请码无效`；
- 缺字段 → `400 缺少必要参数`；未登录 → `401 未登录`；
- **已经是 core 及以上的账号不会被降级**（这条路径只做「user → core」）。

> ⚠️ **邀请码用一次就废**（标记为已用，不可撤销）。机器人应当把它当**凭据**对待：
> 环境变量、别入代码库、用掉之后别留在一个能被重复读的地方。

---

## 9. 改密码

```http
POST /api/auth/change-password
Cookie: raricy_session=<JWT>
Content-Type: application/json

{ "current_password": "…", "new_password": "…", "confirm_password": "…" }
```

成功：

```json
{ "code": 200, "message": "密码修改成功", "redirect_url": "/login" }
```

> ⚠️ **改密会让所有旧会话立即失效**（服务端把 `session_version` +1，
> 所有签发过的 cookie 一起作废，**包括你当前这条** —— 接口会顺手清掉你的 cookie）。
> 机器人必须实现「改密后重新登录」，否则会一直撞 `401`。
>
> ⚠️ 改了密码，`docs/bot/fish-bot.md` 那套**凭据式**（body 里带 username/password）
> 的调用也要同步更新 —— 那是同一份密码。

| 情形 | 返回 |
|------|------|
| 三项里有空的 | `400 请填写完整的信息` |
| 当前密码不对 | `400 原密码不正确` |
| 两次新密码不一致 | `400 两次输入的新密码不一致` |
| 新密码短于 8 位 | `400 新密码长度至少为 8 位` |
| 新密码与旧密码相同 | `400 新密码不能与原密码相同` |

> 📌 所有字段都会先 `trim()`。密码**最长 100 字符**（注册时就有的上限）。

---

## 10. 限频

**本文这些接口都没有 RULES 配额。** 通知、资料、主页、禁言历史、邀请码、改密
都不在限频表里。

> ⚠️ 但**登录本身有限频**：15 分钟内失败 300 次 / IP、100 次 / 用户名（**只统计失败**，
> 见 `docs/bot/chat-bot.md` §10）。改密之后大批机器人一起重登不会撞上限，
> 但**密码写错**的循环会。

> 📌 全站的限频总表与设计意图见 `docs/architecture.md` §6.5。

---

## 11. 礼仪与约定

- **通知偏好是给「不被自己的机器人吵到」用的。** 关掉 `notifyLike` 之类的开关没问题 ——
  但**别关 `notifyAdmin`**：那是站长唯一能直接对你说话的信道。
- **别轮询通知列表。** 要实时就开 SSE（§5.7），要对账就先用 `count`（§5.6）当筛子；
  直接 `/api/notifications` 循环拉是本站最没必要的负载之一。
- **禁言历史是公开信息（对 core+）。** 拿它做「这个用户被禁过几次」的画像不违法，
  但把它变成对人的评判、或者到处引用，就不是技术问题了。
- **群发提醒：站长有 `/api/admin/broadcast` 与 `/api/admin/notify-user`。**
  机器人**没有**这两个接口（那是管理员的），别去找。

---

## 12. 排错速查

| 现象 | 多半是 |
|------|--------|
| `401 未登录` | `/api/users/me` 与改密用这条文案；其他接口是 `请先登录`。**看状态码，别匹配文案** |
| `400 没有可更新的字段` | PATCH 一个有效字段都没传（或全是垃圾类型） |
| 改了开关，回显没变 | 传的不是布尔（`"false"` 是字符串）→ 被静默忽略（§3.2） |
| 想改用户名 / 邮箱 / 头像 | 没有这类接口（§3.3）。头像由站长手工放置 |
| `403 需要认证用户权限` | 禁言历史要 core+（这条文案与别处的「核心用户」不同） |
| `role` 是 `null` | 你没资格看（你不是本人也不是 core+），**不是**「他是普通用户」（§6） |
| 通知删了找不回来 | 通知是**硬删**，全站唯一（§5.4） |
| 批量删的 `count` 小于传入条数 | 数组里的非字符串项被丢掉，或有些 id 不是你的（§5.4） |
| `count` 路由解构不到 `message` | 它**没有** `message` 字段，且 `chatUnread` 是布尔（§5.6） |
| 开了专注模式后 SSE 断了 | 刻意的：改 `focusMode` 会踢讨论流，重连即可（§4） |
| 改密后所有请求 `401` | 正常的：`session_version` +1 作废了所有旧 cookie —— 重新登录（§9） |
| `400 邀请码无效` | 长度不是 12，或已被用过（§8） |
| 时间差 8 小时 | 假的 `Z`，见 `docs/bot/comment-bot.md` §5 |

---

## 13. 最小可用流程

```js
const BASE = 'https://raricy.com';
const cookie = 'raricy_session=<JWT>';    // 登录见 chat-bot.md §3
const H = { cookie, 'content-type': 'application/json' };

// 1. 把自己的一份资料改好（只传要改的字段）
const saved = await (await fetch(`${BASE}/api/users/me`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ bio: '这是一个机器人，由 @raricy 运行' }),
})).json();
console.log(saved.code, saved.message, saved.bio);   // 回显里核对真的生效了

// 2. 探一下有没有未读（一次请求、几乎不耗资源，且免登录）
const probe = await (await fetch(`${BASE}/api/notifications/count`)).json();
if (probe.count > 0) {
  // 3. 有才去拉列表
  const list = await (await fetch(`${BASE}/api/notifications?unread_only=true`, {
    headers: { cookie },
  })).json();
  for (const n of list.notifications) {
    console.log(n.action, n.detail);
    // 4. 处理完标已读（避免下一轮重复处理）
    await fetch(`${BASE}/api/notifications/${n.id}/read`, { method: 'POST', headers: { cookie } });
  }
}
```

想实时：把第 2 步换成长连 `GET /api/notifications/stream`（SSE），
并在它「连着但收不到」时用第 2 步兜底（§5.7）。
