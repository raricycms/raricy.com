# 05 · API 对照表

Next 侧现有 **61 个 API 路由**，Flask 的全部生产端点都已覆盖。下面是全量清单与
两处必须知道的契约差异。

> 本文档曾长期停留在地基阶段（把所有模块列成「待迁移」、称图床上传是「501 stub」），
> 与实际严重不符。此版按 `src/app/api/**/route.ts` 的真实内容重写。

---

## 1. 两处契约差异（对外调用者必读）

### 1.1 响应体 snake_case，请求体 camelCase

**响应**保持 Flask 约定不变：`{ code, message, ...data }`，字段名沿用
snake_case（`fortune_value`、`already_checked`、`likes_count`…）。

**请求体**则改成了 TS 惯例的 camelCase。已知的改名：

| Flask 请求字段 | Next 请求字段 | 端点 |
|---|---|---|
| `chosen_index` | `chosenIndex` | `POST /api/checkin` |
| `option_id` | `optionId` | `POST /api/votes/:id/vote` |
| `is_active` | `isActive` | `POST/PATCH /api/admin/categories` |
| `exclude_from_all` | `excludeFromAll` | 同上 |
| `admin_only_posting` | `adminOnlyPosting` | 同上 |
| `notify_admin_on_post` | `notifyAdminOnPost` | 同上 |
| `object_type` / `object_id` | `objectType` / `objectId` | `POST /api/admin/users/:id` |
| `log_id` | 挪进 URL 路径 | `POST /api/audit/:id/appeal` |

**保持 snake_case 不变的请求字段**（别顺手改）：
`invite_code`（注册）、`current_password` / `new_password` / `confirm_password`（改密码）。

浏览器端不受影响（前后端同仓库、同时改）。**受影响的是任何直接打 API 的外部脚本**
—— 若有书签脚本/自动化在用 Flask 的字段名，切换后会静默失效（字段读不到 → 走默认值，
不会报错）。

### 1.2 `/auth` 前缀已去掉

Flask 的 `/auth/login` → Next 的 `/login`（页面）与 `/api/auth/login`（接口）。
其余同理：`/auth/profile/<id>` → `/u/:id`，`/auth/user_management` → `/admin/users`。

---

## 2. 全量端点

### 认证

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/api/auth/login` `/logout` `/register` | 公开 |
| GET | `/api/auth/me` | 登录 |
| POST | `/api/auth/authentic` | 登录（邀请码升 core）|
| POST | `/api/auth/change-password` | 登录（成功后递增 session_version 踢下线）|

### 博客

| 方法 | 路径 | 权限 |
|---|---|---|
| GET/POST | `/api/blogs` | 混合（POST 需 core，日限额 20）|
| GET/PUT | `/api/blogs/:id` | 混合 |
| POST | `/api/blogs/:id/like` | 登录（限频 100/时、500/天）|
| GET | `/api/blogs/:id/likers` | **作者本人或管理员** |
| POST | `/api/blogs/:id/feed` | 登录（fail-closed，远端故障 503）|
| GET | `/api/blogs/:id/feeders` | **作者本人或管理员** |
| GET/POST | `/api/blogs/:id/comments` | 混合 |
| DELETE | `/api/comments/:id` | 作者/管理员 |
| POST | `/api/comments/:id/like` | 登录 |

### 小鱼干 / 签到

| 方法 | 路径 | 权限 |
|---|---|---|
| GET/POST | `/api/checkin` | 登录（fail-closed）|
| GET | `/api/fish/balance` `/api/fish/balance/:id` | 混合 |
| POST | `/api/fish/balance/batch` | 登录 |
| GET | `/api/fish/leaderboard` `/api/fish/transactions` | 混合 |

### 管理端

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/admin/blogs`，PATCH `/api/admin/blogs/:id` | 管理员 |
| GET/POST | `/api/admin/categories`，PATCH/DELETE `/:id` | 管理员 |
| GET | `/api/admin/users`，PATCH/POST `/api/admin/users/:id` | 混合 |
| POST | `/api/admin/notify-user` | 管理员 |
| POST | `/api/admin/broadcast` | 站长 |
| GET | `/api/admin/appeals`，POST `/:id` | 管理员 |

### 审计 / 申诉

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/audit` | core |
| POST | `/api/audit/:id/appeal` | 登录（20/天；同人同日志一条 pending）|

### 其余

| 方法 | 路径 | 权限 |
|---|---|---|
| GET/POST | `/api/votes`，GET `/:id`，POST `/:id/vote` | 混合 |
| GET/POST | `/api/notifications`（+ read / read-all / batch-* / count / delete-*）| 登录 |
| GET/POST | `/api/clipboard`，GET/PUT `/:id` | 混合（总数 ≤200）|
| GET/POST | `/api/images`（sharp 压缩 + 角色配额 + 75/时）| 混合 |
| GET | `/api/images/:id/raw`，DELETE `/:id` `/admin/:id`，GET `/quota` | 混合 |
| GET/POST | `/api/photowall`，PATCH `/:id` | 混合 |
| GET | `/api/users/:id`（无 email）`/api/users/:id/ban-history`，GET/PATCH `/api/users/me` | 混合 |
| GET | `/api/avatar/:id`（identicon）| 公开 |
| GET | `/api/spider/blogs/:id` `/api/spider/comments` `/api/spider/comments/:id` | **公开无认证**（供搜索引擎，与 Flask 一致）|
| POST | `/api/game/game_token` | 登录 |

---

## 3. 页面

62 个页面。除 Flask 的全部生产页面外，Next 侧新增了 `/admin/*` 管理区与
`/audit/:id` 详情页。

**不迁的两个**：`/deepcaptcha` 与 `/markdown_upload` —— 它们在 Flask 里位于
`if app.config.get('DEBUG')` 分支内，生产环境根本不注册。

---

## 4. 保持一致的约定

- 响应统一 `{ code, message, ...data }`
- 软删除、唯一约束、各类限额一律沿用（见 [全站限额与频控汇总](../全站限额与频控汇总.md)）
- 账户相关写路径**必须 fail-closed**：远端同步成功才 commit 本地（CLAUDE.md Phase 1.5）
- spider API 有意不加认证（搜索引擎要抓）

## 5. 新增模块的节奏（以 blog 为范式）

1. `src/lib/<模块>-service.ts` —— 纯函数业务逻辑（prisma + rate-limit）
2. `src/app/api/<模块>/**/route.ts` —— 薄路由：判权 → 调 service → 返回 `{code,message}`
3. `src/app/<模块>/**/page.tsx` —— Server Component 直接 `await` service
4. 需要交互的抽 `'use client'` 组件，`fetch` 调上面的 API

写完跑 `npm run check:links` —— 它会查 fetch 的地址是否真有对应路由。
这类错 tsc 和单测都发现不了（已因此漏掉过三处）。
