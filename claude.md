# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 项目概述

raricy.com（聪明山）—— 个人博客 / 故事 / 工具集 / 剪贴板 / 图床 / 投票 / 游戏。

- **Next.js 15** App Router + React 19 + TypeScript
- **Prisma 6** 直连 SQLite（`file:../instance/database/db.db`）
- **JWT** 会话 + `session_version` 失效机制（对齐旧 Flask-Login）
- **FastAPI 账户微服务** 独立仓库部署，本仓通过 HTTP 调用
- **迁移走手写 SQL**：`prisma/migrations/<n>_<name>/migration.sql` + `npm run migrate -- up`
  （目录自动扫描，无 manifest）；**不要用 `prisma migrate dev` / `db push` 动真实库**
  （见 docs/deploy.md §「修改 schema 后」）。`schema.prisma` 需同步改——测试库由 `db push` 按它建表。
  老 Alembic 历史已基线化为 `prisma/migrations/0_init/`

历史架构是 Flask 单体（2026-07 之前），已被替换。**不要修改或恢复任何 Flask 代码**——所有 Flask 引用都已在 git 历史中删除。

## 常用命令

- 运行：`npm run dev`
- 依赖：`npm ci`（不要 `npm install`；Next 锁 15.x）
- 测试：`npm test` / `npm run e2e` / `npm run smoke`
- 部署自检：`npm run diagnose -- --url https://你的域名`
- 数据库：`npm run prisma:pull` / `npm run db:normalize` / `npm run db:compensate-fortunes --apply`
- 运维 CLI：`npm run cli -- <cmd>`（granting 角色 / fish balance / fish grant / fish deduct）
- 密钥/数据扫描：`npm run check:secrets`
- 数据目录骨架：`node scripts/check-instance.mjs`

## 目录布局

```
.
├── src/app/                App Router 页面与 API 路由
│   ├── (auth)/             登录 / 注册 / 找回
│   ├── (game)/             9 款游戏
│   ├── blog/               博客
│   ├── admin/              管理后台
│   └── api/                API 端点（RESTful）
├── src/lib/                业务逻辑层（纯函数 + 显式参数）
├── src/middleware.ts       CSRF 同源校验
├── prisma/
│   ├── schema.prisma       22 表 1:1 映射真实库
│   └── migrations/         含 0_init 基线（已应用到 db.db）
├── scripts/                自检 / 运维 / 迁移 / 补偿 / 切换
├── tests/                  vitest 单测 + Playwright e2e
├── docs/                   玩家面向的内容/玩法文档
├── public/                 静态资源（图标 / CSS / favicon）
└── instance/               gitignored: avatars/ database/ images/ stories/
```

## 关键约定

### 数据与时间
- 数据库走 SQLite 单进程；高并发写长期建议迁 Postgres。
- 时间戳 **INTEGER 毫秒**（schema.prisma 与 Prisma 默认对齐）。规整是单向门，旧 Flask 的 `YYYY-MM-DD HH:MM:SS` 文本格式 Prisma 解析即抛 500。
- **时间戳语义是「UTC+8 墙上时间贴 Z 标签」**（Flask datetime.now() 的历史遗留）。取当前时刻一律用 `nowForDb()`（src/lib/db-time.ts）；「还剩多久」用 `hoursUntil()`；展示一律 `ymd`/`ymdhms`（src/lib/format.ts）或 `getUTC*`。**禁止无参 `new Date()`、`new Date(Date.now(...))`、与 `Date.now()` 相减、`toLocale*`、本地 getter（`getHours` 等）** —— tests/unit/db-time-guard.test.ts 五条静态守卫强制（服务端范围：src/lib、src/app/api、middleware、tests/helpers；展示层范围：整个 src/）。
- 密码哈希与历史 werkzeug **双向互通**——用户**无需重设密码**。
- 鱼干密钥派生：`SECRET_KEY` 是派生源；`FISH_ENCRYPTION_KEY` 仅全新部署时填。
- **鱼干存储单位 = 0.1 鱼干（整数）**（Float 时代已整数化，迁移 `3_fish_integer_units` 数据 ×10）。换算只在数据库边界：`src/lib/fish-units.ts` 的 `fishToUnits/unitsToFish`；业务层（服务入参/返回、DTO、前端）一律「鱼干」，最多 1 位小数。`fishToUnits` 拒绝超精度值（fail-loud）。SQLite 列保持 REAL 亲和但值全为整数（`prisma db pull` 会显示 Float，以 schema 注释为准）。`Blog.fishCount` 例外——它本来就是鱼干整数口径，无需换算。

### 认证与角色
- 角色：`user` → `core` → `admin` → `owner`
- `core+` 通过邀请码升级，注册时填邀请码即升。
- 会话 cookie：`HttpOnly`，`Secure` 由 `X-Forwarded-Proto` 自动判定（不走 nginx 时显式设 `COOKIE_SECURE`）。
- 站长的「针对自己的申诉」不由自己裁决——`/api/admin/appeals/[id]/decide` 需要目标用户 ≠ 当前用户。
- **OAuth 2.0 Authorization Code**（RFC 6749 §4.1）：raricy 作为 IdP，让外部应用读取用户 `id / username / avatar`；scope 仅 `profile`；access_token TTL 90 天；应用由 owner 经 `npm run cli -- oauth create-app` 或 `/admin/oauth` 注册；详见 `docs/oauth.md`。

### CSRF / 中间件
- `src/middleware.ts` 仅校验写请求（POST / PUT / PATCH / DELETE）的 `Origin` / `Referer` 同源。
- 对外 Host 判定顺序：`ALLOWED_ORIGINS` → `X-Forwarded-Host` → `Host`。
- 走 nginx 时务必 `proxy_set_header X-Forwarded-Host $http_host`，否则全站 POST 403。

### 数据库迁移
- **不用 `prisma migrate`**（schema.prisma 头禁了）—— 走 `npm run migrate`（脚本：`scripts/migrate.mjs`）。
- 跟踪表：自己维护 `_raricy_migrations`；新迁移用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 保持幂等。**含数据变换的迁移（如 ×10 整数化）只允许执行一次，由跟踪表保证，绝不手工重跑。**
- 从 Flask 切过来的库：先 `npm run migrate -- mark 0_init`，再 `up`；新库直接 `up`。
- 命令：`status` / `up` / `mark <name>` / `verify`。详见 `docs/deploy.md`「修改 schema 后」节。

### 鱼干写路径
- 四条写路径（投喂 / 签到 / CLI grant|deduct / 注册建号）全部 **fail-closed**：
  远端账户服务失败 → 本地写入被**补偿事务精确撤销**（对用户等价于回滚）→ 503。
  绝不静默成功。这是设计如此，不要改。
- 机制（`src/lib/fish-sync.ts` + `account_sync_ledger` 表）：远端 HTTP **不在 SQLite
  事务内**（旧版把 HTTP 放事务里，写锁被占最长 5s，并发写直接 database is locked）。
  流程：本地事务先提交（含账本 pending 行）→ 事务外调远端（幂等键不变）→ 成功标
  synced；失败走补偿事务；补偿也失败标 failed 并打 `ACCOUNT_RECONCILE_REQUIRED`
  日志。进程在「已提交/未同步」之间崩溃 → 账本留 pending →
  `npm run cli -- fish sync-retry` 幂等重放收敛。payload 里**严禁存密钥**（重放时
  按 userId 重新解密）。
- 不配 `ACCOUNT_SERVICE_INTERNAL_TOKEN` 时，生产环境所有鱼干写路径直接 503
  （不做任何本地写入）。dev 环境走 fallback 仅写本地。

### 软删除
- 永不物理删除（站长手动例外）：`Blog.ignore`、`BlogComment.is_deleted`、`ImageHosting.ignore`、`Vote.ignore`、`ClipBoard.ignore`。
- `is_deleted=true` 且无子评论 → 自动从楼中楼里隐藏。

### 限频
- 内存限频 `src/lib/rate-limit.ts`，**桶随 10 分钟清扫落盘**（`instance/rate-limit-snapshot.json`，原子写；`RATE_LIMIT_SNAPSHOT_PATH` 可覆盖），重启回灌不丢窗口；测试环境不自动回灌（确定性）。
- 单进程语义；多实例部署需换 Redis（已知限制）。
- 进程内规则：点赞 100/h 500/d、评论 1200/d、投票 30/h、图床 75/h。

### 文件落盘
- 头像 `instance/avatars/<uuid>.png`，头像目录可由 `AVATARS_DIR` 覆盖。
- 图床 `instance/images/<id><ext>`，上传目录由 `IMAGE_UPLOAD_FOLDER` 覆盖。
- 故事 `instance/stories/<合集>/<故事>.md|.cattca`（frontmatter + 可嵌套合集），由 `STORIES_DIR` 覆盖。
- 上传时严格 MIME 嗅探 + 文件名净化（防 XSS / 路径穿越）。

### Markdown / 内容渲染
- 博客正文 / 评论 / 故事：客户端 marked + DOMPurify + highlight.js。
- 聊天正文：`src/lib/chat-markdown.ts`（marked + DOMPurify）。白名单比博客更紧：原始 HTML
  转义为可见文本、无 img/class/style/on\*、图片降级为链接、裸 URL 走 linkify（中文句读友好）。
  改这里的白名单等于改安全边界，务必同步 `tests/unit/chat-markdown.test.ts`。
- 剪贴板引用：`[@<8位>]`（剪贴板）/ `[@<9位>]`（投票）/ `[@<10位>]`（图床）—— 浏览器渲染时替换。

### 版本控制
- 每次写完或改完一个功能 / 修复 / 文档后立即 `git commit`，不要积攒等用户来问。
- 一个 commit 只做一件事；不同语义（feat / fix / chore / docs / refactor）的改动必须拆开。
- 提交后默认不 push，等用户明确说 push 再推。
- **commit message 不加 `Co-Authored-By: Claude ...`**，也不要任何 Claude / Anthropic 署名 —— 只署仓库作者本人。

## 迁移史速查

| 阶段 | 说明 |
|------|------|
| 旧 Flask 单体 | 已被 git rm 删除（见 `feat/nextjs-migration` 历史 commit） |
| 0_init 基线 | `prisma/migrations/0_init/migration.sql` 由原 db.db 反向生成 |
| Flask 删档 commit | 已合并到本分支；旧 `migrations/`（Alembic）已删除 |
| 账户微服务 | 独立 FastAPI 仓库，本仓通过 `AccountClient` HTTP 调用 |
| 1_oauth | OAuth 2.0 IdP（应用/授权码/access token 三表） |
| 2_account_sync_ledger | 鱼干写路径账本化：HTTP 移出 SQLite 事务（见「鱼干写路径」） |
| 3_fish_integer_units | 鱼干 Float → 整数（×10，0.1 鱼干 = 1 单位，只可执行一次） |
| 4_chat | 在线聊天区：`chat_channels`（大区固定 id='lobby' 种子 + direct 私聊）/ `chat_members`（`last_read_message_id` 读游标）/ `chat_messages`（自增 id 作增量游标，软删除）。见 `docs/` 与 `src/lib/chat-service.ts` |

## 文档

| 文档 | 用途 |
|------|------|
| `README.md` | 快速开始 / 目录 / 部署 |
| `docs/atamas-game.md` 等 | 玩法/内容文档（atamas / cattca / 云剪贴板 / story / 内容引用语法） |
