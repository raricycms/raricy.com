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
| 渲染 | 博客 / 评论 / 故事 — 客户端 marked + DOMPurify + highlight.js |
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
│   ├── schema.prisma       22 表 1:1 映射真实库
│   └── migrations/         含 0_init 基线（已 apply 到 db.db）
├── scripts/                运维/自检/迁移/切换脚本
├── tests/                  vitest 单测 + Playwright e2e
├── docs/                   玩家文档 + 运维文档（本文所在）
├── public/                 静态资源（图标 / CSS / favicon）
└── instance/               gitignored: avatars/ database/ images/ stories/
```

## 4. 路由分布（src/app/）

| 路径 | 类型 | 说明 |
|------|------|------|
| `/` | page | 导航首页（不列文章） |
| `/login` · `/register` · `/logout` | page | 认证 |
| `/blog` · `/blog/[id]` · `/blog/upload` · `/blog/[id]/edit` | page | 博客 |
| `/api/blogs` · `/api/blogs/[id]` · `/api/spider/*` | API | 博客 API + 爬虫 API |
| `/auth/authentic` · `/auth/invite` | API | 邀请码升 core · 邀请码生成（站长） |
| `/fish` · `/fish/transactions` · `/api/fish/*` | page + API | 小鱼干面板 + 流水 |
| `/notifications` · `/api/notifications/*` | page + API | 通知中心 |
| `/vote` · `/vote/[id]` | page | 投票 |
| `/checkin` · `/api/checkin` | page + API | 每日签到 |
| `/clipboard` · `/clipboard/[id]` · `/api/clipboard/*` | page + API | 云剪贴板 |
| `/image` · `/image/admin` · `/api/images/*` | page + API | 图床 + 管理 |
| `/photowall` · `/api/photowall/*` | page + API | 照片墙 |
| `/story` · `/story/[...path]` | page | 故事合集/阅读 |
| `/tool` · `/tool/<sub>` · `/api/game/*` | page + API | 工具集 + 9 款游戏 |
| `/admin/*` · `/api/admin/*` | page + API | 管理后台（被 `@admin_required` 守卫） |
| `/audit` · `/audit/[id]` | page | 审计日志公示 + 申诉 |
| `/contact` · `/privacy` · `/terms` · `/forbidden` | page | 联系 / 隐私 / 条款 / 403 |
| `/sitemap.xml` · `/robots.txt` | route | sitemap.ts / robots.ts |
| `/api/avatar/[id]` · `/api/images/[id]/raw` | API | 头像 / 图床原生分发 |
| `/u/[username]` | page | 公开用户主页 |

## 5. 业务逻辑层（src/lib/）

按子域分组（每组均与路由 1:1 或 1:多对应）：

| 分组 | 文件 |
|------|------|
| 认证 / 会话 | `auth.ts` · `session.ts` · `password.ts` · `invite-code.ts` · `user-service.ts` · `identicon.ts` |
| 数据层 | `db.ts` · `db-time.ts` · `format.ts` |
| 博客域 | `blog-service.ts` · `feed-service.ts` · `comment-service.ts` · `spider-service.ts` |
| 通知 / 审计 | `notification-service.ts` · `broadcast-service.ts` · `audit-service.ts` · `admin-appeal-service.ts` |
| 投票 / 签到 / 剪贴板 / 照片墙 | `vote-service.ts` · `checkin-service.ts` · `clipboard-service.ts` · `photowall-service.ts` |
| 图床 | `image-service.ts` · `image-upload.ts` |
| 故事 | `story-service.ts` |
| 小鱼干 | `fish-service.ts` · `fish-admin.ts` · `account-client.ts` |
| 管理域 | `admin-user-service.ts` · `admin-blog-service.ts` · `admin-category-service.ts` |
| 工具 / 安全 | `short-id.ts` · `safe-url.ts` · `guard.ts` · `rate-limit.ts` · `turnstile.ts` |

API 端点位于 `src/app/api/<group>/<verb>/route.ts`，**薄**层：参数校验 + 权限校验 + 调 `src/lib/*` + 组装响应。

## 6. 关键子系统

### 6.1 认证与会话

- **密码哈希**：`src/lib/password.ts` 选 `scrypt` / `pbkdf2:sha256`，与历史 werkzeug **字节级互通**——用户从 Flask 切到 Next 完全不感知。
- **会话**：登录成功签发 JWT（`jose`，HS256），cookie 设 `HttpOnly` + `SameSite=Lax`。`Secure` 由 `X-Forwarded-Proto` 推断或 `COOKIE_SECURE` 显式控制。
- **踢下线**：`User.sessionVersion` 单调递增。`session.ts` 解析 JWT 后比对当前 `user.sessionVersion`，不一致则视为失效。
- **入口**：登录迁到 `core` 通过邀请码（注册时填，或注册后 `/auth/authentic` 验证）。

### 6.2 数据层

- **Prisma schema**：`prisma/schema.prisma` 与真实库 1:1 映射。改 schema 后 `npx prisma migrate dev --name xxx` 生成 SQL。
- **时间戳列**：INTEGER 毫秒（与 Prisma 默认 SQLite 写入格式对齐）。
- **派生时间**：`src/lib/db-time.ts` 的 `nowForDb()` 提供当前 Unix 毫秒。所有显式 "插入时间" 都走它，不依赖数据库 `DEFAULT now()`。
- **Prisma 客户端**：单例在 `src/lib/db.ts`，开发模式 HMR 安全。

### 6.3 鱼干账户（跨进程）

- **失败语义 — 写路径 fail-closed**：投喂 / 签到 / 注册建账户 / CLI grant|deduct **全部**遵循：本地事务先收集变更 → 远端账户服务同步成功 → 才 commit 本地事务。远端失败则本地事务回滚，返回 503 / 退出码 2。详见 `claude.md`。
- **读路径**：默认走远端账户服务拿权威余额；远端不通则降级到本地 `users.driedFish`，并在响应里给出提示。
- **双层鉴权**：`X-Internal-Token`（服务间共享）+ 用户/系统 API Key（`Authorization: Bearer <key>`）。
- **API Key 加密**：`User.fishApiKeyEncrypted` 是 Fernet 加密。密钥派生：
  ```
  key = base64url( SHA-256( FISH_ENCRYPTION_KEY || SECRET_KEY ) )
  ```
  **首次部署既有库必须把 `FISH_ENCRYPTION_KEY` 留空**，否则解不开存量密文。

### 6.4 CSRF 中间件

`src/middleware.ts` 对状态变更方法（POST/PUT/PATCH/DELETE）校验 `Origin` / `Referer` 与对外 Host 同源。

对外 Host 判定顺序（**求稳**的口径）：
1. `ALLOWED_ORIGINS`（显式配置，逗号分隔）—— 最可靠
2. `X-Forwarded-Host`（nginx 透传）—— 反代下的次选
3. `Host`（直连）—— 兜底

GET/HEAD/OPTIONS 视为安全方法，不校验。

### 6.5 限频

`src/lib/rate-limit.ts` 进程内内存表（重启清空）。`RULES` 内置：

```
blog:like        100/h, 500/d
blog:comment     1200/d
vote:create      10/h
vote:cast        30/h
image:upload     75/h
photowall:create 30/h
photowall:update 300/h
fish:admin       5/s     (CLI grant/deduct 用)
```

**多实例部署时换 Redis**。本站单进程不踩该坑。

### 6.6 文件落盘

| 域 | 路径 | 上传入口 | 读取入口 |
|----|------|---------|---------|
| 头像 | `instance/avatars/<uuid>.png`（或 `AVATARS_DIR` 覆盖） | 上传时 PIL/Pillow 等价品（sharper fallback → identicon） | `src/app/api/avatar/[id]/route.ts` |
| 图床 | `instance/images/<id><ext>`（或 `IMAGE_UPLOAD_FOLDER` 覆盖） | `src/lib/image-upload.ts` — sharp 压缩 + MIME 嗅探 + 配额累计 | `src/app/api/images/[id]/raw/route.ts` |
| 故事 | `instance/stories/<合集>/<故事>.md\|.cattca`（或 `STORIES_DIR` 覆盖） | 服务端直接落盘 | `src/lib/story-service.ts` 服务端 marked |

磁盘目录必须**真实存在**（生产用 systemd/Data卷/挂载点），`node scripts/check-instance.mjs` 一键建好骨架。

### 6.7 Markdown / 内容渲染

| 场景 | 渲染方式 | 库 |
|------|---------|---|
| 博客正文 / 评论 / 故事 | **客户端**渲染 | marked + DOMPurify + highlight.js |
| 内容引用 `[@xxxxxxxxxx]` | 浏览器渲染时正则替换为剪贴板/投票/图床组件 | `src/app/components/blog/ContentEmbeds.tsx` |
| 工具页 cattca-guide | **服务端**渲染 | marked（仅一次，可信文档） |

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

## 7. 数据流（3 个典型路径）

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
  → feed-service.ts collectTransaction()   (本地 BEGIN)
  → account-client.ts transfer()           (远端同步)
       ├ 远端成功  → 本地 COMMIT
       └ 远端失败  → 本地 ROLLBACK + 503
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
| `PhotoWallItem.ignore` | false | 照片墙 |

### 角色体系与权限装饰器

`src/lib/guard.ts` 暴露装饰器：
- `requireUser()`（已登录）= Flask 旧 `@login_required`
- `requireCore()`（已登录 + core+）= Flask 旧 `@authenticated_required`
- `requireAdmin()` / `requireOwner()` = Flask 旧 `@admin_required` / `@owner_required`
- API 端点用 `requireUser.json()` 等返回值以 JSON 拒，未授权时 403 而非 HTML 重定向

### ID 风格

| 实体 | ID |
|------|----|
| User · Blog · BlogContent · Comment · PhotoWall · Notification | UUID4 |
| ClipBoard · Vote · ImageHosting | 短 ID（base62） |
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
| 反代未透传 `X-Forwarded-Host` | 全站 POST 403（CSRF 误杀） | `ALLOWED_ORIGINS="你的域名"` 兜底或修 nginx |

---

## 11. 推荐阅读

- `docs/deploy.md` — 部署 / 运行 / nginx / systemd
- `docs/cli.md` — 运维 CLI 命令
- `claude.md` — 关键约定 / 迁移史速查
- 内容/玩法文档：`docs/atamas-game.md` · `docs/cattca-guide.md` · `docs/云剪贴板使用指南.md` 等
