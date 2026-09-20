# 项目架构

聪明山 / raricy.com 的当前架构：Next.js 15 单进程 + Prisma 6 + SQLite + 独立 FastAPI 账户微服务。

> 上一版是 Flask 单体，2026-07 全部替换。本文档只描述现役架构；Flask 历史仅在「迁移史速查」一节列出。

## 1. 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Next.js 15（App Router）· React 19 · TypeScript 5 |
| ORM | Prisma 6（provider=sqlite），直连 `instance/database/db.db` |
| 鉴权 | JWT（`jose`）· 密码哈希与历史 werkzeug **双向互通**（用户无需改密） |
| 会话 | JWT cookie + `User.sessionVersion` 失效机制（改密 / 禁言 / 强制下线时递增，旧会话立即全废） |
| CSRF | `src/middleware.ts` 对状态变更方法校验 `Origin`/`Referer` 同源 |
| 文件落盘 | 头像/图床/故事/表情包落 `instance/`（gitignored，六个子目录见 §3） |
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
                     │ ├── stories/     │
                     │ ├── stickers/    │
                     │ └── blogs/       │   ⟨历史遗留，当前无写入⟩
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
└── instance/               gitignored: avatars/ database/ images/ stories/ stickers/ blogs/
```

## 4. 路由分布（src/app/）

| 路径 | 类型 | 说明 |
|------|------|------|
| `/` | page | 导航首页（不列文章） |
| `/login` · `/register` | page | 认证（登出是 `POST /api/auth/logout`，**没有** GET 路由） |
| `/blog` · `/blog/upload` · `/blog/[id]/edit` | page | 博客列表与编辑 —— **一律 core+** |
| `/blog/[id]` | page | 文章详情。**按身份两种视图**：core+ 看成员视图（正文 + 互动 + 评论），访客看纯阅读视图。文章 `visibility` 为 link / public 时访客可读，internal 时访客落到登录页（见 §6.11） |
| `/explore` | page | **对外公开列表**（`public` 档，与 sitemap 同一个集合）。全站**唯一**不需要登录的浏览面，访客与非 core 的「博客」入口指向它（见 §6.12） |
| `/api/blogs` · `/api/blogs/[id]` · `/api/categories` · `/api/spider/*` | API | 博客 API + 栏目清单 + 爬虫 API。**全部 core+**，与 `/blog` 页面同档（读口含正文搜索那条重活，见 §6.5）。`/api/categories` 是给发文方查 `category_id` 的读口（此前只有 `/api/admin/categories`，机器人无从枚举）；发文对外契约见 `docs/bot/blog-bot.md` |
| `/api/og/blog/[id]` | API | **分享卡片 PNG**（OG 图）。无会话档位，逐篇判可见性：只对外可见的文章返回 200，其余与「不存在」同形 404。缓存与 `X-Robots-Tag` 按档位发（见 §6.11） |
| `/api/auth/authentic` · `/zhh` | API + route | 邀请码升 core · 邀请码生成（站长） |
| `/fish` · `/fish/transactions` · `/api/fish/*` | page + API | 小鱼干面板 + 流水 |
| `/fish/market` · `/api/fish/market/*` | page + API | 鱼干市场（第一期只有**用户间转账**，无手续费）：`POST transfer`（支持客户端幂等键）/ `GET users`（收款人搜索）/ `POST balance`、`POST transactions`（站外脚本用的无状态查询，含 `since_id` 对账游标）/ `POST pay`（收银台专用）。写路径见 §6.3；对外契约见 `docs/bot/fish-bot.md` |
| `/fish/pay` | page | **收银台**：站外商户把用户送来付款（`?to= &amount= &note= &from= &return=`）。参数一律不可信，只做展示；付款必须**已登录 + 再输一次密码**（step-up），密码只输在本站域名下。不入索引 |
| `/fish/collect` | page | **扫码收款页**：`?to=<用户名>`，扫「鱼干收款码」落到这里。与收银台的区别是**金额由付款人自己填**（静态码不可能带金额）。前端是 `/fish/pay` 的**同一个组件**（`src/app/fish/PayForm.tsx`）的另一个变体，step-up 与幂等键完全共用 |
| `/fish/api` · `/api/fish/tokens/*` | page + API | **机器人接入自助页**：签发 / 吊销只读凭据（`GET`/`POST /api/fish/tokens`、`DELETE /api/fish/tokens/[id]`）。**只认会话**、签发要 step-up、只能动自己的。只读凭据的鉴权门在 `src/app/api/fish/market/_auth.ts`（第三道门，`allowReadToken` 默认关）；签发/校验/吊销在 `src/lib/fish-token-service.ts` |
| `/api/poster/profile/[id]` · `/api/poster/collect` | API | **画报 / 收款码出图**（PNG，仅本人）。渲染管线与四条约束见 §6.8 |
| `/notifications` · `/api/notifications/*` | page + API | 通知中心。其中 `GET count` 是顶栏指示器的**兜底快照**（**不能删**：SSE 有「连着但收不到」的半死状态），`GET stream` 是**实时流**（SSE，未登录 401；首帧全量快照 + 之后增量补丁）。推送点纪律与依赖方向见 `src/lib/topbar-bus.ts` 头部 |
| `/vote` · `/vote/[id]` | page | 投票 |
| `/checkin` · `/api/checkin` · `/api/checkin/claim` | page + API | 每日签到（**core+**：鱼干的赚取渠道，与投喂/点赞同档）。**三处都要判** —— 发鱼的其实是 `claim`，见 §8 |
| `/clipboard` · `/clipboard/[id]` · `/api/clipboard/*` | page + API | 云剪贴板 |
| `/image` · `/image/admin` · `/api/images/*` | page + API | 图床 + 管理 |
| `/image/i/<id>` · `/auth/avatar/<id>` | rewrite | **不是路由**：历史版本的旧直链，由 `next.config.mjs` 的 `rewrites()` 映射到 `/api/images/<id>/raw`、`/api/avatar/<id>`。存量正文里写死的就是它们（见 `tests/e2e/legacy-urls.spec.ts`） |
| `/story` · `/story/[...path]` | page | 故事合集/阅读 |
| `/tool` · `/tool/<sub>` | page | 工具集（aes / base / hash / hex / html / qp / translate / url / cattca） |
| `/admin/*` · `/api/admin/*` | page + API | 管理后台（档位分页而异，见 §8） |
| `/audit` · `/audit/[id]` | page | 审计日志公示 + 申诉。页面（母版 `src/app/audit/layout.tsx`）、`GET /api/audit` 与提交申诉**同为 core+** —— 「公示」的口径是**公示给站内成员**，不是对外透明 |
| `/contact` · `/privacy` · `/terms` | page | 联系 / 隐私 / 条款 |
| （无 URL）`forbidden.tsx` | 特殊文件 | 403 页本身；由 `forbidden()` 原地渲染，**不是** `/forbidden` 路由 |
| `/sitemap.xml` · `/robots.txt` | route | sitemap.ts / robots.ts |
| `/api/avatar/[id]` · `/api/images/[id]/raw` | API | 头像 / 图床原生分发 |
| `/u/[id]` | page | 公开用户主页（**段名是用户 id（UUID），不是 username**）。**匿名可达**（主页画报的二维码把站外人引到这里），故内容按查看者分档：身份字段人人可见，role 徽章 / 最近文章 / 最近评论 / 计数 / 最后登录只给本人或 core+ —— 收口在 `user-service.getPublicProfile` 与页面里，两边口径必须一致 |

## 5. 业务逻辑层（src/lib/）

按子域分组（每组均与路由 1:1 或 1:多对应）：

| 分组 | 文件 |
|------|------|
| 认证 / 会话 | `auth.ts` · `session.ts` · `password.ts` · `invite-code.ts` · `user-service.ts` · `identicon.ts` · `avatar.ts`（头像字节的**唯一**解析处：`/api/avatar/[id]` 与画报共用同一份目录穿越守卫）· `site-url.ts`（`SITE_URL` → `ALLOWED_ORIGINS` 回退链的唯一实现，OAuth 的 userinfo 与画报的二维码前缀共用） |
| 数据层 | `db.ts` · `db-time.ts` · `format.ts` |
| 博客域 | `blog-service.ts` · `feed-service.ts` · `comment-service.ts` · `comment-shared.ts` · `blog-sort-pref.ts` · `spider-service.ts` |
| 富文本渲染 | `rich-text.ts`（共享管线）· `chat-markdown.ts` · `comment-markdown.ts` · `blog-markdown.ts` · `content-refs.ts`（评论/讨论那条**同步**管线：只认 8 位与 10 位，9 位投票与 6 位收藏夹刻意不展开）· `favorite-refs.ts`（`[@六位]` 卡片：**只在博客/剪贴板**那条管线生效，见 §6.9）· `markdown-math.ts` · `linkify.ts` · `vditor-theme.ts` |
| 表情包 | `sticker-refs.ts`（`[@合集/表情]` → 内联 `<img>`，跑在`rich-text.ts` 的净化**之后**）· `sticker-service.ts`（素材扫盘与三层缓存）。安全边界与正则纪律见两者头部；玩家向说明见 `docs/guide/表情包使用指南.md` |
| 讨论 | `chat-service.ts` · `chat-bus.ts`（SSE 订阅）/ `chat-shared.ts`（DTO）· `chat-presence.ts`（「谁正在看哪个会话」—— 进程内，决定被 @ 时发不发通知）· `chat-sidebar-pref.ts` · `focus-mode.ts` |
| 实时传输 | `sse.ts` —— SSE 响应头 / 帧格式 / 重连与背压 / 心跳常量的**唯一出处**，两条流共用（讨论 `chat-bus.ts`、顶栏 `topbar-bus.ts`）。新增 SSE 路由一律 import 它，不要手抄响应头（`no-transform` 少一个字的后果见该文件头注释） |
| 顶栏指示器 | `topbar-bus.ts` —— 铃铛未读数 + 讨论红点的 SSE 订阅表（推**增量补丁**，首帧全量快照由路由拼）。推送点纪律（`hasSubscriber` 同步早退、算值必须在吞异常的 try 内）与依赖方向约束**见该文件头部** |
| 通知 / 审计 | `notification-service.ts` · `broadcast-service.ts` · `audit-service.ts` · `admin-appeal-service.ts` |
| 投票 / 签到 / 剪贴板 | `vote-service.ts` · `checkin-service.ts` · `clipboard-service.ts` |
| 收藏夹 | `favorite-service.ts`（六条不变量见文件头）· `favorite-refs.ts`（`[@六位]` 的纯逻辑），见 §6.9 |
| 图床 | `image-service.ts` · `image-upload.ts`（服务端）· `image-client.ts`（浏览器侧选图上传，讨论与评论共用）· `vditor-upload.ts`（Vditor 编辑器的上传配置，博客与剪贴板共用；与 `/api/images` 的字段名/响应结构两端对齐，见 `tests/unit/vditor-upload.test.ts`） |
| 故事 | `story-service.ts` |
| 画报 / 收款码 | `poster.ts`（纯 SVG 构造，含二维码与转义）· `poster-render.ts`（取数 + 头像 + sharp 光栅化），见 §6.8 |
| 小鱼干 | `fish-service.ts` · `fish-admin.ts` · `fish-market-service.ts`（用户间转账，见 §6.3）· `fish-sync.ts`（账本 + 补偿，见 §6.3）· `fish-compensate.ts`（`fish compensate` 群发补偿，只发 core+，见 `docs/cli.md` 与文件头）· `fish-units.ts`（单位换算；`Blog.fishCount` 是**例外**，见文件头）· `account-client.ts` |
| OAuth 2.0 | `oauth.ts`（见 `docs/oauth.md`） |
| 管理域 | `admin-user-service.ts` · `admin-blog-service.ts` · `admin-category-service.ts` · `admin-comment-service.ts` · `admin-clipboard-service.ts` · `admin-vote-service.ts` · `admin-image-service.ts` · `admin-stats-service.ts` |
| 工具 / 安全 | `short-id.ts` · `safe-url.ts` · `guard.ts` · `rate-limit.ts` · `turnstile.ts` |
| 鉴权基建 | `credential-auth.ts`（「用户名+密码」校验，`/api/auth/login` 与鱼干市场无状态接口**共用**，限频桶也共用）· `request-ip.ts`（反代后取真实 IP） |
| 配额白名单 | `service-accounts.ts`（`FISH_SERVICE_ACCOUNTS` 里的账号走 `SERVICE_QUOTA`：转账 500/时、5000/天。给「站外银行」这类自动化账号用，撤销即删配置） |

> 上表是**穷尽** `src/lib/*.ts` 的（新增文件记得补一行）—— §6.3、§8 会引用其中若干。
> 这张表漏过两次（先是讨论子域与 `oauth.ts`，后是 `content-refs.ts` / `sticker-refs.ts` /
> `sticker-service.ts` / `fish-compensate.ts`），症状都是正文引用的文件在本表里查不到。
> 核对命令：`comm -13 <(本表提取的文件名) <(ls src/lib/*.ts | xargs -n1 basename)`。

API 端点位于 `src/app/api/<group>/<verb>/route.ts`，**薄**层：参数校验 + 权限校验 + 调 `src/lib/*` + 组装响应。

## 6. 关键子系统

### 6.1 认证与会话

- **密码哈希**：`src/lib/password.ts` 选 `scrypt` / `pbkdf2:sha256`，与历史 werkzeug **字节级互通**——从上一版实现接手的用户无需改密、完全不感知。
- **会话**：登录成功签发 JWT（`jose`，HS256），cookie 设 `HttpOnly` + `SameSite=Lax`。`Secure` 由 `X-Forwarded-Proto` 推断或 `COOKIE_SECURE` 显式控制。
- **踢下线**：`User.sessionVersion` 单调递增。`session.ts` 解析 JWT 后比对当前 `user.sessionVersion`，不一致则视为失效。
- **登出**：**只有** `POST /api/auth/logout`（`base.js` 的 `window.logout()` / `LogoutLink` 组件）。
  清会话是状态变更，**不能有 GET 入口** —— GET 会被本人以外的东西发起（浏览器预取视口内的
  `<Link>`、爬虫、第三方页面上的 `<img src="…/logout">`，而本站刻意允许被 iframe 嵌入），
  症状是用户莫名其妙掉线。曾经确实有一个 `GET /logout`，被 403 页的一个链接踩中过。
- **入口**：登录迁到 `core` 通过邀请码（注册时填，或注册后走 `/api/auth/authentic` 验证）。

### 6.2 数据层

- **Prisma schema**：`prisma/schema.prisma` 与真实库 1:1 映射。改 schema 时**手写** `prisma/migrations/<n>_<name>/migration.sql` 并同步 schema.prisma，然后 `npm run migrate -- up` 应用（见 docs/deploy.md「修改 schema 后」；生产库禁止 `prisma migrate dev` / `db push`）。
- **时间戳列**：INTEGER 毫秒（与 Prisma 默认 SQLite 写入格式对齐）。规整是**单向门** —— 历史格式的 `YYYY-MM-DD HH:MM:SS` 文本 Prisma 解析即抛 500。
- **时间戳语义**：存的是「**UTC+8 墙上时间贴 Z 标签**」，**不是真实 UTC 瞬间**（上一版实现 `datetime.now()` 留下的，normalize 只补 `T`/`Z` 不平移）。因此：取当前时刻一律用 `src/lib/db-time.ts` 的 `nowForDb()`（= `Date.now() + 8h`，与全库历史数据同钟）；「还剩多久」用 `hoursUntil()`；展示用 `ymd`/`ymdhms` 或 `getUTC*`。**禁止**无参 `new Date()`、`toLocale*`、本地 getter（`getHours` 等）。混用两把钟的后果**全是静默的**：禁言到期后多显示 8 小时、当日发文计数跨日错位。由 `tests/unit/db-time-guard.test.ts` 五条静态守卫强制。
- **Prisma 客户端**：单例在 `src/lib/db.ts`，开发模式 HMR 安全。

### 6.3 鱼干账户（跨进程）

- **失败语义 — 写路径 fail-closed**：投喂 / 签到 / 注册建账户 / CLI grant|deduct / 用户间转账（鱼干市场）/ 练手盘开平仓**全部**遵循：远端账户服务失败 → 本地写入被**补偿事务精确撤销**（对用户等价于回滚）→ 503 / 退出码 2。绝不静默成功。
  - 转账（`fish-market-service.ts`）是其中唯一**单次远端调用**的路径：没有 feed 的「Step1 成功 → Step2 失败 → 远端退款」中间态，别照抄那套退款；也是唯一带限频配额的鱼干写路径。补偿退接收者时若他已把钱花掉 → 补偿整体回滚，交由账本 `failed` + `sync-retry` 正向重放收敛（**绝不部分撤销**，那会凭空造出鱼干）。
  - 转账支持**客户端幂等键**（`opts.clientIdempotencyKey`）：键进账本，重发同键同参数 → 直接返回原结果（`duplicated: true`）、同键不同参数 → 409、上一笔在途 → 409。**去重依赖账本行**，所以 dev fallback（不登记账本）下不去重 —— 生产不会出现该状态（未配账户服务时直接 503）。
  - **共享单号 `fish_transactions.transfer_id`**：一笔转账的两条流水（发送方 `transfer` 负 / 接收方 `transfer_receive` 正）写**同一个**值，让收付双方能对上同一笔。值 = `sha256(幂等键)[:16]`（**派生**，不是随机）—— 于是同键重放无需额外状态就能回报原单的单号，也没有第二份会漂移的副本。**只覆盖用户间转账**：签到 / 投喂 / 赠送 / 补偿都没有对手方，一律 NULL；存量行不回填（无法可靠反推配对，猜错等于把两笔钱认成一笔）。它是对账句柄，不是凭证 —— 本仓**没有**「按单号查一笔转账」的接口，所以知道它并不能读到别人的账。见 `prisma/migrations/14_fish_transfer_id` 头部。
  - **练手盘（`market-service.ts`）**：开仓是「用户 → 系统账户」，平仓是反向，两个方向都用**系统 Key**（同 `admin_grant`/`admin_deduct`）—— 系统账户 `raricy-blog-system` 只在远端存在、本地没有 `users` 行，所以走不了转账那个 case（它要按 `fromUserId` 解密发送者的 Key）。**成交价必须在下单那一刻现取**（`fetchQuote`），绝不读展示缓存 —— 这条是它唯一的安全边界，展开见 §6.13。平仓**不需要幂等键**：整仓标记为 closed 之后，再平就是重放。开仓需要（同额分批建仓是正常操作）。
  - **收银台的 `order` 参数**（`/fish/pay`）：商户给的订单号参与拼幂等键（`makeOrderKeyBase` = 收款人哈希 + 订单号，**不含金额**），于是同一订单号永远算出同一个键 → 用户付完刷新页面再点不会重复扣款。键里混收款人是为了让「同一付款人给两家商户用同一个订单号」不撞车；不含金额是为了让「同单号换金额」响亮地 409，而不是静默变成第二笔。**不给 `order` 时退回随机键基**（扫码收款页恒如此，那里用户要能在同一页里改金额）。
  - **收款回调（webhook）**：`fish-webhook-service.ts` 是 outbox —— 投递行与两条流水**同事务**写入，投递在事务外（照搬本节的形状），补偿事务里**连带删掉**投递行（回滚掉的转账绝不能通知商户「你收到钱了」）。两个 driver：进程内定时器（`src/instrumentation.ts` → `webhook-drainer.ts`，**本站唯一的后台循环**）与 `fish webhook-retry`，靠条件 UPDATE 认领，不会双投。投递是 **at-least-once**（sending 租约到期会重投），所以接收方必须按 `X-Raricy-Delivery` 去重。SSRF 防线（本站唯一一处「服务器去 fetch 用户给的地址」）见 `src/lib/webhook-url.ts` 头部。端点连续失败**不自动停用** —— 那是静默失效。
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

`src/lib/rate-limit.ts`，进程内内存桶（单进程语义）。**配额表以该文件的 `RULES` 为唯一权威**，本文不复述具体数值（点赞 / 评论 / 投票 / 图床 / 讨论 / 登录…），复述必 drift。

> ⚠️ `RULES` **不是全部配额**。OAuth 的三条（authorize 30/min/user、token 60/min/clientId、
> userinfo 600/min/user）是各 route 里**内联的字面量**，去 `src/app/api/oauth/*/route.ts` 找，
> 不在 `RULES` 里 —— 见 `docs/oauth.md` §7。做全站限频审计时最容易漏掉它们。

另有三点不显然的行为：

- **桶会落盘**：随 10 分钟一次的惰性清扫写入 `instance/rate-limit-snapshot.json`（原子写；`RATE_LIMIT_SNAPSHOT_PATH` 可覆盖），进程启动时回灌 —— **重启不重置窗口**。不落盘的话，一次发版等于给所有人发免刷通行证，也放走进行中的刷量。测试环境不自动回灌，保证确定性。
- **登录限频只统计失败**：IP 与用户名（小写归一）两个维度分别计数，任一超限即 429。所以正常用户不会被自己的成功登录挡住；顺带它也是 CPU 保护（每次尝试都要跑一次 scrypt）。
- **规则值与计桶的键是两回事**：同一条 `RULES.*` 可以被多处复用，但各处用自己的键前缀，**配额互不相干**。已知的有：博客点赞用 `like:h:`/`like:d:`，评论点赞复用同样的 `likeHourly`/`likeDaily` 数值但键是 `comment-like:h:`/`comment-like:d:` —— 分成两个桶是刻意的，共用会让「给评论点赞」顶掉「给文章点赞」的额度。改 `RULES` 的数值会同时影响两边；只想调一边得另立规则。鱼干市场那三条同理且**必须分开**：`fish-api:`（密码，吃 CPU 闸门）/ `fish-api:ip:` / `fish-token:`（只读凭据，**不跑 scrypt 故不受那道闸门约束**）/ `fish-token:ip:` —— 混用会让便宜的凭据路径蹭掉昂贵的密码路径额度（或反之）。

**多实例部署时换 Redis**。本站单进程不踩该坑。

### 6.6 文件落盘

| 域 | 路径 | 上传入口 | 读取入口 |
|----|------|---------|---------|
| 头像 | `instance/avatars/<uuid>.png`（或 `AVATARS_DIR` 覆盖） | **无上传入口**：注册时 `avatarPath` 留空，头像由读取入口按 id 确定性生成；磁盘上的 `.png` 只有历史存量文件 | `src/app/api/avatar/[id]/route.ts`（有文件则回放，否则 `generateIdenticonSvg` 兜底，永不 404） |
| 图床 | `instance/images/<id><ext>`（或 `IMAGE_UPLOAD_FOLDER` 覆盖） | `src/lib/image-upload.ts` — sharp 压缩 + MIME 嗅探 + 配额累计 | `src/app/api/images/[id]/raw/route.ts` |
| 故事 | `instance/stories/<合集>/<故事>.md\|.cattca`（或 `STORIES_DIR` 覆盖） | 服务端直接落盘 | `src/lib/story-service.ts` 服务端 marked |
| 表情包 | `instance/stickers/<合集>/<表情>.{gif,webp,png,jpg,jpeg}`（或 `STICKERS_DIR` 覆盖） | **无上传入口**：站长直接往目录里拷文件 | `src/app/api/stickers/[collection]/[name]/route.ts`（查扫盘 manifest，见 `src/lib/sticker-service.ts`） |

磁盘目录必须**真实存在**（生产用 systemd/Data卷/挂载点），`node scripts/check-instance.mjs` 一键建好骨架。

表情包那一栏有三点与其余几栏不同，改代码前先看一眼：

- **它是唯一「没有上传入口」的存储域**（头像那个也无入口，但读取是 identicon 兜底）。
  素材由站长从外部拷进来，所以**目录里没有任何上游校验** —— 图床那条链路的
  `verifyImageMime` 在这里不存在。因此 raw 路由必须**按字节**复核类型并明确拒绝
  SVG（`detectImageMime` + `ALLOWED_STICKER_MIME`），否则丢一个 `<svg onload=…>`
  进来就是同源存储型 XSS。
- **查表模型**：`resolveSticker()` 拿 collection / name 只当 map 的 key，**永不拼路径**
  —— 与图床 raw 路由「先查库、再按库里的值拼路径」是同一种安全性来源。
  `info.json` 的 `ignore` 必须在这里也拦一道，不能只在列表接口过滤。
- **扫盘有缓存**（TTL 5s + 目录时间戳 + 60s 兜底全扫），与 `story-service.ts`
  的无缓存扫盘不同 —— 理由见 `sticker-service.ts` 的文件头。

### 6.7 Markdown / 内容渲染

| 场景 | 渲染方式 | 管线 |
|------|---------|------|
| 讨论正文 / 评论正文 | **客户端**渲染，同一套管线 | `rich-text.ts`（marked → DOMPurify → 后处理），白名单与链接类名见 `chat-markdown.ts` / `comment-markdown.ts` |
| 博客正文 | **客户端**渲染 | `src/app/components/MarkdownRenderer.tsx`（marked + DOMPurify + highlight.js + MathJax + `[@…]` 内容引用） |
| 故事正文 | **服务端**渲染 | `src/lib/story-service.ts` 的 `marked` + `stripScripts`。内容由站长直接写在 `instance/stories/`，按可信输入处理，**不走 DOMPurify / highlight.js** |
| 内容引用 `[@…]` | 浏览器渲染时正则替换为剪贴板/投票/图床/收藏夹组件 | `src/app/components/MarkdownRenderer.tsx` 的 `ContentRefProcessor`（按 id 长度分流：6 位收藏夹 / 8 位剪贴板 / 9 位投票 / 10 位图床）。**表情包不在这条管道上**。收藏夹卡片是在主循环**之后**单独一趟、按区间切片替换的，理由见 §6.10 |
| 表情包 `[@合集/表情]` | 浏览器渲染时替换为内联 `<img>`（**仅评论 / 讨论**） | `src/lib/sticker-refs.ts` 的 `embedStickerRefs`，在 `rich-text.ts` 里紧跟 `embedImageRefs` 之后调用 |
| 工具页 cattca-guide | **服务端**渲染 | marked（仅一次，可信文档） |

**讨论与评论共用一条管线**（`rich-text.ts`）。两者的威胁模型与防线逐条相同，差别只在
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

**表情图的 404 降级不在渲染管线里**，而在 `RichContentBody` 的容器上（捕获阶段的事件
委托，监听 `error` 换回纯文本 token）。原因是那条管线**字符串进、字符串出**
（`render()` 最后 `return holder.innerHTML`）：管线里建的 `<img>` 只是中间产物，
挂在节点上的监听器在序列化那一刻全部丢失，React 那端是浏览器重新解析出来的另一批节点。
资源类 `error` 事件**不冒泡但走捕获**，所以容器上一个监听器就够，且跟着容器的生命周期走。
⚠️ 那个 `useEffect` 的依赖必须是 `[html]` —— 组件在 `html` 为空时 `return null`，
div 会卸载重挂，`deps=[]` 的监听器永远附不上。

### 6.8 画报与鱼干收款码（服务端出图）

两种「发出去的图片」，都靠二维码把人带回站内。**全部在服务端生成**：

| | 二维码指向 | 入口 |
|---|---|---|
| 个人主页画报 | `${SITE_URL}/u/<id>` | 自己主页的「生成画报」 |
| 鱼干收款码 | `${SITE_URL}/fish/collect?to=<username>` | `/fish` 的「收款码」 |

管线：`src/lib/poster.ts`（**纯** SVG 构造，不碰库/文件/ sharp）→
`src/lib/poster-render.ts`（取数 + 头像 + `sharp`）→ `GET /api/poster/{profile/[id],collect}`。
`sharp(buf, { density: 144 })` 把 750 宽的 SVG 光栅化成 1500 宽的 PNG（文字与二维码是矢量，放大不糊）。
前端因此极薄：预览就是 `<img src="/api/poster/...">`，下载就是同源 `<a download>`。

四条约束，改之前先读 `src/lib/poster.ts` 文件头：

1. **二维码永远是矢量 `<rect>`，绝不用文字或 `<image>`。** 它是整张图里唯一不依赖
   服务器字体的部分 —— sharp 走 librsvg + fontconfig，**服务器缺中文字体时所有文字
   都会变豆腐块**，那时二维码仍必须能扫。字体要求见 `docs/deploy.md`，
   `npm run diagnose` 第 5 节有探针。
2. **纠错等级必须是 H。** 二维码中心压了 logo（主动挖掉一块），H 级容忍约 30%，
   降到 M/Q 就可能「图好看但扫不出来」。
3. **静默区 ≥ 4 模块、单元尺寸取整。** 这两条是踩出来的：内边距写死像素时，
   短链接的模块更大、静默区反而不够 4 个模块，解码器直接失败而肉眼完全正常。
   现在 cell 由 `floor(卡片宽 / (模块数 + 9))` 反推，尺寸全部从 cell 推出来。
   `tests/unit/poster.test.ts` 会把渲染结果**真解码**一遍来钉住这条。
4. **所有动态文本转义**（`escapeXml` + 去控制字符）。简介与用户名是用户可控的。

出图前必须检查 `siteOrigin()` 非空 —— 拼不出绝对 URL 时直接 503，**绝不生成相对路径的废码**。
`SITE_URL` 是服务端变量（无 `NEXT_PUBLIC_` 前缀），解析链见 `src/lib/site-url.ts`。

### 6.9 OAuth 2.0 身份绑定（raricy 作为 IdP）

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

### 6.10 收藏夹（favorites）

用户自建的博客合辑。一个用户可有 200 个收藏夹，一个收藏夹可有 1000 篇，
**同一篇文章可以同时进同一用户的多个收藏夹**（所以唯一约束的粒度是「收藏夹 × 博客」，
不是「用户 × 博客」）。

**两张表**（`prisma/migrations/12_favorites/migration.sql`）：

| 表 | 角色 | PK |
|----|------|-----|
| `favorites` | 收藏夹本体（标题 / 公开或私密 / 6 位对外 ID） | **UUID4** |
| `favorite_items` | 条目，软删（`deleted` + `deletedAt`） | 自增 Int |

**六条不变量**（全部集中在 `src/lib/favorite-service.ts` 的文件头，改动前先读）：

1. `publicId` 非空 ⟺ `isPublic` 为真。**私密收藏夹的 `public_id` 恒为 NULL** ——
   不是「有 ID 但不显示」，而是**没有对外句柄**。所以二维码 / `[@ID]` / bot 接口 /
   复制链接全都无处可泄，不依赖每个展示点都记得不显示。
   ⚠️ 判「对外可见」**永远用 `isPublic`，绝不用 `publicId != null`**。
2. 一切对外读取都必须过 `PUBLIC_FAVORITE_WHERE`（`isPublic` + `deleted`）——
   含软删判定，否则「永不物理删」等于删掉的收藏夹永远可读。
3. 所有权守卫照 `clipboard-service.getClip` 的口径：调用方必须显式传 `viewerId`，
   不给默认放行的参数。
4. **不继承站长的越权读**。`getClip` 让 owner 角色能读别人的私密剪贴板；收藏夹刻意
   不设这个后门 —— 私密收藏夹只有创建者本人，有用例钉住。
5. 「私密」与「不存在」对外**同为 404**，不确认存在性。
6. 复制与导入用**显式字段白名单**构造新行，绝不 `{...source}` 展开。

**ID 形态。** `favorites.id` 是 UUID 而不是自增 Int：所有者管理页的路由参数就是它
（`/favorite/mine/<uuid>`，因为私密收藏夹没有 6 位句柄），自增整数顺序可枚举 ——
那会把「私密不可被他人读」压在「每条路由都记得判所有权」上；UUID 让漏判从越权降级成
无害。**6 位数字 ID**（`public_id`）是公开收藏夹的对外句柄，空间仅 10^6，生成时
**必须查重**（拒绝采样 + 重试 10 次），不能像剪贴板那样不查。

**路由**：

| 路径 | 档位 | 说明 |
|------|------|------|
| `/favorite` · `/favorite/mine/[uuid]` · `/favorite/[publicId]` · `/favorite/guide` | core+ | 后者是公开分享页，解析走 `getPublicFavorite` |
| `/api/favorites`（GET/POST）· `/api/favorites/[id]`（GET/PATCH/DELETE）· `…/items` · `…/copy` · `…/export` · `/api/favorites/import` | core+ | 每条各自判档（§8 的档位阶梯）；`PATCH` **只接受 `title`**，改 `isPublic` 明确报 400 |
| `/api/poster/favorite/[publicId]` | core+ | 分享二维码 PNG，复用 `RULES.posterMinute`；**只按公开句柄查**，所以私密收藏夹结构性不可达 |
| `/api/spider/favorites/[publicId]` | core+ | 站外机器人的入口，只返回公开且未软删的；spider 系列里**唯一有限频**的一条（鉴权不替代限频） |

**`[@六位]` 引用。** 只在博客 / 云剪贴板那条管线生效（`MarkdownRenderer` 的
`ContentRefProcessor`），评论与讨论**刻意不认**（与 9 位投票「只识别不展开」同向）。
纯逻辑在 `src/lib/favorite-refs.ts`。

三处反直觉的实现细节，改动前务必读：

- **卡片是成品 HTML，不是「占位 div + `data-*` + 后处理建 DOM」**。因为
  `BLOG_SANITIZE_OPTIONS` 是 `ALLOW_DATA_ATTR: false`，新加 `data-favorite-id` 会被
  DOMPurify **静默剥掉**（占位符消失、卡片永不出现、完全不报错）；而 `div`/`ul`/`li`/`a`
  与 `class`/`href` 本来就在白名单内。投票之所以必须两段式是因为它可交互，卡片是静态的。
- **替换在最后单独一趟、且按区间切片**，不用 `String.replace`。卡片里含博客标题
  （不可信输入），标题里若正好有 `[@8位]` 字样，按内容替换会命中**插入内容里的那处** ——
  正是 `content-refs.ts` 里 `replaceClipboardRef` 改写成切片所规避的 bug 类型。
- **上限是 3 张**，且必须是正文的确定性函数（与 `MAX_IMAGE_REFS` / `MAX_CLIPBOARD_REFS` 同口径）。

**入口**（曾经一个都没有 —— `/favorite` 只能手敲 URL，功能做完却进不去）：

- **工具箱（`/tool`）→「站务工具」区的「我的收藏夹」卡片**，与云剪贴板 / 投票箱并列。
  这里**刻意不设 `coreOnly`**（同一区里的投票箱设了）：它原先挂在顶栏头像菜单里，
  那时就写明「不按档位条件渲染（core 以下点进去是就地 403）—— 入口不跟着藏」，
  换了个入口位置，这条口径不变。
- 收藏夹选择器弹窗页脚的「管理收藏夹 →」。

两处都有 `tests/e2e/favorite.spec.ts` 钉着（页脚那条在 `favorite-layout.spec.ts`）。

**刻意不做的事**（都是需求明确要求的，别当成遗漏）：不显示任何一篇文章的被收藏数
（`Blog` 上**没有**收藏计数列，`getBlogDetail` 的 select 也不该加）；作者**不收到**收藏
通知（本子系统完全不碰 `notification-service` / `topbar-bus`）；没有修改 `isPublic`
的接口（改性质只能靠「复制」，且复制是**快照**）。

**UI 上两个「不算 bug 的临界值」**（细节见 `docs/frontend-styles.md` §6.7，几何由
`tests/e2e/favorite-layout.spec.ts` 在真视口下断言）：

- 星标**未收藏时不亮**（跟 `currentColor`），只在 hover 与已收藏时变黄 —— 与点赞/投喂同一套
  状态色手法。别再给 `.icon-star-fill` 写死 `background-color`。
- 窄屏（≤768px）点赞/投喂/收藏**压在同一行**等宽平分；`<360px` 与弹窗里两颗创建按钮
  都退回「按内容宽度 / 上下堆叠」—— 那是按中文字体度量算出来的，不是拍脑袋的断点。

**对外文档**：`docs/bot/favorite-bot.md`（自包含，含限频数值 —— 改 `RULES` 要同步）
与 `docs/guide/收藏夹使用指南.md`。

### 6.11 文章对外可见性与分享（`Blog.visibility`）

站内其余读口一律 core+（那是熟人社区的前提），但作者可以**逐篇**决定某一篇是否对外。
三档：

| `visibility` | 页面可达性 | 页面 `robots` | sitemap | OG 图 | OG 图 `X-Robots-Tag` |
|---|---|---|---|---|---|
| `internal`（默认） | core+ 可读；访客 → 登录页 | `noindex, nofollow` | 不进 | 404 | — |
| `link` | 任何人可读 | `noindex, nofollow` | 不进 | 200 | `noindex` |
| `public` | 任何人可读 | `index, follow` | 进 | 200 | `all` |

**这一列只对非 core 的查看者生效** —— core+ 在博客域是全读的，压根不看它。所以对任何
站内入口都是零行为变化，管理员 / 站长也**不需要豁免**（他们本来就在 core+ 里，是结构性
豁免，服务层里没有也不该有 `if (isAdmin)`）。

判定收在 `src/lib/blog-service.ts` 的**四个具名出口**（六条不变量在它的文件头）：
不带查看者的读口必须走 `getExternallyVisibleBlog()` / `listIndexableBlogs()` /
`listPublicBlogs()`；带查看者的走 `getBlogDetail(id, viewer)`。词汇（三档的名字、白名单、
解析、两张人话表）住在 `src/lib/blog-visibility.ts` —— 那是个**零依赖**模块，因为发文
表单与文章卡片都是客户端组件，而 `blog-service` 拖着 prisma 进不了客户端包。

**「对外可读」与「可列举 / 可索引」是两件事**：`link` 读得到，但不进 sitemap、不许索引。
所以判可达用 `EXTERNAL_VISIBILITIES`，sitemap 用 `INDEXABLE_VISIBILITIES`，别混用。

**五个静态守卫盯着它**（都是「删掉就会静默坏掉」的那类）：
- `tests/unit/blog-visibility-guard.test.ts` —— 不许写 `{ not: 'internal' }` /
  `visibility !== 'internal'`。那两种写法在加第四档时会**静默把新档一起放出去**，
  而放出去不可逆。
- `tests/unit/anonymous-read-guard.test.ts` 的 `getExternallyVisibleBlog` ——
  它是**新的一类**守卫（per-object 可见性，不是会话档位）。对外路由必须过它，
  台账才认得；它**不在** `PUBLIC_READ_ROUTES` 里，因为那张表的门槛明写
  「一旦开始返回用户内容就必须挪走」，而 OG 图恰恰返回用户内容。
- `tests/unit/explore-visibility-guard.test.ts` —— 钉「对外列表与 sitemap 必须列同一个
  集合」：两个出口的函数体里都必须出现 `INDEXABLE_BLOG_WHERE` 这个名字（见 §6.12）。
- `tests/unit/blog-visibility-tag.test.ts` —— 钉站内列表卡片上「除 internal 外每一档都有
  标记」。那两个分支写死了字面量类名（`css-tsx-classes` 只认字面量），所以加第四档时
  不会自动长出来，而作者会把没标记的文章看成「没对外」。
- `tests/route/blog-auth.test.ts` 末尾那组 —— OG 图对 internal / 已软删 / 不存在
  **三者 404 且响应体逐字相同**（差一个字就是存在性探针）；以及 `PATCH /api/blogs/:id`
  的可见性改动**只有作者本人**能动（管理员也不行）。

**分享卡片（OG 图）**：`/api/og/blog/<id>` 是 route handler，**不是**
`opengraph-image.tsx` 文件约定（后者不在 `anonymous-read-guard` 的扫描面内，
而「匿名读口没人知道」正是那个守卫存在的理由）。走 sharp 复用 `poster.ts` 的构件，
**不用 `next/og` 的 Satori** —— Satori 不读系统字体栈，中文要自带字体二进制，
那会凭空造出第二条字体管线；而本站的字体约束已经写在 `docs/deploy.md` 与
`npm run diagnose` 的探针里。

⚠️ 它的响应头与三张画报**相反**，别顺手抄：画报是 `private, no-store` + `noindex`
（用户自己保存的物料），OG 图是 `public, max-age=600` + 按档位发 `X-Robots-Tag`
（要被 CDN 与社交爬虫取）。版式几何由 `tests/unit/og-card.test.ts` 按最坏情况钉住 ——
初版把标题基线写死，2 行标题 + 2 行摘要时摘要正好压在页脚线上，而「是张合法 PNG」
的断言全绿。

**爬虫入口**（`robots.ts` / `sitemap.ts` 是这件事的两半，必须同进同退）：
`/blog/` 从 disallow 里开口（用 RFC 9309 的最长匹配压过 `/blog`）、`/login` 补进
disallow（断掉「internal 文章 → 307 → next 参数里带 UUID」那条链）、`/api/og/` 开口。
逐页 / 逐张的粒度由页面 `robots` 元数据与 `X-Robots-Tag` 收 ——
与 `/api/images/[id]/raw` 按张发头是同一个手法。

**可见性变更记账**（`blog_visibility_logs`，迁移 19）：
`public` 是不可逆的，所以「这篇什么时候被放出去的、改过几次」值得有账。**只记变更、不记创建**
（新文章落默认档不是「变更」，记它等于给每次发文写一行噪音）。**改档位与记账在同一个事务里**
（`updateBlog` / `setBlogVisibility`）—— 分开写会得到「档位改了但没账」，而那种状态只能靠
人工比对发现。`actor_id` 今天恒等于作者（PUT / PATCH 都只认作者本人），仍然留着：账不该
依赖「将来也不会有人代改」这个假设，假设一旦破那段历史补不回来。
读口是 `listBlogVisibilityLogs()`，目前只在「管理文章 → 设置可见性」里显示最近一条 ——
**面向站长的完整轨迹视图还没做**（CLI 或管理端；数据已经在表里，随时可以补一个读口）。

**风险**（详见 `src/lib/blog-visibility.ts` 与发文表单里的提示）：
1. **一旦公开就近乎永久** —— 搜索引擎与第三方存档会抓走副本，改回 internal 不收回
   已抓走的副本，社交平台的卡片缓存（数周）也不撤回。
2. 可见性**不扫描正文**。访客视图不展开 `[@…]` 内容引用、私有图床图对匿名仍 404，
   所以不会因「设为公开」把别人的私密资源放出去；但作者自己写下的文字就是他自己公开的。
3. `spider` 命名空间仍能读到全部 internal 文章（档位是 core+ 的一个账号）。这是现状，
   本期刻意不动 —— 要收紧的正确做法是给 spider 单独一档或只读账号，
   **不是**在那条路由里加可见性过滤（那会把「站外聚合器能读什么」和「文章是否对外」
   这两件事混在一起）。

### 6.12 对外公开列表 `/explore`

第 1 期把「单篇读得到」打开了，但访客读完就是死胡同 —— 而从站外点进来的人**没有经过
本站导航**。`/explore` 是第二条边，也是全站**唯一**不需要登录的浏览面。

**取数只有一个出口**：`listPublicBlogs()`（`src/lib/blog-service.ts`），它以
`...INDEXABLE_BLOG_WHERE` 起手，与 sitemap 的 `listIndexableBlogs()` **列同一个集合**。
这条同源不是洁癖 —— 「可发现」的整个承诺就是「爬虫抓得到 ⟺ 公开列表上找得到」；
若列表多一层过滤，就会出现「搜索引擎收录了一篇，读者在公开列表上翻不到」，而这条差异
**不会有任何报错**。有静态守卫盯（见 §6.11 的守卫清单）。

⚠️ **它按「结果集」判空，而不是按请求**：`exclude_from_all` 与 `focus_hidden`
（`exclude_from_all` 是站内「全部文章」的陈列规则、`focus_hidden` 是账号级浏览偏好）
**一律不作用于这里** —— 对外列表的资格只有一条 `visibility = public`。混合它们会直接
破坏上面那条同源。

**侧栏从公开集合反推**：`listPublicCategoryFacets()` 取出公开文章真正出现过的
`category_id`，页面据此剪枝栏目树 —— 只列「自己或某个子栏目有公开文章」的栏目。
空栏目是死链，也会给搜索引擎一批空页面（与 sitemap 不收空路径是同一条纪律）。
它也刻意**不递归**：本站只支持两级栏目。

**卡片上没有计数**（`.blog-stats` 整块不渲染）。对外视图没有评论区（§6.11），
卡片上写「评论 12」却翻不到评论是自相矛盾的；点赞与鱼干更是站内的事。同理，
**作者名是纯文本不链接** —— 作者页对外（`/u/<id>` 只列该用户的 public 文章）是个独立的
对外读口，要单独想清楚，本期不做。卡片上的可见性短标记取自 `VISIBILITY_BADGE`
（零依赖模块），加第四档时 tsc 会因 `Record<BlogVisibility, string>` 缺键报错。

**索引口径**（三条互不重叠）：

| 情形 | `robots` | canonical |
|---|---|---|
| 结果集为空 | `noindex, follow` | 自身 |
| 带 `?search=` | `noindex, follow`（恒） | 自身（含 search） |
| 其余 | `index, follow` | **自身**（含 `?category=` 与 `?page=`） |

⚠️ **canonical 恒指向自身，别把分页指到第 1 页** —— 那等于告诉搜索引擎「第 2 页是第 1
页的副本」，后几页的文章会跟着一起掉出索引。这是本仓库第一处用 `alternates.canonical`。
空结果 → `noindex` 这一条与 sitemap 是**同一件事的两半**：`sitemap.ts` 也只在
`listIndexableBlogs()` 非空时才把 `/explore` 列进去，否则就是「把一个自报 noindex 的
URL 请来抓」。（`robots.ts` 的**路径级**规则不需要动 —— `/explore` 本来就未被 disallow，
被 `allow: '/'` 覆盖。）

**访客的两条「博客」入口按档位分流**：顶栏与首页卡都对所有人渲染，但 core+ 指向 `/blog`
（站内全量）、其余指向 `/explore`。这不违反「入口不跟着藏」（§8）—— 那条反对的是
**因档位不够就把入口藏掉**；这里入口照旧在，只是通向一个访客真能打开的页面。
⚠️ 别把这当成自相矛盾「统一」回 `/blog`，那等于让访客点进一张登录页。
另外，访客视图的文章底部还有一条回 `/explore` 的链接（`blog/[id]/page.tsx`）——
那条边是给站外直接落地的读者准备的。

**限频**：`/explore` 是本站**第一个匿名页面**的限频，没有会话可依，只能按 IP
（`RULES.exploreSearchPerIp`，与 `ogImagePerIp` / `spiderFavoritePerIp` 同档）。
**只对真的带搜索词的请求计数**，翻页 / 换栏目不计数 —— 否则限频会变成「限页」，
正常访客翻两页就撞墙，而且不报错、单测也测不出来。超限时**不创建查询 promise**
（创建即发起查询，限频就只省流量、没省 CPU），且提示文案必须与「没有结果」可区分。

⚠️ **对外搜索绝不碰正文**：字段集是 `PublicSearchField = Exclude<SearchField, 'content'>`，
所以那是**编译期**事实 —— 谁想把 `content` 加进去，tsc 当场拒绝，而不是等线上匿名用户
把 48.6MB 正文扫一遍才发现。行为侧另有一条哨兵用例兜底。

**它不能静态化**：根 layout 读 cookie 取登录态（顶栏要按档位渲染），整棵树因此都是动态的。
写 `revalidate` 是自欺（不会生效，只会让下一个人以为这页有缓存）。

**结构化数据**：public 文章页输出 `BlogPosting`（`src/lib/json-ld.ts` 的 `jsonLdScript()`）。
⚠️ 本站**没有任何 CSP**（`next.config.mjs` 与 `src/middleware.ts` 都查过），转义写错时
没有任何响应头兜底：一个含 `</script>` 的**标题**就能提前闭合脚本块，而文章页恰恰是对外
可索引的。所以 `dangerouslySetInnerHTML` **一律过那个函数**，别在 JSX 里手写。
`datePublished` / `dateModified` 一律过 `db-time.ts` 的 `isoWithOffset()` ——
库内是「UTC+8 墙上时间贴 Z」，裸 `toISOString()` 会让机器以为它**晚** 8 小时发布
（落在未来还可能让搜索引擎暂缓收录）。

### 6.13 鱼干练手盘（`/fish/trade`）

投入鱼干买入一个**绑定真实加密价格**的仓位，价格涨跌决定能拿回多少鱼干。档位 **core+**
（与签到、投喂同档）—— 它是**签到之外第二条 core+ 赚取渠道**，没有突破「非核心账号没有
鱼干赚取渠道」那条口径。

**这不是交易所，也不是庄家对赌**：没有撮合、没有对手盘、没有敞口。系统账户
`raricy-blog-system` 是**无限水池** —— 用户赚了从它 mint、亏了 burn 回它。它只存在于远端
账户服务，本地没有 `users` 行（所以持仓流水 `related_user_id` 留空，信息进 `description`，
与签到同款）。

- **★ 成交价必须是下单那一刻现取的 ★** 这是整个功能唯一的安全边界，其余都是体验问题。
  `openPosition` / `closePosition` 都调 `fetchQuote()`（向交易所现拉，3 秒超时），**绝不
  读 `getCachedQuotes()` 那份展示缓存**。用缓存价成交 = 看盘的人可以在价格跳动后、缓存
  刷新前下单 —— 无风险、可重复、无上限的套利，不需要任何交易水平。行情源挂了就 503 拒单，
  **不降级**。`tests/unit/market-price.test.ts` 有一条专门钉这条性质，别删也别「优化」掉。
  **前端不传价**：提交体里只有标的与金额，确认弹窗如实写明「实际成交价以下单那一刻为准」。
- **数据源是 `data-api.binance.vision`**（币安拆出来的纯行情公共域，不吃 key）。之所以不用
  `api.binance.com`：生产服务器是阿里云大陆，实测那个域名被 DNS 投毒，CoinGecko / OKX /
  Coinbase 等一概超时。基址可用 `MARKET_PRICE_BASE_URL` 覆盖 —— e2e 指向替身，也是上线时
  万一出口不通的换源开关，不用发版。见 `src/lib/market-price.ts` 头部。
- **展示缓存与轮询**：`market-poll-drainer.ts` 每 15 秒刷一次（`MARKET_POLL_MS=0` 可关），
  由 `src/instrumentation.ts` 启动 —— 它是本站**第二个**后台循环。它**只服务展示**，
  与成交无关。页面自己也有 15 秒轮询（隐藏标签页不轮、回前台先补一次）。
- **结算**：`payoutUnits = floor(stakeUnits × 平仓价 / 开仓价 × (1 − MARKET_FEE_RATE))`。
  `floor` 是刻意的 —— 舍入永远朝系统一侧，宁可少发一个单位也不凭空多铸。手续费
  **只在平仓侧收一次**（开仓免费、持有免费）。最小投入 1 条鱼干：存储层最小单位是
  0.1 条，投 0.1 = `floor(1 × ratio × 0.999)`，**价格不涨过 0.1% 就必然结算成 0**，
  那不是高风险而是几乎必赔的陷阱。
- **一行 = 一个批次（lot）**，不是聚合持仓。每次开仓插一行，平仓就地改成 `closed` ——
  部分平仓会把幂等做成一件难事（同一请求重放时要认出「这是同一笔」而不是「又一次部分
  平仓」）。**绝不物理删除**，唯一例外是远端同步失败的补偿事务（那笔开仓从未生效）。
- **账本**：`SyncOperation` 新增 `market_buy` / `market_sell`；远端 `entry_type` 同名。
  开仓幂等键 `open_key`（每次唯一、带随机后缀，混进 `userId` 哈希避免两个用户撞键）；
  平仓靠 `status` 的条件写天然幂等。实发为 0 时**不写流水、不登记账本、不打远端**
  （没有钱动过）。
- **限频**：`RULES.tradeMinute` / `tradeDaily`（20/分、300/天）。它防的不是刷屏，是
  **出站流量 + 远端写入**：每笔成交都要现取一次行情外加一次远端转账。桶键 `trade:` 前缀，
  不复用 `transfer:`。
- 页面的行情卡在拉不到价时显示「行情暂不可用」并**禁掉买入**；缓存超龄时显示「数据可能
  不是最新的」。**绝不编一个价出来** —— 用户会照着一个假价格按下买入。

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

一条路由**两种视图**，分叉判据是 `isCore` 而不是 `visibility`（core+ 读一篇 public
文章看到的仍是完整成员视图 —— 否则「设为公开」会顺手夺走作者自己与全站的互动能力）：

```
浏览器 GET /blog/<id>
  → middleware.ts  ✓ 同源
  → blog-service.getBlogDetail(id, viewer)   viewer = null（游客）/ { id, isCore }
       非 core 叠 EXTERNAL_VISIBLE_BLOG_WHERE（core+ 不加条件）
  → 查不到（不存在 / 已软删 / 档位不够，三者同形）→
       未登录  → redirectToLogin('/blog/<id>')   站内文章不是「不存在」，访客拿登录页
       非 core → forbidden()                     已登录但档位不够 → 原地 403
       core+   → notFound()
  → Server Component 渲染 Markdown 占位 + 注入数据
       core+ → 正文 + FeedButton + CommentSection（contentRefs='expand'）
       访客 → **只有**标题 / 作者 / 正文（contentRefs='plain'），零站内 affordance
  → 客户端 marked + DOMPurify + highlight.js 完成正文
```

⚠️ **原始 markdown 是作为 RSC prop 随首屏 payload 下发的** —— 「正文交给客户端渲染」
不构成任何保护，闸门必须在服务端把串传出去之前（`docs/architecture.md` §6.7 那条管线）。

⚠️ `MarkdownRenderer` 的 `contentRefs` 是**必传** prop：`'expand'` 会带 same-origin
凭据去请求三条 core+ 接口（剪贴板 / 投票 / 收藏夹），`'plain'` 一次请求都不发、
`[@…]` 原样保留字面量。访客视图那条是匿名页面上**唯一的内容泄露面**。

⚠️ `generateMetadata()` 与页面是**两个独立的渲染步**，页面那道可见性判定管不到它 ——
它必须自己判一次，判不过就返回中性标题、绝不回显（`tests/e2e/access-control.spec.ts`
与 `tests/e2e/blog-visibility.spec.ts` 各有一条钉子）。

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
| `ChatMessage.isDeleted` | false | 讨论消息 |
| `Favorite.deleted` | false | 收藏夹（配对 `deletedAt`） |
| `FavoriteItem.deleted` | false | 收藏夹条目（配对 `deletedAt`） |

**软删即抹掉附件与原文**：评论被软删后，序列化时 `content` 与 `content_html` 一律换成
占位文案，`image` / `blog` 一律置空（`image_missing` / `blog_missing` 也置 false —— 软删
不是「附件丢了」）。漏掉任何一项都等于「删了没删」：原文还在 DOM 里，或删掉的图仍能
点开看原图。讨论消息同此口径（`chat-service.ts` 的 `attach…`）。

### 角色体系与鉴权门

**三个词先定死**（注释里到处在用，读混了就会把「谁被挡在外面」判错）：

| 词 | 指谁 | 有账号吗 |
|----|------|---------|
| **游客** | 未登录 | 没有 —— 不在 `users` 表里，服务端拿不到 uid |
| **未认证用户**（UI 上叫**普通用户**）| `role='user'` | **有** —— 用户名 / 密码 / 会话 / 可被禁言都齐全，只是没过邀请码认证 |
| **认证用户**（也叫**核心用户**）| core / admin / owner | 有（`broadcast-service.ts` 的 `'authenticated'` 档即此）|

> ⚠️ **「未认证用户」不是游客。** 两者在门里走的是**不同的岔路** —— 未登录 `redirect`
> 去登录页，已登录但角色不够 `forbidden()` 原地 403（见下一段）。所以「未认证用户
> 用不了界面，却 curl 得动」这类注释，说的是**已登录、非 core 的账号**绕过了页面门，
> **不是**「匿名可打」。读混的代价是实的：会把「这里该收 core 门」误判成「收登录门」，
> 于是 role=user 那条路仍然是个洞。
>
> **接口语境里的「凭据」是另一回事**：账户服务的双层密钥、鱼干市场无状态接口的凭据、
> 登录限频那几处注释，说的都是**这个请求带没带凭据**，与角色轴无关。按主体分就不会错 ——
> **主体是「人 / 账号」走角色轴，主体是「请求 / 接口」走凭据轴。**

`src/lib/guard.ts` 是**页面级**鉴权门 —— async 函数，不是装饰器，共四个：

- `requireLogin()`（已登录）—— 只要求登录，角色够不够交给调用方
- `requireCoreUser()`（已登录 + core+）—— 「核心用户」档：管理员与站长自然也过
- `requireAdmin()`（已登录 + admin+）—— 段内放宽后，由真正要管理权的页面自己把门
- `requireOwner()`（仅站长）—— 全站最高一档，其它角色一律挡在外面

未登录 → `redirect('/login?next=<原URL>')` 回跳；已登录但角色不够 → `forbidden()` 原地渲染 403 页。

**`/admin/*` 不是单一档位**：段级 layout（`admin/layout.tsx`）只判 core+ —— 因为段内的
「用户管理」核心用户本来就能进（只读版：标题
「用户列表」，无禁言 / 发通知 / 角色按钮）。段内需要更高权限的页面**各自把门**
（URL 猜得到，侧栏藏起入口不等于挡住）：`/admin`、`/admin/blogs` 用 `requireAdmin()`；
`/admin/oauth` 用 `isOwner()`；`broadcast` / `categories` / `appeals` 各自的
`layout.tsx` 用 `requireOwner()`。新增段内路由请照抄其中一档，别默认继承。

**API 路由不用它们**（重定向对 XHR 无意义）：各 `route.ts` 自取 `getCurrentUser()` 后返回
`apiErr(403, …)`，管理端另用 `hasAdminRights()`（`src/lib/auth.ts`）之类的判定。

**档位阶梯：页面与接口必须同档，但入口不跟着藏。** 一个功能有页面 + 若干接口时，
**每一层都要自己判**，别只挡离用户最近的那层。签到是标准例子（全部 core+）：

| 层 | 判定 |
|----|------|
| `/checkin` 页面 | `isCoreUser(user)` → 渲染 403 页（不用 `requireCoreUser`，理由见该文件头）|
| `POST /api/checkin` | `isCoreUser` → `apiErr(403, CORE_ONLY)` |
| `POST /api/checkin/claim` | `isCoreUser` → `apiErr(403, '需要核心用户权限')` |

> ⚠️ **发鱼的其实是 `claim`**（签到只是翻牌的入场券）。只挡 `/api/checkin` 而不挡 claim，
> 等于没挡 —— 直接 POST claim 就能拿鱼干。新增「页面 + 多接口」的档位功能时照此三处对照。

**读口也一样，而且漏了不报错。** 页面那道 guard 只挡浏览器：`/blog` 一直有
`requireCoreUser()`，而同名的 `GET /api/blogs` 与 `GET /api/blogs/[id]` 长期免认证 ——
匿名 curl 一次就能拿到全站目录与全文 Markdown。**「页面与接口必须同档」对读口同样成立。**
全站哪些读口是**有意匿名**的，以 `tests/unit/anonymous-read-guard.test.ts` 的台账为准：
新增一条没有守卫的 `GET` 会让该测试当场变红，逼你在「加档位」与「写进白名单并说明理由」
之间选一个。已有的正例是 `GET /api/images/[id]/raw`（公开图匿名、私有图按档位）与
`GET /api/users/[id]`（匿名可达但内容按查看者收敛）。

**「对外可见的文章」是这条的更远一步**（§6.11）：`/blog/<id>` 与 `/api/og/blog/<id>`
**匿名可达**，但逐篇判可见性 —— 不在 `PUBLIC_READ_ROUTES` 白名单里，而是走
`getExternallyVisibleBlog` 这个**具名出口**过 `GUARD_SYMBOLS` 那条判据。它是全站第一个
「游客能读到用户内容」的入口，所以判定收在一个出口、白名单是**开区间**式的
（`EXTERNAL_VISIBILITIES` 只列算数的档，加第四档时不会自动放行）。

**「档位」与「归属」是两层，别用一个代替另一个。** 博客与评论域有多条接口同时要过两关：

| 接口 | 档位（你有没有资格用这个区） | 归属（这一份是不是你的） |
|------|------------------------------|--------------------------|
| `PUT` / `DELETE /api/blogs/:id` | core+ | 作者本人 |
| `DELETE /api/comments/:id` | core+ | 评论作者本人或管理员 |
| `GET /api/blogs/:id/likers`・`feeders` | core+ | 作者本人或管理员 |

只判归属的后果是实的：评论删除漏了档位这一层时，一个被降权（core→user）的账号仍能删掉
自己当年写下的评论 —— 那些评论产自他还是 core 的时候。归属判定管的是「这条归谁」，
它回答不了「你现在还配不配用这个区」。反过来只判档位也不行（core 用户能删别人的评论）。

**「入口不跟着藏」是刻意的**：拿签到举例，顶栏图标对**所有人**渲染（与博客、讨论同待遇），
未登录点了跳登录、非 core 点进去原地 403。但 `layout.tsx` 只给 core+ 发
`checkin-api-url` 这个 meta —— 否则 `base.js` 会拿 403 响应点亮一个**骗人的「可签到」徽标**。
即：**门禁收紧，入口照给，但别给「你能用」的假信号**。这条在 `tests/e2e/access-control.spec.ts`
的「入口保留」一组有契约。

### ID 风格

| 实体 | ID |
|------|----|
| User · Blog · BlogContent · Comment · Notification | UUID4 |
| ClipBoard | 短 ID：**base36**（小写字母 + 数字，8 位，`short-id.ts`） |
| Vote · ImageHosting | 短 ID：**base62**（9 位 / 10 位） |
| Favorite | UUID4（所有者管理页的路由参数；不可枚举，见 §6.10）＋ 可选 `publicId`：**6 位纯数字**，**仅公开收藏夹有值** |
| FavoriteItem | 自增整数（join 行） |
| Category · AdminActionLog · AdminActionAppeal · UserBan | 自增整数 |

> 各 ID 的**长度**互不重叠是**有意的**：`[@…]` 引用语法只按长度分流，6 位是收藏夹、
> 8 位剪贴板、9 位投票、10 位图床。新增任何「会出现在正文引用里的 ID」都要先确认
> 长度没被占用（博客是 UUID、含连字符，根本进不了那条正则）。

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
| 进程内「在看」状态（`chat-presence.ts`） | 多实例下「谁在看哪个会话」的报到与发消息可能落在不同实例 → 判不出在看 | 退化成照常发 @ 通知（多打扰一次，**不静默丢**），与进程内限频同一类已知限制 |
| `instance/` 在部署机器 | 需挂载真实目录否则上传 500 | 部署脚本里 `node scripts/check-instance.mjs` 兜底 |
| 初次部署既有库 | `FISH_ENCRYPTION_KEY` 必须留空，否则解不开存量密文 | `npm run diagnose` 会校验 |
| 反代改写了 `Host` 且未透传 `X-Forwarded-Host` | 浏览器 `Origin` 与三个来源都对不上 → 全站 POST 403（CSRF 误杀）。nginx 默认就把 `Host` 设成 `$proxy_host`（upstream 地址），所以**两个头都要显式透传** | `ALLOWED_ORIGINS="你的域名"` 兜底或修 nginx |

---

## 11. 推荐阅读

- `docs/deploy.md` — 部署 / 运行 / nginx / systemd
- `docs/cli.md` — 运维 CLI 命令
- `../CLAUDE.md` — 关键约定（约束与反直觉决策）
- 内容/玩法文档：`docs/guide/` —— 玩家与创作者文档（cattca / 云剪贴板 / 图床 / 投票箱 / story）
