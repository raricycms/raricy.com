# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 项目概述

raricy.com（聪明山）—— 个人博客 / 故事 / 工具集 / 剪贴板 / 图床 / 投票 / 游戏。

- **Next.js 15** App Router + React 19 + TypeScript
- **Prisma 6** 直连 SQLite（`file:../instance/database/db.db`）
- **JWT** 会话 + `session_version` 失效机制（对齐旧 Flask-Login）
- **FastAPI 账户微服务** 独立仓库部署，本仓通过 HTTP 调用
- **npx prisma migrate** 是迁移正典；老 Alembic 历史已基线化为 `prisma/migrations/0_init/`

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
- 密码哈希与历史 werkzeug **双向互通**——用户**无需重设密码**。
- 鱼干密钥派生：`SECRET_KEY` 是派生源；`FISH_ENCRYPTION_KEY` 仅全新部署时填。

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
- 跟踪表：自己维护 `_raricy_migrations`；新迁移用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 保持幂等。
- 从 Flask 切过来的库：先 `npm run migrate -- mark 0_init`，再 `up`；新库直接 `up`。
- 命令：`status` / `up` / `mark <name>` / `verify`。详见 `docs/deploy.md`「修改 schema 后」节。

### 鱼干写路径
- 三条写路径（投喂 / 签到 / CLI grant|deduct）全部 **fail-closed**：
  远端账户服务失败 → 本地事务回滚 → 503。这是设计如此，不要改。
- 不配 `ACCOUNT_SERVICE_INTERNAL_TOKEN` 时，生产环境所有鱼干写路径直接 503。

### 软删除
- 永不物理删除（站长手动例外）：`Blog.ignore`、`BlogComment.is_deleted`、`ImageHosting.ignore`、`Vote.ignore`、`ClipBoard.ignore`、`PhotoWallItem.ignore`。
- `is_deleted=true` 且无子评论 → 自动从楼中楼里隐藏。

### 限频
- 内存限频 `src/lib/rate-limit.ts`（进程级，重启丢失）。
- 多实例部署需换 Redis（已知限制）。
- 进程内规则：点赞 100/h 500/d、评论 1200/d、投票 30/h、图床 75/h、照片墙 30/h 300/d。

### 文件落盘
- 头像 `instance/avatars/<uuid>.png`，头像目录可由 `AVATARS_DIR` 覆盖。
- 图床 `instance/images/<id><ext>`，上传目录由 `IMAGE_UPLOAD_FOLDER` 覆盖。
- 故事 `instance/stories/<合集>/<故事>.md|.cattca`（frontmatter + 可嵌套合集），由 `STORIES_DIR` 覆盖。
- 上传时严格 MIME 嗅探 + 文件名净化（防 XSS / 路径穿越）。

### Markdown / 内容渲染
- 博客正文 / 评论 / 故事：客户端 marked + DOMPurify + highlight.js。
- 剪贴板引用：`[@<8位>]`（剪贴板）/ `[@<9位>]`（投票）/ `[@<10位>]`（图床）—— 浏览器渲染时替换。

## 迁移史速查

| 阶段 | 说明 |
|------|------|
| 旧 Flask 单体 | 已被 git rm 删除（见 `feat/nextjs-migration` 历史 commit） |
| 0_init 基线 | `prisma/migrations/0_init/migration.sql` 由原 db.db 反向生成 |
| Flask 删档 commit | 已合并到本分支；旧 `migrations/`（Alembic）已删除 |
| 账户微服务 | 独立 FastAPI 仓库，本仓通过 `AccountClient` HTTP 调用 |

## 文档

| 文档 | 用途 |
|------|------|
| `README.md` | 快速开始 / 目录 / 部署 |
| `docs/atamas-game.md` 等 | 玩法/内容文档（atamas / cattca / 云剪贴板 / story / 内容引用语法） |
