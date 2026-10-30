# 云剪贴板机器人接入说明

> 面向站外开发者。**读完本文即可实现一个会写、会读、会引用剪贴板的机器人，无需阅读本站源码。**
>
> 本文是云剪贴板接口的唯一对外口径。字段、长度上限、错误码均照实抄录，
> 若与源码不符以源码为准（但也请提 issue —— 那就是本文过期了）。

## 0. 一句话说清

云剪贴板是**一段可复用的文本**，建成后换一个 **8 位 ID**。正文可以是 Markdown
（默认）或 ReactiveMD；ReactiveMD 发布前会先编译并生成同版本快照：

1. `POST /api/clipboard` —— 建一条，拿回 8 位 `id`；
2. 在评论 / 讨论 / 博客正文里写 `[@<8位ID>]`，读者看到的就是**这段正文本身**
   （不是链接、不是卡片）；
3. 想改就 `PUT /api/clipboard/:id`（**只有作者能改**）。

典型用法是**机器人把长文/模板存一份，到处引用** —— 改一次，所有引用它的地方一起变。

> **剪贴板接口要求 core+**，站内引用按读者会话校验读取权限。
> 剪贴板仅站内共享；对外博客的访客视图保留所有剪贴板引用原文，不下发资源数据。
> 两种视图的区别见 §7.1。

> 📌 本文自包含。账号准备（注册 / 提权）与鉴权（cookie）是全部机器人共用的前置步骤，
> 三份完整口径见 `docs/bot/chat-bot.md` §2 与 §3。时间戳的假 `Z` 见
> `docs/bot/comment-bot.md` §5。

---

## 1. 能力边界（先读这段）

| 范围 | 能读 | 能写 | 说明 |
|------|:----:|:----:|------|
| **建剪贴板** | —— | ✅ | 需 core+ 登录；**每人上限 200 条** |
| **读自己建的** | ✅ | ❌ | `GET /api/clipboard` —— **只列自己的** |
| **读某一条** | ✅ | ❌ | `GET /api/clipboard/:id`，需 core+；普通 core 账号只能读取公开条或自己创建的私有条 |
| **改** | —— | ✅ | `PUT /api/clipboard/:id`，仅作者本人 |
| **删** | —— | ✅ | `DELETE /api/clipboard/:id`，作者**或站长**；软删 |
| 读别人的私有剪贴板 | ❌ | ❌ | 普通 core 账号返回 `403` |

机器人的权限边界是三条：**core+ 角色**、**登录状态**、**（这一域不判）禁言**。

> 📌 **剪贴板不判禁言** —— 它既不是发言也不通知别人，改的只是自己的数据。
> 所以被禁言期间仍然整理得了自己的剪贴板。

---

## 2. 准备账号与鉴权

全部接口**需要 core+ 且登录**。公开注册须填写有效邀请码，成功即为 core。历史未认证账号可补码认证：
新账号注册成功即为 core；历史账号可登录后通过 `POST /api/auth/authentic` 补码认证。
完整流程见 `docs/bot/chat-bot.md` §2。登录换 cookie：

```http
POST /api/auth/login
Content-Type: application/json

{ "username": "mybot", "password": "********" }
```

响应会 `Set-Cookie: raricy_session=<JWT>`（`HttpOnly`、`SameSite=Lax`、**30 天**）。

> ⚠️ **写请求会校验来源**，跨站会被拦成 `403 跨源请求被拒绝 (CSRF)`。
> 非浏览器客户端本来就不发 `Origin`/`Referer`，天然通过 —— **不要**伪造一个。

> 会话失效后一律 `401 请先登录` —— 当成「重新登录」的信号，而不是重试。

---

## 3. 建一条剪贴板

```http
POST /api/clipboard
Cookie: raricy_session=<JWT>
Content-Type: application/json

{
  "title": "答疑模板",
  "content": "## 常见问题\n\n- 问题一……",
  "publicity": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `title` | string | 是 | 标题，**1–40 字符**（不 trim，按原样计） |
| `content` | string | 是 | 正文**源文**，≤ **50000 字符**。默认 Markdown；`format='reactive'` 时是 ReactiveMD 源码 |
| `publicity` | boolean | 是 | **必须显式传**。`true` = 公开（持有 ID 的 core+ 成员可读）；`false` = 私密保存，不公开分享 |
| `format` | string | 否 | 正文语言：`markdown`（默认）或 `reactive`。未知值 `400`。reactive 发布前必须能编译，失败返回 `400 ReactiveMD 正文无法编译，已拒绝发布` |

> ⚠️ **`publicity` 只认布尔**：缺字段、传 `"true"`、传 `1` 都会回
> `400 wrong publicity format`。**没有默认值** —— 这是刻意的，
> 「没传就当公开」会让人不小心把私有内容放出去。

成功：

```json
{ "code": 200, "message": "success", "id": "a1b2c3d4" }
```

> ✅ `id` 是 **8 位 base36**（小写字母 + 数字，**含 `g`–`z`**）的短 ID（**不是** UUID，
> 也不是自增数字）。按「十六进制」写校验（`^[0-9a-f]{8}$`）会拒掉绝大多数合法 ID。
> 引用语法 `[@a1b2c3d4]` 认的就是这个 8 位长度。

### 3.1 会被拒绝的情形

| 情形 | 返回 |
|------|------|
| 未登录 / 非 core+ | `401 请先登录` / `403 需要核心用户权限` |
| 请求体不是 JSON | `400 请求体格式错误` |
| `publicity` 不是布尔 / 缺字段 | `400 wrong publicity format` |
| `content` 不是字符串 / 超过 50000 | `400 content too long` |
| `title` 不是字符串 / 空 / 超过 40 | `400 title too long` |
| `format` 不在白名单 | `400 内容格式取值不合法，可选：markdown / reactive` |
| `format='reactive'` | 先编译并生成同版本快照；无法编译时 `400 ReactiveMD 正文无法编译，已拒绝发布` |
| 已有 200 条 | `400 一个用户只能发布200篇云剪贴板！` |

> ⚠️ **报错文案是「英文键名」而不是中文说明**（`wrong publicity format` /
> `title too long`）—— 这一域是站内少见的、沿用历史英文文案的接口。
> 请**按 `code` 判断**，不要匹配文案。
>
> ⚠️ `title` 为空串也算 `title too long` —— 文案没区分「空」与「太长」。

> ⚠️ **200 条数的是「你名下有多少行」，软删的不释放**：删掉的剪贴板仍然占着这 200 的
> 名额（与收藏夹**相反** —— 那边只数未软删的）。所以删到列表看起来空了，
> 也照样建不出新的；真要腾额度只能等站长在服务端清理。

---

## 4. 读

### 4.1 读自己建的

```http
GET /api/clipboard
Cookie: raricy_session=<JWT>
```

```json
{
  "code": 200,
  "message": "ok",
  "clips": [
    { "id": "a1b2c3d4", "title": "答疑模板", "publicity": true, "created_at": "2026-09-19T20:31:05.000Z" }
  ]
}
```

> ⚠️ **列表里没有 `content`** —— 只给元信息。要正文得逐条 `GET /api/clipboard/:id`。
> 也没有分页参数（你自己的全部，上限 200 条）。

### 4.2 读某一条

```http
GET /api/clipboard/a1b2c3d4
Cookie: raricy_session=<JWT>
```

```jsonc
{
  "code": 200,
  "message": "ok",
  "clip": {
    "id": "a1b2c3d4",
    "title": "答疑模板",
    "author_id": "u_xxx",
    "author_name": "mybot",
    "publicity": true,
    "content": "## 常见问题\n\n- 问题一……",
    "format": "markdown",          // markdown / reactive；认不出为 null
    "syntax_version": null,        // 仅 reactive 有意义（语法版本，不是渲染开关）
    "version": "…",                // 这份正文的稳定版本摘要（格式 + 标题 + 正文）
    "created_at": "2026-09-19T20:31:05.000Z"
  }
}
```

> ⚠️ **`content` 始终是源码，不是渲染结果。** 消费方必须按 `format` 分支：
> `markdown` 可以交给 Markdown 渲染器；`reactive` **不能** —— ReactiveMD 有
> `{{ }}`、组件标签等 Markdown 不认识的语法，按 Markdown 解释不会报错，只会把
> 源码当普通文本显示出来。`format` 为 `null`（库里认不出）时也不要猜成 Markdown。
>
> `version` 是引用方判断「这份公开快照有没有变」的稳定标识；正文、标题或格式变化
> 都会让它变化。

| 情形 | 返回 |
|------|------|
| 未登录 / 非 core+ | `401` / `403 需要核心用户权限` |
| **私有条，且你不是作者也不是站长** | `403 该剪贴板为私有内容` |
| 不存在 / 已软删 | `404 剪贴板不存在` |

> ⚠️ **`403` 与 `404` 的区别是有意义的**：`403` 说明这条**存在但是私有的**
> （等于确认了 ID 有效）；`404` 说明它不存在或已删。
> 如果你在做「按 ID 探测」的工具，请意识到这一条会泄露私有条的存在性。

---

## 5. 改

```http
PUT /api/clipboard/a1b2c3d4
Cookie: raricy_session=<JWT>
Content-Type: application/json

{ "title": "新标题", "content": "新正文", "publicity": false }
```

- **请求字段与 §3 完全一致**（`title` / `content` / `publicity` 三个必传，`format` 可选，
  同样是那几档上限）
- 是**整体覆盖**，不是局部更新 —— 只想改标题也得把 `content` 原样带上
- `format` **省略 = 保留库里原值**（不会把待改的正文打回 Markdown）；但**存量 reactive
  无法编译的 reactive 写入被整笔拒绝**，返回 `400 ReactiveMD 正文无法编译，已拒绝发布`
- `syntax_version` 与 `renderer_override` 是**只读**字段：写接口不消费它们
  （传了会被忽略，不产生写入；`syntax_version` 由服务端在开放 reactive 写入后维护，
  `renderer_override` 目前没有写入口）
- 成功：`{ "code": 200, "message": "success", "id": "a1b2c3d4" }`

| 情形 | 返回 |
|------|------|
| **不是作者** | `403 您不是该文章作者，无法编辑！`（文案里说的「文章」是历史措辞） |
| 不存在 / 已软删 | `404 剪贴板不存在` |
| 其余 | 与 §3.1 同一批文案 |

> ⚠️ **改 `publicity` 是即时生效的**：把公开改成私有，**所有正在引用它的地方**
> 对非 core 读者会变成「加载失败」。反过来，把私有改成公开也一样即时。
>
> ⚠️ **站长也不能改别人的剪贴板**（只有读和删对站长放宽）—— 别指望找站长帮忙改。

---

## 6. 删

```http
DELETE /api/clipboard/a1b2c3d4
Cookie: raricy_session=<JWT>
```

- **作者本人或站长**可删（不是你的且你不是站长 → `403 您不是该剪贴板的作者，无法删除！`）
- 不存在 / 已删过 → `404 剪贴板不存在`
- 成功：`{ "code": 200, "message": "success" }`

> ⚠️ **软删除**：站点永不物理删除。删掉之后这个 ID 一律 `404`，
> 但**引用它的正文会变成失效引用**（读者看到 `[剪贴板 <ID> 加载失败]`）。
>
> ⚠️ 「删了再建一条同 ID 的」**做不到** —— ID 是随机生成的，不是你能指定的。

---

## 7. 在正文里引用（`[@8位ID]`）

```json
{ "content": "报名方式见 [@a1b2c3d4]" }
```

读者看到的是**那段正文本身**（走与所在正文同一条净化管线），不是一个链接。
**引用方必须先看 `format`**：`markdown` 可以内联（旧管线）或按各位置规则展开；
`reactive` 与认不出的格式**不得内联**，只能生成安全的站内链接卡片
（`[查看剪贴板](/clipboard/<id>)`）。在 ReactiveMD 正文里，**所有剪贴板引用首期都是
链接卡片**，不嵌套编译，也不把另一种语言的源码拼进父文档。

支持的位置与行为：

| 位置 | 是否展开 |
|------|:--------:|
| **博客正文** | ✅（可以写很多条，也不截断）；reactive 剪贴板只给链接卡片 |
| **云剪贴板正文** | ✅（同上） |
| **评论正文** | ✅（**一条评论最多展开 1 条**，多写的原样显示）；reactive 剪贴板只给链接 |
| **讨论消息** | ✅（同样最多 1 条）；reactive 剪贴板只给链接 |

其余规则：

- **读者必须有对应剪贴板的读取权限**；没有权限时无法展开正文，访客对外博客视图中所有剪贴板均保留原文；
- 剪贴板正文**超过 2000 字会截断**，并附一句提示 + 回原剪贴板的链接；
- 写在**代码块 / 行内代码**里的 `[@id]` **不展开**（要展示语法本身时就这么写）；
- 剪贴板正文是**另一名用户**写的，它与所在正文走**同一条净化管线** ——
  里面不能有 `<img>`、`<iframe>` 之类（白名单外的东西会被转义）。

### 7.1 站内引用与站外视图的区别

| 读者 | 看到什么 |
|------|----------|
| core+ 用户，引用的是**公开 Markdown** 剪贴板 | 正文（正常） |
| core+ 用户，引用的是**有读取权限的私密 Markdown** 剪贴板 | 正文（正常） |
| core+ 用户，引用的是**无读取权限的私密**剪贴板 | `[剪贴板 <ID> 加载失败]` |
| core+ 用户，引用的是 **reactive** 剪贴板 | 链接卡片（不内联源码） |
| 非 core / 未登录读者使用**站内引用接口** | `[剪贴板 <ID> 加载失败]` —— 读取接口要求 core+ |
| 对外可读博客的站外视图，引用的是**公开 Markdown** 剪贴板 | `[@ID]` 引用原文 |
| 对外可读博客的站外视图，引用的是**私密**剪贴板 | `[@ID]` 引用原文 |
| 对外可读博客的站外视图，引用的是 **reactive** 剪贴板 | `[@ID]` 引用原文 |

> 公开字段表示站内共享，不向访客开放，博客引用也不扩大受众。
> 如果需要访客直接阅读这些内容，可把内容写进对外可读博客正文。

> 📌 完整语法（长度识别、展开上限、代码块例外）见
> `docs/guide/内容引用语法指南.md`。

---

## 8. 限频

**剪贴板域没有任何 RULES 配额。** 唯一的闸门是「每人最多 200 条」。

> ⚠️ 但**别拿它当存储刷新** —— 200 条是给「我常用的几段文本」用的。
> 要存结构化数据请用别的机制，剪贴板不是你的数据库。

> 📌 全站的限频总表与设计意图见 `docs/architecture.md` §6.5。

---

## 9. 礼仪与约定

- **剪贴板是「给别人看的文字」。** 写进引用里的内容会出现在**别人的**文章与评论下，
  请自问一句：这段话值得被几十处引用吗？
- **别做「改一条、到处变形」的恶作剧。** 引用是活的 —— 你改一次正文，
  所有引用它的地方**同时**变。这个能力用来维护模板很好，用来改口供很糟。
- **需要对外展示时**，将文字写入对外博客自身正文，引用本身不会对访客展开。
- **站内共享与私密。** publicity=true 表示成员凭 ID 可读；false 仅本人和站长可读。
  admin 没有私密读取例外，运维工具保留现有管理能力。

---

## 10. 排错速查

| 现象 | 多半是 |
|------|--------|
| `400 wrong publicity format` | 没传 `publicity`，或传的不是布尔（§3） |
| `400 title too long` | 标题为空串、或超过 40 字符（文案不区分两种情况） |
| `400 content too long` | 正文不是字符串、或超过 50000 字符 |
| `400 内容格式取值不合法…` | `format` 只认 `markdown` / `reactive`；当前 reactive **写入**未开放（§3） |
| 读到的 `format` 是 `reactive` | `content` 是 ReactiveMD 源码，不能按 Markdown 解析（§4.2） |
| `400 一个用户只能发布200篇云剪贴板！` | 未软删的剪贴板满 200 条 —— 删掉不用的再建 |
| `403 该剪贴板为私有内容` | 别人的私有条。**这条 ID 是存在的**，只是你看不到（§4.2） |
| `403 您不是该文章作者，无法编辑！` | 改别人的剪贴板（站长也不行） |
| `403 您不是该剪贴板的作者，无法删除！` | 删别人的（站长可以删） |
| `[@a1b2c3d4]` 显示成原文 | 写在代码块里了；或 ID 不是 8 位；或那条剪贴板被删了 |
| 读者看到「加载失败」 | 站内引用接口要求 core+，且会校验具体内容的读取权限（§7.1） |
| 正文只展开了一条 | 一条评论/消息最多展开 1 条剪贴板，多的原样显示 |
| 时间差 8 小时 | 假的 `Z`，见 `docs/bot/comment-bot.md` §5 |

---

## 11. 最小可用流程

```js
const BASE = 'https://raricy.com';
const cookie = 'raricy_session=<JWT>';    // 登录见 chat-bot.md §3
const H = { cookie, 'content-type': 'application/json' };

// 1. 建一条（三个字段都必传）
const created = await (await fetch(`${BASE}/api/clipboard`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    title: '答疑模板',
    content: '## 常见问题\n\n- 问题一：……',
    publicity: true,                        // 显式指定，没有默认值
    format: 'markdown',                     // 可省略；reactive 会先编译并生成同版本快照
  }),
})).json();
if (created.code !== 200) throw new Error(`建失败：${created.message}`);
const clipId = created.id;                  // 8 位，存下来

// 2. 到处引用它
await fetch(`${BASE}/api/blogs/${blogId}/comments`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ content: `规则见 [@${clipId}]` }),
});

// 3. 改一次，所有引用一起变
await fetch(`${BASE}/api/clipboard/${clipId}`, {
  method: 'PUT', headers: H,
  body: JSON.stringify({ title: '答疑模板', content: '## 更新后的问题\n\n……', publicity: true }),
});

// 4. 不用了：软删（引用会变成「加载失败」，删前先想清楚）
await fetch(`${BASE}/api/clipboard/${clipId}`, { method: 'DELETE', headers: { cookie } });
```

断线 / `401` → 重新登录。这一域不会遇到 `429`。
