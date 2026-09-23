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
│   ├── schema.prisma       36 表 1:1 映射真实库
│   └── migrations/         含 0_init 基线（已 apply 到 db.db）
├── scripts/                运维/自检/迁移/切换脚本
├── tests/                  vitest 单测 + Playwright e2e
├── docs/                   本文与运维文档；guide/ 为玩家/创作者文档
├── public/                 静态资源（图标 / CSS / favicon）
└── instance/               gitignored: avatars/ database/ frames/ images/ stories/ stickers/ blogs/
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
| `/fish/market` · `/api/fish/market/*` | page + API | 鱼干市场：**用户间转账**（第一期，无手续费）+ **鱼干商城**（租头像框，见 §6.14）。`POST transfer`（支持客户端幂等键）/ `GET users`（收款人搜索）/ `POST balance`、`POST transactions`（站外脚本用的无状态查询，含 `since_id` 对账游标）/ `POST pay`（收银台专用）/ `POST rent`（租头像框 —— **只认会话**，是本命名空间唯一的例外，理由见 §6.14）。写路径见 §6.3；对外契约见 `docs/bot/fish-bot.md`（`rent` 不在其中，它没有对外契约） |
| `/fish/pay` | page | **收银台**：站外商户把用户送来付款（`?to= &amount= &note= &from= &return=`）。参数一律不可信，只做展示；付款必须**已登录 + 再输一次密码**（step-up），密码只输在本站域名下。不入索引 |
| `/fish/collect` | page | **扫码收款页**：`?to=<用户名>`，扫「鱼干收款码」落到这里。与收银台的区别是**金额由付款人自己填**（静态码不可能带金额）。前端是 `/fish/pay` 的**同一个组件**（`src/app/fish/PayForm.tsx`）的另一个变体，step-up 与幂等键完全共用 |
| `/fish/api` · `/api/fish/tokens/*` | page + API | **机器人接入自助页**：签发 / 吊销只读凭据（`GET`/`POST /api/fish/tokens`、`DELETE /api/fish/tokens/[id]`）。**只认会话**、签发要 step-up、只能动自己的。只读凭据的鉴权门在 `src/app/api/fish/market/_auth.ts`（第三道门，`allowReadToken` 默认关）；签发/校验/吊销在 `src/lib/fish-token-service.ts` |
| `/api/poster/profile/[id]` · `/api/poster/collect` | API | **画报 / 收款码出图**（PNG，仅本人）。渲染管线与四条约束见 §6.8 |
| `/notifications` · `/api/notifications/*` | page + API | 通知中心。其中 `GET count` 是顶栏指示器的**兜底快照**（**不能删**：SSE 有「连着但收不到」的半死状态），`GET stream` 是**实时流**（SSE，未登录 401；首帧全量快照 + 之后增量补丁）。推送点纪律与依赖方向见 `src/lib/topbar-bus.ts` 头部 |
| `/vote` · `/vote/[id]` | page | 投票 |
| `/checkin` · `/api/checkin` · `/api/checkin/claim` | page + API | 每日签到（**core+**：鱼干的赚取渠道，与投喂/点赞同档）。**三处都要判** —— 发鱼的其实是 `claim`，见 §8 |
| `/clipboard` · `/clipboard/[id]` · `/api/clipboard/*` | page + API | 云剪贴板 |
| `/image` · `/image/admin` · `/api/images/*` | page + API | 图床 + 管理 |
| `/audio` · `/audio/admin` · `/audio/guide` · `/api/audio/*` | page + API | 音频床 + 管理。**独立配额**（不吃图床那份 50MB），见 §6.6/§6.15 |
| `/image/i/<id>` · `/auth/avatar/<id>` | rewrite | **不是路由**：历史版本的旧直链，由 `next.config.mjs` 的 `rewrites()` 映射到 `/api/images/<id>/raw`、`/api/avatar/<id>`。存量正文里写死的就是它们（见 `tests/e2e/legacy-urls.spec.ts`） |
| `/story` · `/story/[...path]` | page | 故事合集/阅读 |
| `/tool` · `/tool/<sub>` | page | 工具集（aes / base / hash / hex / html / qp / translate / url / cattca） |
| `/admin/*` · `/api/admin/*` | page + API | 管理后台（档位分页而异，见 §8） |
| `/audit` · `/audit/[id]` | page | 审计日志公示 + 申诉。页面（母版 `src/app/audit/layout.tsx`）、`GET /api/audit` 与提交申诉**同为 core+** —— 「公示」的口径是**公示给站内成员**，不是对外透明 |
| `/contact` · `/privacy` · `/terms` | page | 联系 / 隐私 / 条款 |
| （无 URL）`forbidden.tsx` | 特殊文件 | 403 页本身；由 `forbidden()` 原地渲染，**不是** `/forbidden` 路由 |
| `/sitemap.xml` · `/robots.txt` | route | sitemap.ts / robots.ts |
| `/api/avatar/[id]` · `/api/images/[id]/raw` · `/api/audio/[id]/raw` | API | 头像 / 图床 / 音频床原生分发。**音频那条支持 Range**（`206`）—— 播放器拖进度条与 Safari 的播放探测都靠它，图床这条没有 |
| `/api/audio/admin/[id]` | API | 音频床**站长硬删**（物理删文件 + 删行）。用户侧那条 `DELETE /api/audio/:id` 一律软删 |
| `/api/frames/[key]` | API | **头像框素材字节**（`public/static/frames/<key>.png`）。**刻意匿名** —— 与表情字节路由同性质：素材不属于任何账号、不随会话变化。**到期不在这里判、也不该判**：到期的是一条**引用**（谁在戴），不是这些字节（见 §6.14） |
| `/api/users/me/frame` | API | **我的头像框**：`GET` 回持有列表 + 当前装备（都是**判定后的结果**），`PUT` 装备 / 换框 / 卸下（`{ frame_key: string \| null }`）。用户侧唯一的写口，见 §6.14 |
| `/u/[id]` | page | 公开用户主页（**段名是用户 id（UUID），不是 username**）。**匿名可达**（主页画报的二维码把站外人引到这里），故内容按查看者分档：身份字段人人可见，role 徽章 / 最近文章 / 最近评论 / 计数 / 最后登录只给本人或 core+ —— 收口在 `user-service.getPublicProfile` 与页面里，两边口径必须一致 |

## 5. 业务逻辑层（src/lib/）

按子域分组（每组均与路由 1:1 或 1:多对应）：

| 分组 | 文件 |
|------|------|
| 认证 / 会话 | `auth.ts` · `session.ts` · `password.ts` · `invite-code.ts` · `user-service.ts` · `identicon.ts` · `avatar.ts`（头像字节的**唯一**解析处：`/api/avatar/[id]` 与画报共用同一份目录穿越守卫）· `site-url.ts`（`SITE_URL` → `ALLOWED_ORIGINS` 回退链的唯一实现，OAuth 的 userinfo 与画报的二维码前缀共用）· `avatar-refs.ts`（**零依赖**：`avatarUrl(id)` 是全仓唯一拼 `/api/avatar/` 的地方。单独一个文件是因为 `avatar.ts` 拖着 `node:fs`，客户端组件 import 不了） |
| 数据层 | `db.ts` · `db-time.ts` · `format.ts` |
| 博客域 | `blog-service.ts` · `feed-service.ts` · `comment-service.ts` · `comment-shared.ts` · `blog-sort-pref.ts` · `spider-service.ts` |
| 富文本渲染 | `rich-text.ts`（共享管线）· `chat-markdown.ts` · `comment-markdown.ts` · `blog-markdown.ts` · `content-refs.ts`（评论/讨论那条**同步**管线：只认 8 位与 10 位，9 位投票与 6 位收藏夹刻意不展开）· `favorite-refs.ts`（`[@六位]` 卡片：**只在博客/剪贴板**那条管线生效，见 §6.9）· `user-refs.ts`（`[@用户/用户名]` 名片：同样只在评论/讨论生效，见 §6.7）· `markdown-math.ts` · `linkify.ts` · `vditor-theme.ts` |
| 表情包 | `sticker-refs.ts`（`[@合集/表情]` → 内联 `<img>`，跑在`rich-text.ts` 的净化**之后**）· `sticker-service.ts`（素材扫盘与三层缓存）· `emoji-faces.ts`（内置黄脸合集的编译期清单，素材从 npm 包拷进 `public/static/emoji/`）。安全边界与正则纪律见几者头部；玩家向说明见 `docs/guide/表情包使用指南.md` |
| 讨论 | `chat-service.ts` · `chat-bus.ts`（SSE 订阅）/ `chat-shared.ts`（DTO）· `chat-presence.ts`（「谁正在看哪个会话」—— 进程内，决定被 @ 时发不发通知）· `chat-sidebar-pref.ts` · `focus-mode.ts` |
| 实时传输 | `sse.ts` —— SSE 响应头 / 帧格式 / 重连与背压 / 心跳常量的**唯一出处**，两条流共用（讨论 `chat-bus.ts`、顶栏 `topbar-bus.ts`）。新增 SSE 路由一律 import 它，不要手抄响应头（`no-transform` 少一个字的后果见该文件头注释） |
| 顶栏指示器 | `topbar-bus.ts` —— 铃铛未读数 + 讨论红点的 SSE 订阅表（推**增量补丁**，首帧全量快照由路由拼）。推送点纪律（`hasSubscriber` 同步早退、算值必须在吞异常的 try 内）与依赖方向约束**见该文件头部** |
| 通知 / 审计 | `notification-service.ts` · `broadcast-service.ts` · `audit-service.ts` · `admin-appeal-service.ts` |
| 投票 / 签到 / 剪贴板 | `vote-service.ts` · `checkin-service.ts` · `clipboard-service.ts` |
| 收藏夹 | `favorite-service.ts`（六条不变量见文件头）· `favorite-refs.ts`（`[@六位]` 的纯逻辑），见 §6.9 |
| 图床 | `image-service.ts` · `image-upload.ts`（服务端）· `image-client.ts`（浏览器侧选图上传，讨论与评论共用）· `vditor-upload.ts`（Vditor 编辑器的上传配置，博客与剪贴板共用；与 `/api/images` 的字段名/响应结构两端对齐，见 `tests/unit/vditor-upload.test.ts`） |
| 音频床 | `audio-upload.ts`（magic bytes 嗅探 + **MIME 别名归一化**，**无压缩**）· `audio-service.ts`（含**独立配额聚合**）· `audio-refs.ts`（`[@音频/<ID>]`，**零 import** —— 要被拉进客户端包），见 §6.15 |
| 头像框 | `frame-refs.ts`（**零依赖**词汇层：白名单 / 解析 / 到期判定 / **租金与在架清单**）· `frame-service.ts`（素材扫盘 + 持有与装备写路径 + **判定唯一出口**；授予内核 `grantFrameTx` 收调用方的事务，供商城拼原子性）· `frame-shop-service.ts`（鱼干商城：租框。**它不直接写那两列**，一律经 `grantFrameTx` —— F1），见 §6.14 |
| 故事 | `story-service.ts` |
| 画报 / 收款码 | `poster.ts`（纯 SVG 构造，含二维码与转义）· `poster-render.ts`（取数 + 头像 + sharp 光栅化），见 §6.8 |
| 小鱼干 | `fish-service.ts`（**记账内核 `postEntry`** + 读路径，见 §6.3）· `fish-idempotency.ts`（哪些操作才登记幂等 —— 判据在文件头）· `fish-admin.ts` · `fish-market-service.ts`（用户间转账，见 §6.3）· `fish-compensate.ts`（`fish compensate` 群发补偿，只发 core+，见 `docs/cli.md` 与文件头）· `fish-units.ts`（单位换算；`Blog.fishCount` 是**例外**，见文件头）· `fish-webhook-service.ts`（收款回调 outbox，见 §6.3） |
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

### 6.3 鱼干账户（站内自洽）

**账目与业务数据在同一个 SQLite 文件里，每笔鱼干操作就是一次普通事务。**
没有补偿事务、没有 outbox、没有跨进程同步 —— 要么全成，要么全不成。

- **唯一的记账内核 `postEntry`**（`src/lib/fish-service.ts`）：全站**唯一**改
  `users.driedFish` 的地方，收调用方的 `tx`，在同一个事务里改余额 + 写一行
  `fish_transactions`。入参是**有符号的存储单位**（0.0001 鱼干，见 `fish-units.ts`）：
  出账走单条带谓词的 UPDATE（`driedFish >= need`）并在未命中时抛
  `InsufficientFishError`，入账走 `increment`。`addFish` 是它的「只加不减」语义壳。
  ⚠️ **新增鱼干写路径时不要绕过它自己写 `update` + `create`** —— 那正是
  「余额改了、流水没写」这类静默账目损坏的入口。
- **六条写路径，全部一个事务**：签到翻牌（`checkin-service.ts`）/ 投喂
  （`feed-service.ts`）/ 管理员发扣与群发补偿（`fish-admin.ts`、`fish-compensate.ts`）/
  用户间转账（`fish-market-service.ts`）/ 练手盘开平仓（`market-service.ts`）/
  **租头像框**（`frame-shop-service.ts`，见 §6.14）。
  **注册建号不再属于这里** —— 它当年要走一环「在远端建账户」，现在只是建一行
  `users`（初始余额就是列默认值 0），一行鱼干都不写。
  ⚠️ 新增写路径时两条硬要求：一是别绕过 `postEntry`（见上），二是**用例末尾调一次
  `expectLedgerConsistent()`**（`tests/helpers/fish-ledger.ts`）。
- **故障语义**：余额不足、参数非法、超出上限是**业务结果**（400 / 退出码 1）；
  本地事务本身失败是**真故障**（500 / 退出码 2）。**没有 503 了** ——
  那一档原本全部来自「远端账户服务不可达」，而它已经不存在。
- **幂等**（`src/lib/fish-idempotency.ts`）：**只有键是确定的操作才登记** ——
  同一次操作重跑必须等价于没跑时才登记。
  - 用户间转账带**客户端幂等键**：同键同参数重发 → 返回原结果（`duplicated: true`）、
    同键不同参数 → 409。记录写在业务写入的**同一个事务**里，所以「钱动了但键没记」
    在结构上不可能发生；并发同键由唯一约束挡下。
  - 群发补偿按 `batchId` 派生键，批次中断后续跑跳过已发放的人。
  - **签到翻牌 / 投喂 / 管理员单次发扣 / 练手盘开仓 / 注册建号一律不登记** ——
    它们的键带随机后缀，登记了也没有去重价值，只会把表撑大。
- **共享单号 `fish_transactions.transfer_id`**：一笔转账的两条流水（发送方 `transfer`
  负 / 接收方 `transfer_receive` 正）写**同一个**值，让收付双方能对上同一笔。
  值 = `sha256(幂等键)[:16]`（**派生**，不是随机）—— 于是同键重放无需额外状态就能
  回报原单的单号，也没有第二份会漂移的副本。**只覆盖用户间转账**：签到 / 投喂 /
  赠送 / 补偿都没有对手方，一律 NULL；存量行不回填（无法可靠反推配对，猜错等于把
  两笔钱认成一笔）。它是对账句柄，不是凭证 —— 本仓**没有**「按单号查一笔转账」的
  接口，所以知道它并不能读到别人的账。见 `prisma/migrations/14_fish_transfer_id` 头部。
- **收银台的 `order` 参数**（`/fish/pay`）：商户给的订单号参与拼幂等键
  （`makeOrderKeyBase` = 收款人哈希 + 订单号，**不含金额**），于是同一订单号永远算出
  同一个键 → 用户付完刷新页面再点不会重复扣款。键里混收款人是为了让「同一付款人给
  两家商户用同一个订单号」不撞车；不含金额是为了让「同单号换金额」响亮地 409，
  而不是静默变成第二笔。**不给 `order` 时退回随机键基**（扫码收款页恒如此，
  那里用户要能在同一页里改金额）。
- **收款回调（webhook）**：`fish-webhook-service.ts` 是 outbox —— 投递行与两条流水
  **同事务**写入，投递在事务外。⚠️ **别因为它与记账无关就把它改简单**：这是本站
  **唯一**允许的跨进程调用，把钱的事务当成 HTTP 的宿主会让商户的延迟占住 SQLite
  写锁。两个 driver：进程内定时器（`src/instrumentation.ts` → `webhook-drainer.ts`）
  与 `fish webhook-retry`，靠条件 UPDATE 认领，不会双投。投递是 **at-least-once**
  （sending 租约到期会重投），所以接收方必须按 `X-Raricy-Delivery` 去重。SSRF 防线
  （本站唯一一处「服务器去 fetch 用户给的地址」）见 `src/lib/webhook-url.ts` 头部。
  端点连续失败**不自动停用** —— 那是静默失效。
- **读路径**：一律读本地 `users.driedFish`（`fish-service.ts` 的 `getBalance` 等），
  页面、接口、CLI 无一例外。**没有第二个存储可以问** —— 账目对不对只能靠内部一致性
  证明，那条不变式是「每人余额 == 他所有流水之和」，测试侧由
  `tests/helpers/fish-ledger.ts` 的 `expectLedgerConsistent()` 钉住，
  任何跑过写路径的用例都应该在末尾调一次。
- **练手盘的「系统水池」是账外的**：开仓是扣用户、平仓是加用户，各自留一条自己的
  流水 —— 没有系统账户这一行。于是「无限水池」表现为**全站鱼干总量的增减**。
  ⚠️ 别为了「复式配平」在 `users` 里虚构一个系统账户行：`FishTransaction.userId`
  是必填外键，那行会长进用户列表与搜索里。**成交价必须在下单那一刻现取**
  （`fetchQuote`），绝不读展示缓存 —— 这条是它唯一的安全边界，展开见 §6.13。

#### 6.3.1 历史注记：这里曾经跨进程（2026-07 ~ 2026-09）

账户逻辑原在一个**站外的 FastAPI 微服务**（独立仓库）里，每条写路径都是三段结构：
`本地事务提交（含 account_sync_ledger 一行 pending）→ 事务外 HTTP 调远端 → 失败则补偿
事务精确撤销本地写入`。读路径当时就已经全在本地，那三个远端读方法只在联调脚本里被
调用过 —— 也就是说它是**只写副本**。撤销它的理由（按力度排序）：

1. **它换来的失败模式结构上修不掉**：远端已成交但响应丢失 → 本地补偿删账 → 用户重试
   拿新键 → 远端扣两次，唯一的发现手段是一条 `FISH_TRANSFER_SYNC_FAILED` 日志；
   投喂的 Step1/Step2/退款三态失败会留下 `ACCOUNT_RECONCILE_REQUIRED`，且**本地被干净
   回滚、账面上看不出异常**。这些不是「少见的 bug」，是「两个存储」的必然产物 ——
   搬进同一个事务不是缓解它们，是让它们不存在。
2. **代价是常驻的**：每次鱼干写都是一次 5s 超时的网络依赖，远端抖动 → 全站鱼干功能
   集体 503；两套部署、两套密钥、两套备份。
3. **「远端才是记账事实」这句话没有兑现成任何工具** —— 唯一收敛手段 `fish sync-retry`
   与对账日志靠人盯，`npm run diagnose` 连 `ACCOUNT_SERVICE_*` 都不检查。

代价是失去一份独立账目副本（≈ 灾备）。它不值钱：鱼干经济与 users / blogs 在**同一个
SQLite 文件**里，只从远端恢复鱼干余额也拼不出站 —— 真正的灾备是那个文件的备份。

**留下的物理痕迹**（都不影响行为，别照字面理解）：

| 痕迹 | 现状 |
|------|------|
| `account_sync_ledger` 表名 | 现在只是**幂等记录**表，新行一律 `status='synced'`。语义以 `fish-idempotency.ts` 头部为准 |
| `users.fish_api_key_encrypted` 列 | 远端签发的用户 API Key 密文。**没有任何代码读它**，列与存量数据留着不删 |
| `FISH_ENCRYPTION_KEY` / `SECRET_KEY` | **仍然必须正确** —— 回调签名密钥的钥匙：写用前者、读带一段回退到后者的过渡期（见 `fish-webhook-service.ts` 的「回调签名密钥的钥匙」）。跑完 `fish webhook-rekey` 之后只剩前者 |
| `docs/bot/fish-bank-example.md` | 站外第三方基于**本站对外接口**开银行的参考实现，与那个被撤销的微服务无关，照旧有效 |

清单与判据见 `docs/legacy-constraints.md` §1.1。

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
| 音频床 | `instance/audio/<id><ext>`（或 `AUDIO_UPLOAD_FOLDER` 覆盖） | `src/lib/audio-upload.ts` — MIME 嗅探 + **无压缩** + 独立配额累计 | `src/app/api/audio/[id]/raw/route.ts`（**带 Range**） |
| 故事 | `instance/stories/<合集>/<故事>.md\|.cattca`（或 `STORIES_DIR` 覆盖） | 服务端直接落盘 | `src/lib/story-service.ts` 服务端 marked |
| 表情包 | `instance/stickers/<合集>/<表情>.{gif,webp,png,jpg,jpeg}`（或 `STICKERS_DIR` 覆盖） | **无上传入口**：站长直接往目录里拷文件 | `src/app/api/stickers/[collection]/[name]/route.ts`（查扫盘 manifest，见 `src/lib/sticker-service.ts`） |
| 头像框 | `public/static/frames/<key>.png`（或 `FRAMES_DIR` 覆盖，**平铺一层、只认 PNG**） | **随代码入库**：它是我们自己画的（源码 = `scripts/make-frame-demos.mjs`），所以**不在**上面那个 `instance/` 底盘里 —— 见本节末与 §6.14 | `src/app/api/frames/[key]/route.ts`（查扫盘 manifest，见 `src/lib/frame-service.ts`） |

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

头像框那一栏与表情包**看着像、关键处相反**，别照抄那边的直觉：

- **key 空间在白名单里，目录只提供字节**。表情是「目录即 key 空间」（往里丢什么就有
  什么），框不是：权威是 `frame-refs.ts` 的 `FRAME_KEYS`（源码常量）。所以目录里多出来
  的文件**一律不被收编**，而目录缺席只让框**不显示**，不会让框不存在 —— 授权、展示名
  照常，缺的只是那张图。
- **只认 PNG**。框靠**透明通道**工作（中间那块必须透出头像），JPEG 没有 alpha、
  GIF 的 1 位透明度边缘全是锯齿。收窄到 PNG 顺带把 SVG 那条 XSS 路径关在外面
  （`ALLOWED_FRAME_MIME` 只有 `image/png`，路由仍按字节复核）。
- **key 先过白名单，才谈得上拼路径**。与表情的「只当 map 的 key、永不拼路径」是同一
  条安全来源，只是这里多了一层「白名单本身就是手写常量」的保证。

#### 已知限制：配额与落盘不是原子的（图床 / 音频床共有）

两条上传链（`image-upload` / `audio-upload` 的上层路由）都是「读用量 → 判配额 →
写盘 → 落库」，**四步之间没有互斥**。后果两条，都是**我们接受**的：

- **并发可越过配额**：同一账号并发发 N 个请求时，每个都读到同一份旧用量、于是全部
  通过 —— 越额量由并发度决定，不是无界的。再叠加「软删即释放配额、但磁盘文件保留」
  这条既定政策，反复「传满 → 软删」就能把占用堆上去。**限频（图床/音频床各 200/时）
  不拦并发**，只是把速率压住。
- **两个方向都会留下不一致**：写盘成功而落库失败 → 孤儿文件（不进配额、不进统计、
  硬删也够不到，因为没有 id）；硬删时先 `unlink` 再删行失败 → 行在文件没了
  （raw 永久 404，配额照占）。

为什么不修：真正的修法要给「读-判-写」加一层互斥（进程内互斥量，或一条
`INSERT ... SELECT WHERE sum(...) < quota` 的条件插入），那是**两个存储域共用**
的改动，动的是配额内核；而这两条的影响面是「core+ 用户能占更多磁盘」，不是错账、
不是越权、也不是静默丢数据。**运维的观察口**：`admin-stats-service.getSiteStats`
与 `cli stats` 报的是**含已软删的全行口径**，那才是磁盘上的真实占用
（页面上那个数只算未软删 —— 两个口径刻意不同，别互相替换）。

### 6.7 Markdown / 内容渲染

| 场景 | 渲染方式 | 管线 |
|------|---------|------|
| 讨论正文 / 评论正文 | **客户端**渲染，同一套管线 | `rich-text.ts`（marked → DOMPurify → 后处理），白名单与链接类名见 `chat-markdown.ts` / `comment-markdown.ts` |
| 博客正文 | **客户端**渲染 | `src/app/components/MarkdownRenderer.tsx`（marked + DOMPurify + highlight.js + MathJax + `[@…]` 内容引用） |
| 故事正文 | **服务端**渲染 | `src/lib/story-service.ts` 的 `marked` + `stripScripts`。内容由站长直接写在 `instance/stories/`，按可信输入处理，**不走 DOMPurify / highlight.js** |
| 内容引用 `[@…]` | 浏览器渲染时正则替换为剪贴板/投票/图床/收藏夹组件 | `src/app/components/MarkdownRenderer.tsx` 的 `ContentRefProcessor`（按 id 长度分流：6 位收藏夹 / 8 位剪贴板 / 9 位投票 / 10 位图床）。**表情包不在这条管道上**。**展开到哪一档看 `contentRefs`**（成员 `'expand'` / 对外 `'external'`，见 §7.3）。两次替换都**按区间切片**、不按内容 `replace`；分流扫的是**盖过码**的副本，所以代码块里的引用一律不展开（指南对读者的承诺）。收藏夹卡片是在主循环**之后**单独一趟，理由见 §6.10 |
| 表情包 `[@合集/表情]` | 浏览器渲染时替换为内联 `<img>`（**仅评论 / 讨论**）。两个来源共用这条管道：站长放的图片（`/api/stickers/` 字节路由）与**内置黄脸**（`/static/emoji/` 静态素材）—— 后者多叠一个 `rich-emoji-ref` 类把自己压成文字大小 | `src/lib/sticker-refs.ts` 的 `embedStickerRefs`，在 `rich-text.ts` 里紧跟 `embedUserRefs` 之后调用；黄脸清单在 `src/lib/emoji-faces.ts` |
| 音频 `[@音频/<ID>]` | 浏览器渲染时替换为内联 `<audio controls>`。**两条管线走法不同**：评论 / 讨论在**净化后**建 DOM（那边白名单里没有 audio）；博客在**源文**上直接拼标签串（那边白名单本来就允许 audio），但必须配 `maskMarkdownCode` —— 否则代码块里会嵌出真播放器。一条正文最多展开 3 个 | `src/lib/audio-refs.ts` 的 `embedAudioRefs`（DOM）/ `collectAudioRefs` + `replaceAudioRefs`（源文）。`音频` 是**保留合集名**（表情那条正则带 `(?!用户/)(?!音频/)` 让开），见 §6.15 |
| 用户名片 `[@用户/<用户名>]` | 浏览器渲染时替换为一枚**行内名片**（`<a>` 包住「带头像框的头像 + 用户名」，指向 `/u/<id>`）（**仅评论 / 讨论**）。认的是**用户名**而不是 ID，所以多一条异步取数；**不算 @ 提及**，不发通知 | `src/lib/user-refs.ts` 的 `embedUserRefs`（纯逻辑 + DOM 构造），数据由 `src/app/components/useUserCards.ts` 经 `RichTextContext` 注入，取数口是 `GET /api/users/<用户名>`（要 core+）。`用户` 因此是**保留合集名**（表情那条正则带 `(?!用户/)` 让开） |
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

**名片那一趟要外挂数据，所以管线多了一个「上下文」参数**（`RichTextContext`）。
异步取数留在 React 层（理由与剪贴板那条相同，见 `useResolvedContent.ts` 的文件头），
`RichContentBody` 用 `useUserCards` 取到之后递进 `render(content, ctx)`。
⚠️ 由此带来一条**必须记住的缓存旁路**：正文里含名片 token 时**不进渲染缓存** ——
缓存以正文为键，而名片数据会变（换头像框、框到期），同一条正文在数据到达前后是两份
不同的 HTML，走缓存会把第二份吃掉，症状是「名片永远不出现」且不报错。
判据是 `USER_REF_PROBE.test(content)`，见 `rich-text.ts`。

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
2. 可见性**不扫描正文**。作者自己写下的文字就是他自己公开的；正文里的 `[@…]` 引用
   展开**到哪一档**由「该引用的读口匿名取不取得到」决定（见 §7.3 的 `contentRefs`）：
   图床图片 / 音频 / **公开档剪贴板**会出得来，投票与收藏夹保留字面量。
   ⚠️ 私有资源仍然出不去 —— 图床与音频的 raw 路由对匿名逐条判档（私有档 404），
   剪贴板的私有档在服务端就被筛掉（`resolvePublicClipRefs`）。
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

**这不是交易所，也不是庄家对赌**：没有撮合、没有对手盘、没有敞口。所谓「无限水池」
**是账外的、不是一行账户** —— 用户赚了就是凭空加进他的余额、亏了就是少发给他，
「水池」只表现为**全站鱼干总量的增减**。因此持仓流水 `related_user_id` 留空、
信息进 `description`（与签到同款）。
⚠️ **别为了「复式配平」在 `users` 里虚构一个系统账户行**：`FishTransaction.userId`
是必填外键，那行会长进用户列表与搜索里，成为一个谁都没打算给它的「用户」。
（历史上确实有过一行 `raricy-blog-system`，它在站外的账户微服务里，随 §6.3.1 一起消失。）

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
  与成交无关。页面自己也有轮询（1 秒；隐藏标签页不轮、回前台先补一次）。
  ⚠️ **那份缓存（含 K 线）住在 `globalThis` 上，别改回模块级变量。** Next 把
  `instrumentation.ts` 编进**独立的 webpack compilation**，`market-price.ts` 因此
  在同一份产物里存在**两份模块实例**（实测：`chunks/7345.js` 的 module 7345 是轮询器
  那份、`chunks/5856.js` 的 module 25198 是页面与三个接口那份；模块 id 不同，共享
  runtime 的模块缓存于是不会去重）。模块级变量会让「轮询器每 15 秒刷自己那一份、
  请求处理读另一份」，而 `getCachedQuotes()` 只在缓存为空时才去拉一次 —— 页面上那个价
  **从第一次渲染起永远不再变，且不报任何错**（2026-09 实际发生过：站长盯着一个冻住的
  页面半小时，同期 BTC 振幅 0.47%）。见 `src/lib/market-price.ts` 头部，
  回归测试见 `tests/unit/market-price.test.ts` 的「缓存跨模块实例共享」。
- **实时行情流**：`market-stream.ts` 是一条**常驻 WebSocket**（本站**第三个**后台循环），
  订币安的 `@trade`（与成交同口径：都是最新成交价），把价写进上面那份共享缓存里的
  `stream` 字段 —— 与 REST 那份**平级**，因为 `refreshQuotes()` 是整份覆盖写。
  读侧 `getCachedQuotes()` 逐标的挑：帧还在 `STREAM_TRUST_MS`（10 秒）之内就用它，
  否则回落到轮询那份。实测依据（2026-09-22 生产机 10 分钟）：0 重连、53828 tick、
  **合计**最长静默 0.9s、事件时间差 30~54ms（对照 REST 一次往返 402ms）。
  - ⚠️ **半死判据盯「合计」静默，不是单标的** —— 同一次实测里 BTC 自己冷清过 3.5 秒，
    按单标的判会白重连。
  - ⚠️ **握手失败时 node 内置 WebSocket 只报 error 不发 close**（域被黑洞时连 error
    都不来）→ 所有下线路径走 `onDown()`，另有 1 秒看门狗兜底。别只挂 `onclose`。
  - **三道闸门**：`NODE_ENV === 'test'` / `MARKET_STREAM_SILENCE_MS=0`（运维开关）/
    本进程没有全局 WebSocket（Node 20）时打一行日志后优雅退化。e2e 与 vitest 都要关
    （理由与另两个循环同款，e2e 那份在 `playwright.config.ts` 的 webServer env 里）。
  - **它只喂展示**：成交仍然 `fetchQuote()` 现取。`tests/unit/market-price.test.ts`
    有一条专门钉「流里有价也不许拿来成交」。
- **结算**：`payoutUnits = floor(stakeUnits × 平仓价 / 开仓价 × (1 − MARKET_FEE_RATE))`。
  `floor` 是刻意的 —— 舍入永远朝系统一侧，宁可少发一个单位也不凭空多铸。手续费
  **只在平仓侧收一次**（开仓免费、持有免费）。最小投入 1 条鱼干。
  **存储精度是这套结算的关键参数**：`floor` 每次都朝系统丢零头，而零头的上界就是
  存储的最小刻度。刻度还是 0.1 条时，投 0.1 条（= 1 个单位）的仓位只要价格不涨过
  0.1% 就必然结算成 0 —— 那不是高风险而是几乎必赔的陷阱。2026-09 把刻度提到 0.0001 条
  （迁移 `21_fish_units_1e4`）之后零头上界降到 0.0001 条，**同一笔结算少丢 1000 倍**：
  投 1 条、涨 0.05% 时实发从 0.9 条（亏 0.1）变成 0.9994 条（亏 0.0006）。
  「最小投入 1 条」这条下限**不再由舍入陷阱支撑**（理由见 `market-service.ts` 的
  `MIN_STAKE_FISH` 注释），它现在只剩产品理由。
- **结算公式只有一份实现**：`src/lib/market-math.ts` 的 `settleClose` —— 服务端真结算
  （写 `payout_units` 与流水）与页面上那屏「卖出细则」（涨跌幅 / 毛额 / 手续费 / 盈亏 /
  预计到手）import 的是同一个函数。它是零依赖模块 —— 页面是客户端组件，而
  `market-service.ts` 拖着 prisma 进不了客户端包（同 `blog-visibility.ts` 的做法）。
  ⚠️ **别在页面里另抄一份公式**：两份必然 drift，而用户是看着「预计到手」按下确认的，
  偏差又是静默的。e2e 有一条钉「弹窗上那个数 == 真到账的那个数」。
  弹窗里那几个数还**加得起来**（毛额 − 手续费 = 到手、到手 − 投入 = 盈亏），所以
  「手续费」这一栏含 floor 扔掉的零头（上界一个存储单位）—— 那是给用户看的账，
  不是给对账看的。行情取不到时整组显示「—」，**不显示 0**。
- **一行 = 一个批次（lot）**，不是聚合持仓。每次开仓插一行，平仓就地改成 `closed` ——
  部分平仓会把幂等做成一件难事（同一请求重放时要认出「这是同一笔」而不是「又一次部分
  平仓」）。**绝不物理删除**，没有例外（唯一一处例外曾是「远端同步失败的补偿事务」，
  随 §6.3.1 一起消失）。
- **幂等**：开仓靠 `market_positions.open_key` 的**唯一约束**（每次唯一；调用方给了客户端键
  就按它派生、否则服务端现生成；混进 `userId` 哈希避免两个用户撞键）。重放时按 `open_key`
  回读既有仓位 —— **这一列就是幂等的实现**，所以开仓不另写 `account_sync_ledger` 行
  （判据见 `src/lib/fish-idempotency.ts` 头部）。
  平仓靠 `status` 的条件写天然幂等，不需要键。实发为 0 时**不写流水**（没有钱动过）——
  ⚠️ 这一档必须显式守着：内核 `postEntry` 对 `units === 0` 是抛错的，漏了会让合法的
  「近乎归零」变成 500。
- **限频**：`RULES.tradeMinute` / `tradeDaily`（20/分、300/天）。它防的不是刷屏，是
  **出站流量**（每笔成交都要现取一次行情）+ 写压力。桶键 `trade:` 前缀，不复用 `transfer:`。
- **禁言判定是「不对称」的，别统一**：档位（core+）在页面 / `buy` / `sell` / `quote` 四处
  各判一次，**禁言只有 `buy` 判** —— `sell` 与 `quote` 不判。禁言是「不能说话」，若在 sell
  上也判，用户手上**已经开着的**仓位就一股也卖不掉，只能看着浮亏扩大（而且禁言会递增
  `sessionVersion` 废掉旧会话、重新登录也一样）——那等于把禁言变成锁仓。代价是禁言用户
  仍能兑现已有仓位的浮盈，那是「能出仓」的另一面，不是漏洞。理由写在
  `src/app/api/fish/trade/sell/route.ts` 头部。
- 页面的行情卡在拉不到价时显示「行情暂不可用」并**禁掉买入**；缓存超龄时显示「数据可能
  不是最新的」。**绝不编一个价出来** —— 用户会照着一个假价格按下买入。

### 6.14 头像框

一张**带透明通道的 PNG**，绝对定位叠在头像上（`src/app/components/Avatar.tsx`
的 `.avatar__frame`）。全站 16 个文件 21 处头像都走那个组件 —— 落点台账与静态守卫
在 `tests/unit/avatar-sites-guard.test.ts`。

#### 两层：持有 vs 装备

| | 表 / 列 | 谁说了算 |
|---|---|---|
| **持有** | `user_frames`（一行 = 一款框） | 站长发放（`npm run cli -- frame grant/revoke`，见 `docs/cli.md`）**或用户自己租**（鱼干商城，见本节末） |
| **装备** | `users.equipped_frame_key` + `equipped_frame_expires_at` | 用户自己。`/settings` 的装备面板 |

一个用户可以同时持有多款、只戴一款；也可以持有却不戴。**授予 ≠ 装备**。

#### 装备态为什么是 users 上的两个冗余列

15 处渲染点里 **8 处的数据来自一条已经在读 users 行的查询**（博客作者 / 讨论作者 /
讨论对方 / 签到榜 / 后台用户卡片 / 转账收款人）。加列 = 同一个查询里加两个 select
字段，**零 join、零额外往返**。写成 1:1 表则每处都要 `include`，而 `chat-service`
是**按消息批量**取作者的（要么 N+1，要么再加一次批量查询）。

**漏加的后果不是报错，是那一处永远没有框** —— 静默。取舍的完整论证在
`prisma/migrations/20_user_frames/migration.sql` 头部。

#### ★ 到期只有一处判，客户端一次都不判

```
frame-refs.resolveFrameKey(key, exp, now)   ← 唯一的比较运算（纯函数，now 由调用方给）
         ↓
frame-service.frameUrlFor(row)              ← 唯一出口：白名单 → 未退役 → 未过期 → 盘上有图
         ↓
service 层的各 DTO（下发 frame_url / frameUrl 字符串）
         ↓
客户端（16 个文件）—— 不做任何时间比较
```

- `frameUrlFor` 内部固定用 `nowForDb()`，**不接受 now 参数**（少一个传错的机会）。
- **到期是只读判定**：过期的值留在列里无害（判定恒 null），所以**没有 cron、没有
  清理任务、没有「读时顺手清一下」** —— 少一条静默失效路径。想让某人下周失效，
  用 `frame grant --days 7`，别用 revoke。
- 客户端判零次不只是纪律：`tests/unit/db-time-guard.test.ts` 规则 3–5 扫**整个 `src/`**
  （含页面组件），在那里写 `new Date(expires_at) > new Date()` 会被静态守卫判红。
- 渲染层**不许读** `equipped_frame_key` 那两个原始列（它们在 `SafeUser` 上一直存在，
  直接读是完全合法的代码 —— 但没判到期）。由 `tests/unit/frame-guard.test.ts` 拦着。

#### 五条不变量（`src/lib/frame-service.ts` 文件头）

| | |
|---|---|
| **F1 唯一写入者** | users 那两列只由 `grantFrameTx` / `grantFrame` / `revokeFrame` / `equipFrame` 写（**都在 `frame-service.ts`**）。别的文件要动这两列时，往那个文件里加一个 `…Tx(tx, …)` 内核，别在外面自己写 —— 商城走的正是 `grantFrameTx` |
| **F2 同步契约** | 改持有行的 `expires_at` 时，若他正戴着这个框，**同一事务里**刷新装备列的副本。违反 = 续期后**框永远不出现**（看起来像浏览器缓存）—— 这是本设计最隐蔽的一条 |
| **F3 装备前置** | 要 alive 持有行 + 未过期 + 白名单 + 未退役；**但素材缺失不阻止装备**（先授权后传素材是合法顺序）。卸下**无条件成功** —— 否则退役的 key 会变成摘不掉的僵尸 |
| **F4 唯一约束含墓碑** | 收回后再授予必须**复活旧行**，不能新插（会撞唯一约束） |
| **F5 永不物删** | 到期 ≠ 撤销：过期只让行失效，`deleted` 仍是 false |

#### 素材与安全

- key 的权威是 `src/lib/frame-refs.ts` 的 `FRAME_KEYS`（源码白名单），
  `public/static/frames/` 只提供字节 —— 见 §6.6 那一段与表情包的对照。
- **素材随代码入库**（2026-09 起）：它是我们自己画的，源码就是
  `scripts/make-frame-demos.mjs`，所以住 `public/static/` 而不是运行时数据目录
  `instance/`。搬家的理由见 §6.6 那张表；代价（改了脚本忘了重跑）与它的守卫
  （`manifest.json` + `tests/unit/frame-assets.test.ts`）见 §10 的风险表。
- 字节路由 `/api/frames/[key]` **按字节**复核 MIME 并只放行 `image/png`
  （`ALLOWED_FRAME_MIME`），拒绝 SVG。**刻意匿名**，已登记进
  `tests/unit/anonymous-read-guard.test.ts` 的台账。
- `Cache-Control: public, max-age=86400`，**刻意不 immutable** —— 换图流程是
  「重跑脚本（或往 `public/static/frames/` 拷一张图）再提交」，
  immutable 会让浏览器一年不来看一眼。
- **退役一个框**：把 `FRAMES[k].retired` 置 true，**不要从 `FRAME_KEYS` 里删** ——
  删了 `parseFrameKey` 就认不出它，面板没法显示那一行，用户**摘不掉**它。

#### 画报暂不画框

`poster.ts` 的 `avatarBlock()` 已有一圈 3px 描边环，框叠上去会双重描边 ——
而画报是**发出去就收不回的分享物**（不可逆），宁可暂时不加。预留接口：给
`avatarBlock()` 加一个可选参数，插在头像 `<image>` 与描边环**之间**。

#### 鱼干商城：用鱼干租头像框

`/fish/market` 的第二块（页面上的「鱼干商城」）。`fishblue` 按 **1 鱼干 / 天**
出租，用户自选 1–30 天。**没有动表** —— `user_frames.source` 早有 `'purchase'`
这个值，框的定义与定价都住 `frame-refs.ts`（零依赖，客户端要读）。

- **价格与在架清单住 `frame-refs.ts`**（`FrameDef.rentPerDay` / `rentableFrameKeys()`）——
  商城面板是客户端组件，而 `frame-service` 拖着 prisma 进不了客户端包。
  放一处，展示与校验**读同一个数**；两边各算一次的话症状是「页面显示 1 鱼干、
  服务端扣 2 条」，而用户只会觉得账不对。
- ★ **原子性**：扣鱼干（`postEntry`）与发框（`grantFrameTx`）在**同一个事务**里。
  为此把授予的事务体抽成 `grantFrameTx(tx, input)`，`grantFrame` 退化成自开事务的
  薄壳。分开写的后果是「钱扣了、框没到」，两边各自的日志都正常。
- ★ **续期从「当前到期」起算**，不是从「现在」。`grantFrameTx` 的口径是
  「只延长不缩短」，传 `now + N 天` 会让一个还剩 20 天的人买 3 天走进 noop 分支
  —— **鱼干照扣、到期一动没动、不报任何错**。这是本功能最容易写错的一处，
  用例里有两条专门钉它。
- **两条拒卖**：素材缺失 → 409（与 F3「素材缺失不阻止装备」不矛盾：F3 管的是站长
  「先授权后传图」，那时用户没花钱；商城是先收钱）；已经永久持有 → 400（永久是
  最大的到期，再买必然算得更短 = 又一次「扣钱不办事」）。
- **不登记幂等**：判据在 `fish-idempotency.ts` —— 键是确定的才登记，而每次点击都是
  一笔新交易（同练手盘开仓）。防重复提交是客户端的事（二次确认 + busy 锁），
  服务端由 `RULES.frameRentHourly/Daily` 兜底。
- **`POST /api/fish/market/rent` 只认会话** —— 它是那个命名空间里唯一不走
  `requireMarketActor` 的路由。第三道门（请求体里的 username + password）是给站外
  脚本的，一旦放行，租金与在架清单就从内部实现变成**对外契约**（改价 = 破坏兼容），
  而机器人租头像框没有真实需求。**默认关门**，将来真需要再加。
  禁言那一道照旧，文案与转账共用一条。
- **到期仍然是懒判定**：租期到了只是 `resolveFrameKey` 判 null，**没有 cron、
  没有清理任务**（同本节上文）。想续，用户自己再租一次 —— 天数叠加在现有到期之后。
- 流水 `type` 是 `frame_rent`（**不是** `purchase` —— 后者在鱼干语境里已经是
  「收银台付款」）。`reference_type='frame'` + `reference_id=<key>`。

### 6.15 音频床（`/audio`）

图床的平行物：同样一份「上传 → 拿 ID → 用 ID」的骨架，`AudioHosting` 与
`ImageHosting` 逐字段同构。**四处刻意不同**，改之前先看：

- **独立配额**。额度值仍取自**同一张** `QUOTA_LIMITS_MB`（core 50 / admin 50 /
  owner 100，不另立第二份数字表），但用量聚合打在 `audio_hosting` 上
  （`audio-service.ts` 的 `getUserUsedAudioBytes`）。传满 50MB 音频不影响图片，反之亦然。
  ⚠️ 因此**运维的磁盘占用要两边相加** —— `admin-stats-service.getSiteStats` 与
  `cli stats` 都分别报「图床占用」与「音频床占用」两行。
- **不转码、不压缩**。图床便宜全靠 sharp；音频要压得动就得引 ffmpeg（本站第一个
  非 npm 的二进制依赖），刻意不引。后果见下面那个配额算术。
- **有 Range**（图床那条没有），见下。
- **不开附件链路**。讨论 / 评论的图片附件走 `ChatMessage.imageId` 那种外键列，
  与托管域是两回事；音频只经 `[@音频/<ID>]` 进正文。将来要做「语音条」那种一等公民
  附件，那是**另一个决定**，别顺手照抄 `image_id`。

**那个配额算术**：单文件 10MB × 总额 50MB ⇒ **一个 core 用户最多存 5 个满额文件**。
这是所选数字的机械后果，不是 bug —— 但它直接决定了正文里的展开预算：
`MAX_AUDIO_REFS = 3`，远小于图片的 50。图片每个引用背后是一次小文件读，音频是
MB 级传输；正文上限 5000 字能塞下几百个引用，按 50 放开就是一条消息放大出几百 MB。

**Range 是硬需求，不是优化**。`/api/audio/[id]/raw` 必须回 `206`：
播放器拖动进度靠它，而 **Safari 会先发 `Range: bytes=0-1` 探测，拿不到 206 直接不播**。
四条实现纪律：

- **不用 `ReadableStream`** —— 仓库里那两处流（`chat/stream`、`notifications/stream`）
  是无界 SSE、**刻意没有 `Content-Length`**，形状正好相反。本路由的直接读那一段字节
  （`fs.open` + `read`）并显式给 `Content-Length`。
- **畸形头一律当「没给」**，回 200 全量。`parseInt` 的 `NaN` 参与的所有比较都是 false，
  会静默落进一个没人定义过的分支（0 字节或全量）—— 所以先过 `^\d+$` 再转换。
- **多段 Range 不做 `multipart/byteranges`**，当全量处理。播放器不用它。
- **`immutable` 只发在 200 上**。发在 206 上会诱使中间缓存拿残段去满足后续的全量请求，
  症状是播放器莫名失败、完全看不出跟缓存有关。

**MIME 别名归一化**（图床没有这一层）：`.m4a` 在三种平台上被报成 `audio/mp4` /
`audio/x-m4a` / `audio/m4a`，Windows 上还可能是空串。`normalizeAudioMime` 把别名折到
规范形，空则按扩展名兜底。⚠️ **归一化只用来补浏览器没给的那格**：之后仍要与
`detectAudioMime` 严格相等，且 `verifyAudioMime` 返回的是**规范形** —— 落库与下发的
`Content-Type` 必须是认过的那个值。**别认 `.mp4` 扩展名**：那是视频容器的通用扩展名，
认了就等于给「传视频」开一条明路。

**格式白名单只有三种**：MP3 / M4A / OGG。不收 WAV 与 FLAC —— WAV 一分钟约 10MB，
正好等于单文件上限，收进来只会给用户一个「传什么都失败」的入口。嗅探有两处比图床严：
MP3 的帧同步要核版本 / 层 / 位速率字段（只判 `0xFF` 打头太松），
**Ogg 首个页里必须出现音频编解码器**（`vorbis` / `OpusHead` / `fLaC`）—— Ogg 是容器，
只认 `OggS` 会把 Theora 视频当音频收进来。

**`[@音频/<ID>]` 与保留合集名**：ID 也是 10 位 base62（与图床同长），走**具名命名空间**
而不是长度分流（见 §8「ID 风格」）。代价是 `音频` 成为**保留合集名** ——
与 `用户` 完全同构的问题：表情那条正则的形状也是 `[@A/B]`。
**两端必须一起改**：`sticker-refs.ts` 的 `RESERVED_CARD_COLLECTIONS` 让开它，
`sticker-service.ts` 的扫盘跳过同名目录。只改一端 = 「面板里挑得出、一渲染却变成播放器」。

**两条管线的接入方式不同，别互相照抄**：

| 管线 | 走法 | 为什么 |
|------|------|--------|
| 评论 / 讨论（`rich-text.ts`） | 净化**后**建 DOM（`createElement` + `setAttribute`） | 白名单里**没有 audio**（与没有 img 同理）——放开白名单等于给任意外链播放器开口子 |
| 博客（`MarkdownRenderer.tsx`） | **源文**上直接拼标签串，单独一趟放最末、按区间切片 | `BLOG_SANITIZE_OPTIONS` 本来就允许 `audio`/`controls`/`preload`（一行代码都没用过） |

⚠️ 博客那一趟**必须配 `maskMarkdownCode`**：源文阶段没有 DOM、跳过不了 `CODE`/`PRE`，
不盖码块就会在 `<code>` 里嵌出一个**真播放器**（而 audio 在白名单里，DOMPurify 不会拦）。
这是博客侧最可能的静默错误。src 由我们用校验过的 ID 拼成，**永不接受用户提供的 URL**。

⚠️ **博客正文的两种视图都展开音频**（成员 `'expand'` / 对外 `'external'`，见 §7.3）——
音频字节路由匿名可取，与图床同性质，所以《音频床使用指南》的 FAQ 里那句「设为对外可见，
读到那篇的人就都能听到」才成立。**别把音频归进「要 core+ 的那三种引用」**。

⚠️ 那个「空集早退」曾经把音频整趟吞掉：分流正则 `\[@\s*(\w+)\s*\]` 的 `\w` **匹配不到
中文**，所以「正文里只有音频引用」的正文一个 match 都没有 → `preprocess` 直接返回原文
→ 只贴了一段录音的文章什么都不展开，**且不报错**。现在音频那趟在早退**之前**先跑。

> ⚠️ 顺带一个**既有**事实（不是本次引入的）：`BLOG_SANITIZE_OPTIONS` 早就允许
> `audio`/`source`/`track`/`controls`/`autoplay`。也就是说 core+ 作者今天就能在博客里
> 手写 `<audio src="外链">`。**别顺手删那几个白名单项** —— 博客正文存在库里不在仓库里，
> grep 仓库证明不了没有存量文章在用。

**入口**：工具箱（`/tool`）→「站务工具」区的「音频床」卡片，**与图床并列**。
与图床同款**不设 `coreOnly`**（页面自身 `requireCoreUser`，档位不够是就地 403）——
与 §6.10 收藏夹那条同口径，改这里之前先看过去。

---

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
  → feed-service.ts 一个事务：
        投喂者扣款（postEntry，条件谓词防超扣）
        作者分成 +80%（postEntry）
        BlogFeed 累计 + Blog.fishCount
  → COMMIT
  → 通知作者（提交之后才发，失败只 warn，不影响已成交的钱）
  → 响应 200
       ├ 余额不足 / 超上限 → 400（业务结果）
       └ 事务失败          → 500（真故障）
```

⚠️ **这里没有 503 这一档**。它曾经是「远端账户服务不可达」的专用码，随账户服务搬进
站内一起消失（历史注记见 §6.3.1）。**别的鱼干路径也都一样**：转账 / 签到翻牌 /
练手盘 / CLI 发扣全是「一个事务 + 400 或 500」。对外文档里凡教调用方
「看到 503 就重试一次」的地方都已改写 —— 那些重试建议的前提（本地已被补偿回滚）
不存在了。

> 例外只有注册（`user-service.ts`）：它的两处**通用故障兜底**仍返回 503
> （`registerUser` 的未知 precondition、`mapCreateFailure` 的 `unexpected`）。
> 那是错误码选择问题，与账户服务无关，改它会连带动 CLI `user create` 的
> 退出码映射（`docs/cli.md` 有口径）—— **本轮的契约变更不覆盖它**，
> 别看到「没有 503 了」就顺手改掉。

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
       访客 → **只有**标题 / 作者 / 正文（contentRefs='external'），零站内 affordance
              + resolvePublicClipRefs(正文) 的结果当 externalClips 一起下发
  → 客户端 marked + DOMPurify + highlight.js 完成正文
```

⚠️ **原始 markdown 是作为 RSC prop 随首屏 payload 下发的** —— 「正文交给客户端渲染」
不构成任何保护，闸门必须在服务端把串传出去之前（`docs/architecture.md` §6.7 那条管线）。
对外视图那句 `resolvePublicClipRefs` 同理：**判档在服务端做完**，下发的只有判过的内容。

⚠️ `MarkdownRenderer` 的 `contentRefs` 是**必传** prop，两个取值都展开引用，差别在
**展开到哪一档**：

| 取值 | 用在哪 | 剪贴板 | 投票 | 图床 | 收藏夹 | 音频 |
|------|--------|--------|------|------|--------|------|
| `'expand'` | core+ 的页面（成员视图 / 剪贴板详情） | ✅ 客户端带凭据拉 | ✅ | ✅ | ✅ | ✅ |
| `'external'` | 对外视图（访客 / 非 core） | 只出**服务端下发**的公开档 | ❌ 字面量 | ✅ | ❌ 字面量 | ✅ |

判据不是「是不是站内内容」，而是**这条引用的读口匿名取不取得到**：图床与音频的字节
路由匿名可达、逐条判档（私有档对无权者 404）；剪贴板 / 投票 / 收藏夹的三条接口一律
要 core+ 会话。`'external'` **一个请求都不发**（所以它不需要凭据，也拿不到 401）。
⚠️ 别把它缩回「一律不展开」——「作者把文章设为对外可见，读到的人却看不到正文里的
图和录音」正是被修掉的那版行为；也别忘了**私有资源仍然出不去**（见 §6.11 风险 2）。

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
| `AudioHosting.ignore` | false | 音频床（软删后磁盘文件保留；站长可在管理端硬删，见 §6.15） |
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
| `DELETE /api/images/:id` · `/api/audio/:id` | core+ | 作者本人或管理员（**一律软删**，站长也走这条） |
| `DELETE /api/images/admin/:id` · `/api/audio/admin/:id` | owner | ——（硬删只有这一条路径） |

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
| Vote · ImageHosting · AudioHosting | 短 ID：**base62**（9 位 / 10 位 / 10 位） |
| Favorite | UUID4（所有者管理页的路由参数；不可枚举，见 §6.10）＋ 可选 `publicId`：**6 位纯数字**，**仅公开收藏夹有值** |
| FavoriteItem | 自增整数（join 行） |
| Category · AdminActionLog · AdminActionAppeal · UserBan | 自增整数 |

> 各 ID 的**长度**互不重叠是**有意的**：`[@…]` 引用语法只按长度分流，6 位是收藏夹、
> 8 位剪贴板、9 位投票、10 位图床。新增任何「会出现在正文引用里的 ID」都要先确认
> 长度没被占用（博客是 UUID、含连字符，根本进不了那条正则）。
>
> ⚠️ **音频床是那条不变式的第一个例外，且是刻意例外**：它的 ID 也是 10 位 base62，
> 与图床**同长**。它不走长度分流，而是取了**具名命名空间** `[@音频/<ID>]` ——
> 长度早被占满（6/8/9/10/12 加 UUID），再去挤一个既没空位、也不如名字可读。
> 代价是 `音频` 成了**保留合集名**（与 `用户` 同构的问题，见 §6.7 与
> `sticker-refs.ts` 的 RESERVED_CARD_COLLECTION）。**下一个新增引用语法照这个走**：
> 能起名字就别抢长度。

## 9. 迁移史速查

| 阶段 | 状态 |
|------|------|
| Flask 单体（blog+story+clipboard+vote+fish+...） | 已被本分支 `git rm` 删除，git 历史可回看 |
| Flask → Next 分阶段迁移（每模块独立 commit） | 已合并；本分支 commit 全是 Next |
| 鱼干账户微服务拆分（Phase 1/1.5/2） | 已**撤销**（2026-09）：账户服务搬回站内，见 §6.3.1 |
| 鱼干存储精度 0.1 → 0.0001 条（迁移 `21_fish_units_1e4`，五列 ×1000） | 已应用（2026-09）：练手盘 `floor` 的损耗降 1000 倍，见 §6.13 |
| 音频床落库表（迁移 `22_audio_hosting`，新表一张） | 已应用（2026-09）：**不含数据变换**，见 §6.15 |
| schema 演进路径 | Alembic 31 版删除；Prisma 0_init 基线接管 |

## 10. 风险与已知限制

| 风险 | 影响 | 缓解 |
|------|------|------|
| SQLite 库级写锁 | 高并发写会互相 `database is locked` | 长期建议迁 Postgres（届时去 `DATABASE_URL` 的 `connection_limit/socket_timeout`） |
| 进程内限频 | 多实例下各自计数，总限翻倍 | 多实例前先换 Redis |
| 进程内「在看」状态（`chat-presence.ts`） | 多实例下「谁在看哪个会话」的报到与发消息可能落在不同实例 → 判不出在看 | 退化成照常发 @ 通知（多打扰一次，**不静默丢**），与进程内限频同一类已知限制 |
| `instance/` 在部署机器 | 需挂载真实目录否则上传 500 | 部署脚本里 `node scripts/check-instance.mjs` 兜底 |
| 初次部署既有库 | 存量回调签名密钥（`fish_webhook_endpoints.secret_encrypted`）是 `SECRET_KEY` 封的：**跳过 `fish webhook-rekey` 就轮换 `SECRET_KEY`** → 商户再也收不到通知，且**不可逆**（密文没坏、只是没了钥匙） | `npm run diagnose` 段 4 逐条报「钥匙对不对 / 还剩几条没搬」；迁移命令 `fish webhook-rekey` 逐行判状态、可重复跑 |
| 账目**没有第二个存储可以核对**（账户服务搬进站内后，`users.driedFish` 是唯一真源） | 有人改了余额却漏写流水这类静默损坏，没有外部的复式账本会替你发现 | 记账只走 `postEntry` 一扇门；不变式「每人余额 == 他所有流水之和」由 `tests/helpers/fish-ledger.ts` 的 `expectLedgerConsistent()` 钉着，写路径的用例都调它 |
| **某一个 key 的 PNG 缺失**（git 里被删了、`FRAMES_DIR` 指到了别处、或某次部署漏了 `public/static/frames/`） | 那个框**全站静默不显示** —— 而「框不显示」与「没发过框」在页面上长得一模一样，页面不报任何错 | 渲染侧由 `frame-service` 的第三道闸降级成「干净的不显示」而不是 15 处破图；运维侧 `npm run cli -- frame list --keys` 是唯一能主动发现的地方（`frame grant` 成功时也会顺手体检并打黄色警告）。**素材 2026-09 起随代码入库**（原先要手工拷到服务器，那是个没有报错的部署步骤），所以这条风险现在只剩「git 里少了」与「指错了目录」两种 |
| **改了出图脚本却忘了重跑**（素材入库**新引入**的失效：原先素材不在库里，非跑脚本不可，这件事不可能发生） | 站点继续显示**旧图**，不报错、不 500、日志里什么都没有 —— 只有人眼盯着那个框才看得出来 | 出图脚本把「生成这一刻」写进 `public/static/frames/manifest.json`（脚本自身 + 每张产物的 sha256），`tests/unit/frame-assets.test.ts` 逐条核对，报错里给出该跑哪条命令 |
| 反代改写了 `Host` 且未透传 `X-Forwarded-Host` | 浏览器 `Origin` 与三个来源都对不上 → 全站 POST 403（CSRF 误杀）。nginx 默认就把 `Host` 设成 `$proxy_host`（upstream 地址），所以**两个头都要显式透传** | `ALLOWED_ORIGINS="你的域名"` 兜底或修 nginx |

---

## 11. 推荐阅读

- `docs/deploy.md` — 部署 / 运行 / nginx / systemd
- `docs/cli.md` — 运维 CLI 命令
- `../CLAUDE.md` — 关键约定（约束与反直觉决策）
- 内容/玩法文档：`docs/guide/` —— 玩家与创作者文档（cattca / 云剪贴板 / 图床 / 投票箱 / story）
