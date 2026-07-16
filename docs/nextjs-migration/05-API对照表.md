# API 对照表

响应格式保持不变：`{ code, message, ...data }`（对齐 Flask 约定）。

## 已实现（web-next）—— 均已 `next build` 通过 + curl 冒烟

| 方法 | 路径 | 权限 | 状态 |
|---|---|---|---|
| POST | `/api/auth/login` `/register` `/logout`，GET `/api/auth/me` | 公开 | ✅ 实测（含注册→登录→Flask 复验）|
| GET | `/api/blogs`，`/api/blogs/:id` | 公开 | ✅ 实测（分页/分类/精选/搜索）|
| POST | `/api/blogs/:id/like` | 登录 | ✅ 实测（事务+限频+401）|
| GET/POST | `/api/blogs/:id/comments`，DELETE `/api/comments/:id`，POST `/api/comments/:id/like` | 混合 | ✅ 实测（楼中楼+软删除叶子过滤）|
| GET/POST | `/api/votes`，GET `/api/votes/:id`，POST `/api/votes/:id/vote` | 混合 | ✅ 实测（每人一票，重复投 400）|
| GET/POST | `/api/checkin`，GET `/api/fish/balance` `/api/fish/leaderboard` | 混合 | ✅ 实测（签到发鱼+排行榜）|
| GET/POST | `/api/notifications`，POST `/:id/read` `/read-all` | 登录 | ✅ 实测 |
| GET/POST | `/api/clipboard`，GET `/api/clipboard/:id` | 混合 | ✅ 实测（私有 403/软删 404）|
| GET | `/api/audit`，POST `/api/audit/:id/appeal` | 混合 | ✅ 实测（JSON 列 CAST 修复）|
| GET/POST | `/api/photowall`，PATCH `/:id`；GET `/api/images`，POST（501 stub）| 混合 | ✅ 建出（上传待接 sharp）|
| GET | `/api/users/:id`（公开资料，无 email），GET/PATCH `/api/users/me` | 混合 | ✅ 实测 |
| GET | `/api/avatar/:id`（SVG identicon）| 公开 | ✅ 实测 |

页面（Server / Client Components）：`/` `/blog` `/blog/:id` `/login` `/register` `/settings`
`/u/:id` `/vote` `/vote/:id` `/vote/create` `/checkin` `/notifications` `/clipboard` `/clipboard/:id`
`/photowall` `/image` `/audit` `/story` `/tool` `/tool/base` `/tool/hex`，以及 `/sitemap.xml` `/robots.txt`。

## 待迁移（按现有蓝图）

| Flask 蓝图 | 关键端点 | 迁移要点 |
|---|---|---|
| `blog`（其余）| 评论 CRUD、点赞者列表、投喂、上传/编辑/删除、爬虫 API、管理后台 | 评论楼中楼 `parent_id/root_id`；软删除叶子过滤；发文日限额（DB 计数）|
| `auth` | 注册、资料、用户管理、头像、邀请码、禁言 | Turnstile；头像生成（identicon）；`session_version` 递增触发下线 |
| `notifications` | 列表、已读、批量、管理员群发 | 发送前查用户通知偏好（除非 force）|
| `tool` / `story` / `game` | 工具页、故事（服务端 Markdown）、游戏 | 故事用 `remark`；游戏含 `game_api` |
| `clipboard` | 短 ID 读写、公开/私有 | 总数 ≤200 的 DB 限额 |
| `image` | 上传、压缩、配额、软删除、SVG 防护 | 用 `sharp` 压缩；SVG 以 attachment 下发；配额校验 |
| `photowall` | 放置/更新（坐标）| 放置 30/时、更新 300/时 限频 |
| `vote` | 创建、投票、锁定 | 每人一票唯一约束；创建/投票限频 |
| `checkin` | 每日签到 + 运势 | UTC+8 硬编码；`(user_id, date)` 唯一约束 |
| `audit` | 操作日志公示、申诉 | `extra` JSON 字段用 String + parse |
| `sitemap` / `home` | robots、sitemap、联系页 | Next 的 `sitemap.ts` / `robots.ts` |
| 账户微服务对接 | 余额、投喂、签到发鱼、排行榜 | TS 版 `AccountClient`（fetch）+ Fernet 解密 + fail-closed 写路径 |

## 迁移一个模块的推荐节奏（以 blog 为范式）

1. `src/lib/<模块>-service.ts`：纯函数业务逻辑（读写走 `prisma`，限频走 `rate-limit`）。
2. `src/app/api/<模块>/**/route.ts`：薄路由，判权 + 调 service + 返回 `{code,message}`。
3. `src/app/<模块>/**/page.tsx`：Server Component 直接 `await` service 渲染。
4. 需要交互的（点赞、评论框、投票）：抽 `'use client'` 组件，`fetch` 调上面的 API。

> 一致性要点：所有写路径沿用现有软删除/唯一约束/限额；账户相关写路径必须保持 **fail-closed**
> （远端同步成功才 commit 本地），见 CLAUDE.md 的 Phase 1.5 说明。
