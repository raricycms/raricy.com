# 项目架构

聪明山 / raricy.com 的当前架构：Next.js 15 单进程 + Prisma 6 + SQLite + 独立 FastAPI 账户微服务。

> 上一版是 Flask 单体，2026-07 全部替换。本文档只描述现役架构；Flask 历史仅在「迁移史速查」一节列出。

## 1. 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Next.js 15（App Router）· React 19 · TypeScript 5 |
| ORM | Prisma 6（provider=sqlite），直连 `instance/database/db.db` |
| 鉴权 | JWT（`jose`）· 密码哈希与历史 werkzeug **双向互通**（用户无需改密） |
| 会话 | JWT cookie + `User.sessionVersion` 失效机制（对齐旧 Flask-Login 的 `session_version`） |
| CSRF | `src/middleware.ts` 对状态变更方法校验 `Origin`/`Referer` 同源 |
| 文件落盘 | 头像/图床/故事落 `instance/`（gitignored） |
| 鱼干账户 | 独立 FastAPI 微服务（本仓**只**通过 HTTP 调用，本仓无 Python） |
| 渲染 | 博客 / 评论 / 故事 — 客户端 marked + DOMPurify（详见 §6.7） |
| 测试 | vitest 单测 + Playwright e2e |
| 限频 | 进程内内存限频（`src/lib/rate-limit.ts`） |
| 部署 | npm + nginx 反代 + systemd（建议） |

## 2. 进程拓扑

```
                        ┌──────────────────────────────────────┐
                        │           用户浏览器                  │
                        └──────────┬────────────┬──────────────┘
                                   │ TLS (HTTPS) │
                                   │            │
                         ┌─────────▼──┐    ┌─────▼─────────┐
                         │   nginx    │    │   account-    │
                         │  (反代)    │    │   service     │
                         │ proxy_pass │    │  (FastAPI,    │
                         │ → :3000    │    │   独立仓库)   │
                         └─────┬──────┘    └─────┬─────────┘
                               │                 │
                               │ HTTP/3000       │ HTTP/8000
                               │ local           │ local
                         ┌─────▼──────────┐      │
                         │   Next.js      │──────┘
                         │  (单进程)      │
                         └──┬─────────────┘
                            │ Prisma 直连
                            ▼
                     ┌──────────────────┐
                     │ instance/        │
                     │ ├── database/    │
                     │ │   └── db.db    │
                     │ ├── avatars/     │   ⟨gitignored 部署时挂载⟩
                     │ ├── images/      │
                     │ └── stories/     │
                     └──────────────────┘
```

**关键点**：
- Next 进程**单实例**（多实例部署需先换 Redis 限频；SQLite 写锁是库级的）。
- 账户服务是**完全独立的部署单元**，独立仓库、独立进程、独立数据库。
- `instance/` 是**数据**，是 gitignored，部署机器提供真实目录。

## 3. 目录布局

```
.
├── src/app/                App Router 页面 + API 路由（详见 §4）
├── src/lib/                业务逻辑层（详见 §5）
├── src/middleware.ts       CSRF 同源校验
├── prisma/
│   ├── schema.prisma       28 表 1:1 映射真实库
│   └── migrations/         含 0_init 基线（已 apply 到 db.db）
├── scripts/                运维/自检/迁移/切换脚本
├── tests/                  vitest 单测 + Playwright e2e
├── docs/                   本文与运维文档；guide/ 为玩家/创作者文档
├── public/                 静态资源（图标 / CSS / favicon）
└── instance/               gitignored: avatars/ database/ images/ stories/
```

## 4. 路由分布（src/app/）

| 路径 | 类型 | 说明 |
|------|------|------|
| `/` | page | 导航首页（不列文章） |
| `/login` · `/register` | page | 认证（登出是 `POST /api/auth/logout`，**没有** GET 路由） |
| `/blog` · `/blog/[id]` · `/blog/upload` · `/blog/[id]/edit` | page | 博客 |
| `/api/blogs` · `/api/blogs/[id]` · `/api/spider/*` | API | 博客 API + 爬虫 API |
| `/api/auth/authentic` · `/zhh` | API + route | 邀请码升 core · 邀请码生成（站长） |
| `/fish` · `/fish/transactions` · `/api/fish/*` | page + API | 小鱼干面板 + 流水 |
| `/notifications` · `/api/notifications/*` | page + API | 通知中心 |
| `/vote` · `/vote/[id]` | page | 投票 |
| `/checkin` · `/api/checkin` | page + API | 每日签到 |
| `/clipboard` · `/clipboard/[id]` · `/api/clipboard/*` | page + API | 云剪贴板 |
| `/image` · `/image/admin` · `/api/images/*` | page + API | 图床 + 管理 |
| `/story` · `/story/[...path]` | page | 故事合集/阅读 |
| `/tool` · `/tool/<sub>` | page | 工具集（aes / base / hash / hex / html / qp / translate / url / cattca） |
| `/game` · `/game/<sub>` · `/api/game/game_token` | page + API | 游戏菜单 + 9 款游戏（另有 `/game/wand` 演示页） |
| `/admin/*` · `/api/admin/*` | page + API | 管理后台（档位分页而异，见 §8） |
| `/audit` · `/audit/[id]` | page | 审计日志公示 + 申诉 |
| `/contact` · `/privacy` · `/terms` | page | 联系 / 隐私 / 条款 |
| （无 URL）`forbidden.tsx` | 特殊文件 | 403 页本身；由 `forbidden()` 原地渲染，**不是** `/forbidden` 路由 |
| `/sitemap.xml` · `/robots.txt` | route | sitemap.ts / robots.ts |
| `/api/avatar/[id]` · `/api/images/[id]/raw` | API | 头像 / 图床原生分发 |
| `/u/[username]` | page | 公开用户主页 |

## 5. 业务逻辑层（src/lib/）

按子域分组（每组均与路由 1:1 或 1:多对应）：

| 分组 | 文件 |
|------|------|
| 认证 / 会话 | `auth.ts` · `session.ts` · `password.ts` · `invite-code.ts` · `user-service.ts` · `identicon.ts` |
| 数据层 | `db.ts` · `db-time.ts` · `format.ts` |
| 博客域 | `blog-service.ts` · `feed-service.ts` · `comment-service.ts` · `comment-shared.ts` · `blog-sort-pref.ts` · `spider-service.ts` |
| 富文本渲染 | `rich-text.ts`（共享管线）· `chat-markdown.ts` · `comment-markdown.ts` · `blog-markdown.ts` · `markdown-math.ts` · `linkify.ts` · `vditor-theme.ts` |
| 聊天 | `chat-service.ts` · `chat-bus.ts`（SSE 订阅）/ `chat-shared.ts`（DTO）· `chat-sidebar-pref.ts` · `focus-mode.ts` |
| 通知 / 审计 | `notification-service.ts` · `broadcast-service.ts` · `audit-service.ts` · `admin-appeal-service.ts` |
| 投票 / 签到 / 剪贴板 | `vote-service.ts` · `checkin-service.ts` · `clipboard-service.ts` |
| 图床 | `image-service.ts` · `image-upload.ts`（服务端）· `image-client.ts`（浏览器侧选图上传，聊天与评论共用）· `vditor-upload.ts`（Vditor 编辑器的上传配置，博客与剪贴板共用；与 `/api/images` 的字段名/响应结构两端对齐，见 `tests/unit/vditor-upload.test.ts`） |
| 故事 | `story-service.ts` |
| 游戏 | `atamas-pref.ts` |
| 小鱼干 | `fish-service.ts` · `fish-admin.ts` · `fish-sync.ts`（账本 + 补偿，见 §6.3）· `fish-units.ts`（单位换算）· `account-client.ts` |
| OAuth 2.0 | `oauth.ts`（见 `docs/oauth.md`） |
| 管理域 | `admin-user-service.ts` · `admin-blog-service.ts` · `admin-category-service.ts` · `admin-comment-service.ts` · `admin-clipboard-service.ts` · `admin-vote-service.ts` · `admin-image-service.ts` · `admin-stats-service.ts` |
| 工具 / 安全 | `short-id.ts` · `safe-url.ts` · `guard.ts` · `rate-limit.ts` · `turnstile.ts` |

> 上表是**穷尽** `src/lib/*.ts` 的（新增文件记得补一行）—— §6.3、§8 会引用其中若干，
> 之前整块漏了聊天子域与 `oauth.ts`，导致正文引用的文件在本表里查不到。

API 端点位于 `src/app/api/<group>/<verb>/route.ts`，**薄**层：参数校验 + 权限校验 + 调 `src/lib/*` + 组装响应。

## 6. 关键子系统

### 6.1 认证与会话

- **密码哈希**：`src/lib/password.ts` 选 `scrypt` / `pbkdf2:sha256`，与历史 werkzeug **字节级互通**——用户从 Flask 切到 Next 完全不感知。
- **会话**：登录成功签发 JWT（`jose`，HS256），cookie 设 `HttpOnly` + `SameSite=Lax`。`Secure` 由 `X-Forwarded-Proto` 推断或 `COOKIE_SECURE` 显式控制。
- **踢下线**：`User.sessionVersion` 单调递增。`session.ts` 解析 JWT 后比对当前 `user.sessionVersion`，不一致则视为失效。
- **登出**：**只有** `POST /api/auth/logout`（`base.js` 的 `window.logout()` / `LogoutLink` 组件）。
  清会话是状态变更，**不能有 GET 入口** —— GET 会被本人以外的东西发起（浏览器预取视口内的
  `<Link>`、爬虫、第三方页面上的 `<img src="…/logout">`，而本站刻意允许被 iframe 嵌入），
  症状是用户莫名其妙掉线。曾经确实有一个 `GET /logout`，被 403 页的一个链接踩中过。
- **入口**：登录迁到 `core` 通过邀请码（注册时填，或注册后走 `/api/auth/authentic` 验证）。

### 6.2 数据层

- **Prisma schema**：`prisma/schema.prisma` 与真实库 1:1 映射。改 schema 时**手写** `prisma/migrations/<n>_<name>/migration.sql` 并同步 schema.prisma，然后 `npm run migrate -- up` 应用（见 docs/deploy.md「修改 schema 后」；生产库禁止 `prisma migrate dev` / `db push`）。
- **时间戳列**：INTEGER 毫秒（与 Prisma 默认 SQLite 写入格式对齐）。规整是**单向门** —— 旧 Flask 的 `YYYY-MM-DD HH:MM:SS` 文本格式 Prisma 解析即抛 500。
- **时间戳语义**：存的是「**UTC+8 墙上时间贴 Z 标签**」，**不是真实 UTC 瞬间**（Flask `datetime.now()` 的历史遗留，normalize 只补 `T`/`Z` 不平移）。因此：取当前时刻一律用 `src/lib/db-time.ts` 的 `nowForDb()`（= `Date.now() + 8h`，与全库历史数据同钟）；「还剩多久」用 `hoursUntil()`；展示用 `ymd`/`ymdhms` 或 `getUTC*`。**禁止**无参 `new Date()`、`toLocale*`、本地 getter（`getHours` 等）。混用两把钟的后果**全是静默的**：禁言到期后多显示 8 小时、当日发文计数跨日错位。由 `tests/unit/db-time-guard.test.ts` 五条静态守卫强制。
- **Prisma 客户端**：单例在 `src/lib/db.ts`，开发模式 HMR 安全。

### 6.3 鱼干账户（跨进程）

- **失败语义 — 写路径 fail-closed**：投喂 / 签到 / 注册建账户 / CLI grant|deduct **全部**遵循：远端账户服务失败 → 本地写入被**补偿事务精确撤销**（对用户等价于回滚）→ 503 / 退出码 2。绝不静默成功。
- **分层（`2_account_sync_ledger` 起）**：本地事务先提交（含 `account_sync_ledger` 一行 pending），远端 HTTP 在事务**外**调用 —— 成功标 `synced`，失败走补偿事务。HTTP **绝不能挪进事务**：那会让 SQLite 写锁被占用最长 `ACCOUNT_SERVICE_TIMEOUT`，并发写耗尽 busy_timeout 直接 `database is locked`。
- **崩溃收敛**：任何「已提交 / 未同步」窗口都留一个 pending 账本行，`npm run cli -- fish sync-retry` 幂等重放收敛；补偿也失败则标 `failed` 并打 `ACCOUNT_RECONCILE_REQUIRED` 日志。详见 `src/lib/fish-sync.ts` 头部。
- **读路径**：默认走远端账户服务拿权威余额；远端不通则降级到本地 `users.driedFish`，并在响应里给出提示。
- **双层鉴权**：`X-Internal-Token`（服务间共享）+ 用户/系统 API Key（`Authorization: Bearer <key>`）。
- **API Key 加密**：`User.fishApiKeyEncrypted` 是 Fernet 加密。密钥派生：
  ```
  key = base64url( SHA-256( FISH_ENCRYPTION_KEY || SECRET_KEY ) )
  ```
  **首次部署既有库必须把 `FISH_ENCRYPTION_KEY` 留空**，否则解不开存量密文。

### 6.4 CSRF 中间件

`src/middleware.ts` 对状态变更方法（POST/PUT/PATCH/DELETE）校验 `Origin` / `Referer` 与对外 Host 同源。

对外 Host 是**三源并集**，不是优先级回退链：`ALLOWED_ORIGINS`（显式配置，逗号分隔）、
`X-Forwarded-Host`（nginx 透传，多值取第一个）、`Host`（直连）三者全部并入同一个集合，
请求的 `Origin` / `Referer` 命中其中**任一**即放行（`src/middleware.ts`）。

所以配了 `ALLOWED_ORIGINS` 并不会让另外两个来源失效；反过来，三者只要有一个与浏览器发来的
Origin 对得上即可，不必配全。

GET/HEAD/OPTIONS 视为安全方法，不校验。

### 6.5 限频

`src/lib/rate-limit.ts`，进程内内存桶（单进程语义）。**配额表以该文件的 `RULES` 为唯一权威**，本文不复述具体数值 —— 那里有 12 条规则（点赞 / 评论 / 投票 / 图床 / 聊天 / 登录…），复述必 drift。两点不显然的行为：

- **桶会落盘**：随 10 分钟一次的惰性清扫写入 `instance/rate-limit-snapshot.json`（原子写；`RATE_LIMIT_SNAPSHOT_PATH` 可覆盖），进程启动时回灌 —— **重启不重置窗口**。不落盘的话，一次发版等于给所有人发免刷通行证，也放走进行中的刷量。测试环境不自动回灌，保证确定性。
- **登录限频只统计失败**：IP 与用户名（小写归一）两个维度分别计数，任一超限即 429。所以正常用户不会被自己的成功登录挡住；顺带它也是 CPU 保护（每次尝试都要跑一次 scrypt）。
- **规则值与计桶的键是两回事**：同一条 `RULES.*` 可以被多处复用，但各处用自己的键前缀，**配额互不相干**。已知的有：博客点赞用 `like:h:`/`like:d:`，评论点赞复用同样的 `likeHourly`/`likeDaily` 数值但键是 `comment-like:h:`/`comment-like:d:` —— 分成两个桶是刻意的，共用会让「给评论点赞」顶掉「给文章点赞」的额度。改 `RULES` 的数值会同时影响两边；只想调一边得另立规则。

**多实例部署时换 Redis**。本站单进程不踩该坑。

### 6.6 文件落盘

| 域 | 路径 | 上传入口 | 读取入口 |
|----|------|---------|---------|
| 头像 | `instance/avatars/<uuid>.png`（或 `AVATARS_DIR` 覆盖） | **无上传入口**：注册时 `avatarPath` 留空，头像由读取入口按 id 确定性生成；磁盘上的 `.png` 只有 Flask 时代的存量文件 | `src/app/api/avatar/[id]/route.ts`（有文件则回放，否则 `generateIdenticonSvg` 兜底，永不 404） |
| 图床 | `instance/images/<id><ext>`（或 `IMAGE_UPLOAD_FOLDER` 覆盖） | `src/lib/image-upload.ts` — sharp 压缩 + MIME 嗅探 + 配额累计 | `src/app/api/images/[id]/raw/route.ts` |
| 故事 | `instance/stories/<合集>/<故事>.md\|.cattca`（或 `STORIES_DIR` 覆盖） | 服务端直接落盘 | `src/lib/story-service.ts` 服务端 marked |

磁盘目录必须**真实存在**（生产用 systemd/Data卷/挂载点），`node scripts/check-instance.mjs` 一键建好骨架。

### 6.7 Markdown / 内容渲染

| 场景 | 渲染方式 | 管线 |
|------|---------|------|
| 聊天正文 / 评论正文 | **客户端**渲染，同一套管线 | `rich-text.ts`（marked → DOMPurify → 后处理），白名单与链接类名见 `chat-markdown.ts` / `comment-markdown.ts` |
| 博客正文 | **客户端**渲染 | `src/app/components/MarkdownRenderer.tsx`（marked + DOMPurify + highlight.js + MathJax + `[@…]` 内容引用） |
| 故事正文 | **服务端**渲染 | `src/lib/story-service.ts` 的 `marked` + `stripScripts`。内容由站长直接写在 `instance/stories/`，按可信输入处理，**不走 DOMPurify / highlight.js** |
| 内容引用 `[@…]` | 浏览器渲染时正则替换为剪贴板/投票/图床组件 | `src/app/components/MarkdownRenderer.tsx` 的 `ContentRefProcessor`（按 id 长度分流：8 位剪贴板 / 9 位投票 / 10 位图床） |
| 工具页 cattca-guide | **服务端**渲染 | marked（仅一次，可信文档） |

**聊天与评论共用一条管线**（`rich-text.ts`）。两者的威胁模型与防线逐条相同，差别只在
白名单与链接类名（`chat-msg__link` / `comment-link`），所以管线唯一、参数由调用方注入。
各写一份的代价不是重复代码，是**防线漂移**：任一边漏打一个补丁另一边不会知道，而两边
看起来都「有净化」。五道防线（裸 HTML / 伪协议 / 属性注入 / 外链图片 / 无 DOM 降级）
在 `rich-text.ts` 文件头逐条讲，单测见 `tests/unit/{chat,comment}-markdown.test.ts`。

两处**刻意不参数化**，因为它们是安全口径而非样式偏好：

- `<img>` 一律不在白名单，`![](url)` 降级成链接 —— 发图走图床**附件**（`imageId`），
  不允许正文嵌任意外链图片（跟踪像素 / 访客 IP 泄露 / 混合内容）。
- 无 DOM（SSR）时一律退回转义纯文本。因此**服务端不渲染**这两处的正文，前端调用点
  （`ChatMarkdown` / `CommentMarkdown`）都依赖「列表由客户端拉取、SSR 期零条」这个前提；
  若将来改成服务端直出消息/评论，必须改成「挂载后再渲染」的门控写法，否则首帧不一致。

评论的 `content_html`（服务端转义 + `<br>`）**站内已不再用于渲染** —— 保留给 spider API
（外部只读接口，不能因为站内换了渲染方式就被打碎）与无 JS 降级。

### 6.8 OAuth 2.0 身份绑定（raricy 作为 IdP）

让外部第三方应用以标准 OAuth 2.0 Authorization Code 模式读取 raricy 用户的基础资料。

**三张表**（`prisma/migrations/1_oauth/migration.sql`）：

| 表 | 角色 | PK |
|----|------|-----|
| `oauth_applications` | 已注册的第三方应用（client_id + scrypt 哈希的 client_secret + JSON 串 redirect_uris + disabledAt 软禁用） | 12 字符 base36 |
| `oauth_authorization_codes` | 单次性授权码（10 分钟 TTL） | SHA-256 hex |
| `oauth_access_tokens` | 长效 token（90 天 TTL；支持 revokedAt / lastUsedAt） | SHA-256 hex |

**安全要点**：

- 原始 token / code / client_secret **永不落库**：仅存 SHA-256（不可逆）/ scrypt（自带盐）
- `redirect_uri` 严格精确匹配（无通配 / 前缀 / 子串）
- 授权码单次使用：Prisma 原子 `update where {codeHash, usedAt: null}`
- `client_secret` 与 `User.passwordHash` 同款哈希（werkzeug 兼容），与 SECRET_KEY 轮换解耦
- CSRF 中间件豁免 3 个 server-to-server 端点：`/api/oauth/token` `/userinfo` `/revoke`（鉴权由 client_secret / bearer 承担）

**核心库与端点**：`src/lib/oauth.ts`（纯函数 + Prisma 调用）；6 个 `/api/oauth/*` 路由 + `/oauth/authorize` 页 + `/admin/oauth` 管理页；CLI `oauth create-app / list-apps / disable-app / enable-app`。

详见 `docs/oauth.md`。

## 7. 数据流（4 个典型路径）

### 7.1 用户登录

```
浏览器 POST /api/auth/login
  → middleware.ts  ✓ 同源
  → route.ts       校验 Turnstile（如开启）
  → auth.ts        password.verify()    (werkzeug 互通)
  → route.ts       session.sign()       (JWT cookie)
  → 响应 200 + Set-Cookie
```

### 7.2 投喂一篇文章（小鱼干写路径）

```
浏览器 POST /api/blogs/<id>/feed
  → middleware.ts  ✓ 同源 + core+ (装饰器)
  → feed-service.ts 本地事务：业务写入 + account_sync_ledger 登记一行 pending
  → COMMIT                                  (快、无 IO —— 写锁不在此持有)
  ── 以下在事务外 ──
  → account-client.ts transfer()            (远端同步，幂等键)
       ├ 成功  → settleSync('synced')
       └ 失败  → 补偿事务：撤销本地写入 + 删账本行
                   ├ 补偿成功 → 对用户仍等价于「回滚 + 503」
                   └ 补偿失败 → settleSync('failed') + 对账日志
  → 响应 200 (成功) 或 503 (fail-closed)
```

### 7.3 浏览一篇文章（读路径）

```
浏览器 GET /blog/<id>
  → middleware.ts  ✓ 同源 / 装饰器判定 core+
  → blog-service.ts fetch()
  → Prisma       查询 Blog + BlogContent + Category + 计数
  → Server Component 渲染 Markdown 占位 + 注入数据
  → 客户端 marked + DOMPurify + highlight.js 完成正文
```

### 7.4 浏览目录 /blog（列表读路径，流式）

`page.tsx` **不 await 列表数据**，把 `listBlogs` 的 promise 交给 `<Suspense>` 里的
`BlogListSection`：hero / 搜索框 / 侧栏分类在首个 flush 就画出来，列表随后补上。
实测 RTT 300ms：hero+侧栏 400ms、列表 700ms（改前两者同为 ~790ms）。

```
浏览器 GET /blog
  → middleware.ts  ✓ 同源
  → page.tsx       requireCoreUser() → cookies() → 渲染 hero / 侧栏   ← 首个 flush
  → BlogListSection  await listBlogs()                              ← 流式补上
```

**为什么不能用路由级 `loading.tsx`**（试过，三处回归，别再试）：

1. 它把**整页**压成 fallback；React 靠内联脚本 `$RC` 把真实内容从 `<div hidden>`
   换入，**无 JS 时永远停在骨架** —— 连 hero / 搜索 / 分类导航都没了，会踩掉
   `tests/e2e/blog.spec.ts` 的「禁用 JS › 小屏目录保持展开」。Suspense 方案只罩列表。
2. 守卫被推到挂起之后才跑，响应已以 200 冲出：匿名 `/blog` **307→200**、
   `role=user` **403→200**。
3. 边界让 DOM 非单调（内容 → 骨架 → 内容），`.blog-item` 计数/顺序与 cookie
   稳态断言开始随机挂。

**另一个反直觉点**：服务端本来就在分块（实测拆成 57 个 chunk），但**没有 Suspense
边界时客户端是整体提交的** —— 分块换不来渐进绘制。「服务端在流式」≠「用户看得见流式」。

骨架（`BlogListSkeleton`）尺寸按真实元素逐项实测对齐，类名一律 `blog-skeleton-*`，
**不复用 `.blog-item`**（专注模式用例断言它计数为 0）。

**这套做法只值得用在载荷大的页面。** 收益 ≈ (载荷 − 外壳)/带宽 —— 骨架能提前多久
出现，取决于「正文那部分要传多久」。实测各列表页的 RSC 载荷：

| 页面 | 载荷 | 值不值得改 |
|------|------|-----------|
| `/blog` | 91 KB | ✅ 骨架可见窗口 ~300ms |
| `/admin/users` | 39 KB | ⛔ 见下方硬约束 |
| `/admin/appeals` | 26 KB | ⛔ 见下方硬约束 |
| `/image`（162 张的重度用户） | 14 KB | ❌ 窗口 ~70ms |
| `/vote` | 13 KB | ❌ 实测骨架只露 **42ms**，白加一层复杂度 |
| `/u/[id]` | 13 KB | ❌ 同上 |
| `/audit` | 3 KB | ❌ 外壳还只有个 `<h2>` |

**★ 硬约束：调用 `router.refresh()` 的组件不能落在边界内。**

`/admin/users` 按上面这条本该改（39 KB），实测**退回了**：`AdminUserActions` 在边界内
调 `router.refresh()`，服务端数据已改（DB 与 RSC 载荷都确认是新的）但界面不更新 ——
3 次里错 2 次。对照 `/blog`：`BlogSort` 在**边界外**调 refresh，更新边界内的列表，
一切正常（有 e2e 覆盖）。所以：**refresh 的发起方必须在边界之外**。

据此不能改：`/admin/users`（`AdminUserActions`）、`/admin/appeals`（`AdminAppealActions`）、
`/image/admin`（`ImageAdminTable`）、`/checkin`（`CheckinCard`）—— 它们的 refresh 发起方
都在列表内部。`/image` 勉强可以（`ImageUploader` 留在外壳、只把 gallery 进边界），
但载荷只有 14 KB，不值得。

改任何列表页之前，先 `grep -n "router.refresh()" <该页要放进边界的组件>` 确认一下。

## 8. 关键约定

### 软删除

永不物理删除（站长手动除外）：

| 字段 | 默认 | 模型 |
|------|------|------|
| `Blog.ignore` | false | 博客 |
| `BlogComment.isDeleted` | false | 评论 |
| `BlogLike.deleted` | false | 点赞记录 |
| `ImageHosting.ignore` | false | 图床 |
| `Vote.ignore` | false | 投票 |
| `ClipBoard.ignore` | false | 剪贴板 |
| `ChatMessage.isDeleted` | false | 聊天消息 |

**软删即抹掉附件与原文**：评论被软删后，序列化时 `content` 与 `content_html` 一律换成
占位文案，`image` / `blog` 一律置空（`image_missing` / `blog_missing` 也置 false —— 软删
不是「附件丢了」）。漏掉任何一项都等于「删了没删」：原文还在 DOM 里，或删掉的图仍能
点开看原图。聊天消息同此口径（`chat-service.ts` 的 `attach…`）。

### 角色体系与鉴权门

`src/lib/guard.ts` 是**页面级**鉴权门 —— async 函数，不是装饰器，共四个：

- `requireLogin()`（已登录）—— 只要求登录，角色够不够交给调用方
- `requireCoreUser()`（已登录 + core+）= 对齐 Flask 旧 `@authenticated_required`
- `requireAdmin()`（已登录 + admin+）—— 段内放宽后，由真正要管理权的页面自己把门
- `requireOwner()`（仅站长）= 对齐 Flask 旧 `@owner_required`

未登录 → `redirect('/login?next=<原URL>')` 回跳；已登录但角色不够 → `forbidden()` 原地渲染 403 页。

**`/admin/*` 不是单一档位**：段级 layout（`admin/layout.tsx`）只判 core+ —— 因为段内的
「用户管理」对齐 Flask `auth/management.html`，核心用户本来就能进（只读版：标题
「用户列表」，无禁言 / 发通知 / 角色按钮）。段内需要更高权限的页面**各自把门**
（URL 猜得到，侧栏藏起入口不等于挡住）：`/admin`、`/admin/blogs` 用 `requireAdmin()`；
`/admin/oauth` 用 `isOwner()`；`broadcast` / `categories` / `appeals` 各自的
`layout.tsx` 用 `requireOwner()`。新增段内路由请照抄其中一档，别默认继承。

**API 路由不用它们**（重定向对 XHR 无意义）：各 `route.ts` 自取 `getCurrentUser()` 后返回
`apiErr(403, …)`，管理端另用 `hasAdminRights()`（`src/lib/auth.ts`）之类的判定。

### ID 风格

| 实体 | ID |
|------|----|
| User · Blog · BlogContent · Comment · Notification | UUID4 |
| ClipBoard | 短 ID：**base36**（小写字母 + 数字，8 位，`short-id.ts`） |
| Vote · ImageHosting | 短 ID：**base62**（9 位 / 10 位） |
| Category · AdminActionLog · AdminActionAppeal · UserBan | 自增整数 |

## 9. 迁移史速查

| 阶段 | 状态 |
|------|------|
| Flask 单体（blog+story+clipboard+vote+fish+...） | 已被本分支 `git rm` 删除，git 历史可回看 |
| Flask → Next 分阶段迁移（每模块独立 commit） | 已合并；本分支 commit 全是 Next |
| 鱼干账户微服务拆分（Phase 1/1.5/2） | 已完成；账户服务在**独立仓库** |
| schema 演进路径 | Alembic 31 版删除；Prisma 0_init 基线接管 |

## 10. 风险与已知限制

| 风险 | 影响 | 缓解 |
|------|------|------|
| SQLite 库级写锁 | 高并发写会互相 `database is locked` | 长期建议迁 Postgres（届时去 `DATABASE_URL` 的 `connection_limit/socket_timeout`） |
| 进程内限频 | 多实例下各自计数，总限翻倍 | 多实例前先换 Redis |
| `instance/` 在部署机器 | 需挂载真实目录否则上传 500 | 部署脚本里 `node scripts/check-instance.mjs` 兜底 |
| 初次部署既有库 | `FISH_ENCRYPTION_KEY` 必须留空，否则解不开存量密文 | `npm run diagnose` 会校验 |
| 反代改写了 `Host` 且未透传 `X-Forwarded-Host` | 浏览器 `Origin` 与三个来源都对不上 → 全站 POST 403（CSRF 误杀）。nginx 默认就把 `Host` 设成 `$proxy_host`（upstream 地址），所以**两个头都要显式透传** | `ALLOWED_ORIGINS="你的域名"` 兜底或修 nginx |

---

## 11. 推荐阅读

- `docs/deploy.md` — 部署 / 运行 / nginx / systemd
- `docs/cli.md` — 运维 CLI 命令
- `CLAUDE.md` — 关键约定（约束与反直觉决策）
- 内容/玩法文档：`docs/guide/` —— 玩家与创作者文档（atamas / cattca / 云剪贴板 / 图床 / 投票箱 / story）
