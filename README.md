# 聪明山 · raricy.com

个人网站（博客 / 故事 / 工具集 / 剪贴板 / 图床 / 投票 / 游戏）。

Next.js 15 + Prisma + SQLite 单进程部署，自有 `instance/` 数据目录。

> 上一轮架构是 Flask 单体，2026-07 切到当前 Next.js 实现并已运行。
> 迁移手册详见 git 历史与切换期提交的 commit message。

## 技术栈

- **框架**：Next.js 15 App Router + React 19 + TypeScript
- **ORM**：Prisma 6，SQLite，`file:../instance/database/db.db`
- **会话**：JWT（`jose`）+ `session_version` 失效机制
- **认证**：密码哈希与历史 werkzeug **互通**，用户**无需重置密码**
- **服务边界**：站点单进程；账户微服务（FastAPI）独立仓库部署
- **前端**：服务端 / 客户端组件混用，marked + DOMPurify + highlight.js 渲染 Markdown

## 目录

| 目录 | 说明 |
|------|------|
| `src/app/`     | App Router 页面与 API 路由 |
| `src/lib/`     | 业务逻辑层 |
| `src/middleware.ts` | CSRF 同源校验（反代下读 `X-Forwarded-Host`） |
| `prisma/`      | schema.prisma、迁移、dev.db（gitignored） |
| `scripts/`     | 自检 / 运维 / 数据补偿脚本（详见下方"工具脚本"） |
| `tests/`       | vitest 单测 + Playwright e2e |
| `docs/`        | 玩家面向的内容/玩法文档 |
| `instance/`    | 运行时数据（gitignored）：avatars / database / images / stories |
| `public/`      | 静态资源（图标 / CSS / favicon） |

## 快速开始

```bash
node scripts/check-instance.mjs         # 首次创建 instance/{avatars,database,images,stories}
npm ci                                   # 严格按 lockfile 装（不要 npm install）
cp .env.example .env                     # 填 SECRET_KEY / FISH_ENCRYPTION_KEY
npm run prisma:generate                  # 生成 Prisma Client
npm run dev                              # http://localhost:3000
```

## 工具脚本

| 命令 | 作用 |
|------|------|
| `npm run dev` / `start` | 本地开发 / 生产启动 |
| `npm run build` | 生产构建 |
| `npm test` | vitest 单测 |
| `npm run e2e` | 端到端（先 build 再跑 Playwright） |
| `npm run smoke` | 11 条只读冒烟（登录态/列表/详情/签到/图床/CSRF 等） |
| `npm run diagnose` | 部署自检（版本 / .env / 库 / 密钥）；报红就别往下走 |
| `npm run check:secrets` | 密钥与生产数据是否进过版本库 |
| `npm run check:links` | 站内断链静态扫描 |
| `npm run check:perms` | 权限档位回归（与历史 Flask 对照） |
| `npm run prisma:pull` | 把库反向同步到 schema.prisma（手改 SQL 后用） |
| `npm run db:normalize` | 源库复制 + 规整时间戳为 INTEGER 毫秒 |
| `npm run db:compensate-fortunes` | 补偿"已签到未翻牌"的鱼干记录 |
| `npm run cli` | 运维 CLI：升降级 / 发鱼干 / 扣鱼干（fail-closed） |
| `npm run verify:account` | 端到端对账账户微服务 |
| `npm run prepare:cutover` | 切换期一次性：备份 → 规整 → 补偿 → diagnose |
| `npm run instance:check` | 创建 instance/ 子目录 |

## 部署 / 运行

- 站内反代：`proxy_pass http://127.0.0.1:3000`，**务必**透传 `Host: $http_host` / `X-Forwarded-Host` / `X-Forwarded-Proto`。
- `instance/` 需在部署机器上是**真实目录**：头像、图床、故事落盘。
- 数据库以 Prisma 0_init 为基线；改 schema 跑 `prisma migrate dev --name ...`。

## 关键约定

- 软删除：`Blog.ignore` / `BlogComment.is_deleted` / `ImageHosting.ignore` 等永不物理删除（站长手动例外）。
- 鱼干密钥派生：`SECRET_KEY` 仍是派生源；`FISH_ENCRYPTION_KEY` 仅在全新部署时填。
- 限频：站内用 `src/lib/rate-limit.ts`（内存，进程级）；多实例部署需换 Redis。
- 角色：`user` → `core` → `admin` → `owner`；`@authenticated_required` 意为 core+。

## 内容/玩法文档

`docs/atamas-game.md` `docs/cattca-guide.md` `docs/cattca-syntax.md`
`docs/云剪贴板使用指南.md` `docs/内容引用语法指南.md` `docs/story-module.md`
