# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 项目概述

raricy.com（聪明山）—— 个人博客 / 故事 / 工具集 / 剪贴板 / 图床 / 投票 / 游戏。

- **Next.js 15** App Router + React 19 + TypeScript
- **Prisma 6** 直连 SQLite（`file:../instance/database/db.db`）
- **JWT** 会话 + `session_version` 失效机制（对齐旧 Flask-Login）
- **FastAPI 账户微服务** 独立仓库部署，本仓通过 HTTP 调用
- **迁移走手写 SQL**（**不要用 `prisma migrate`**）—— 详见下面「数据库迁移」

历史架构是 Flask 单体（2026-07 之前），已被替换，源码已在 git 历史中删除。**不要修改或恢复任何 Flask 代码**。`src/` 里仍留有「对齐 Flask `@authenticated_required`」这类注释——那是给权限档位留的对照说明，不是待恢复的代码。

## 常用命令

常用命令见 `README.md`「工具脚本」（那是精选，**不是全表**）；完整列表以 `package.json`
的 `scripts` 为准。这里只列**不显然**的几条：

- `npm ci`，不要 `npm install` —— 前者严格按 lockfile 安装，后者可能在 semver 范围内改写
  lockfile 把依赖漂到更新的小版本。**真正会炸的是手动 `npm install next@latest`**：跨大版本
  装到 Next 16 后启动即崩（`TypeError: Cannot read properties of undefined (reading 'map')`，
  报错还指向 ignore-listed frames，完全看不出根因 —— 线上实际发生过）。
  `package.json` 的 `^15.1.4` 本身到不了 16.x；`npm run diagnose` 段 0 会校验已装版本与声明同大版本。
- `npm run e2e` **不**自动 build，跑的是 `.next` 里的现有产物。改了 `src/` 没重新 build
  的话，测的是旧代码 —— 症状是刚加的日志一行都不打，容易误判成代码没生效。用 `npm run e2e:ci` 或先 build。
- `npx tsc --noEmit` **会读 `.next/types/`**（tsconfig 的 include 里有它）。所以它与上一条
  同源：`.next` 过期时，tsc 会对**早就删掉的路由**报 `Cannot find module '.../page.js'`。
  实测过 4 条指向已删除的 `photowall` 路由的幻影错误，跑一次 `npm run build` 后自行消失。
  看到「模块不存在」先 `npm run build`，别去翻源码找那个路由。
  另注：`npm ci` 会连生成的 Prisma client 一起清掉（`postinstall` 不跑 `prisma generate`），
  装完依赖若满屏 `Prisma has no exported member`，补一次 `npx prisma generate`。
- `npm run cli` —— 运维台。**不带参数在 TTY 下进菜单向导**（引导式，不用背命令）；
  `npm run cli -- <cmd>` 是命令式，给脚本/CI。见 `docs/cli.md`。
  加命令只改 `scripts/cli/registry.ts` 的注册表 —— `--help` 与向导都由它生成，
  `wizard.ts` 不用动。三条守卫盯着：注册表完整性、`--help` 不加载 Prisma、
  `docs/cli.md` 必须覆盖每条命令（`tests/unit/cli-{registry,guards,docs}.test.ts`）。

## 关键约定

### 数据与时间
- 数据库走 SQLite 单进程；高并发写长期建议迁 Postgres。
- 时间戳是 **INTEGER 毫秒**，但语义是「**UTC+8 墙上时间贴 Z 标签**」，**不是真实 UTC 瞬间**（Flask `datetime.now()` 的历史遗留）。取当前时刻一律用 `nowForDb()`（`src/lib/db-time.ts`）；「还剩多久」用 `hoursUntil()`；展示一律 `ymd`/`ymdhms`（`src/lib/format.ts`）或 `getUTC*`。**禁止无参 `new Date()`、`new Date(Date.now(...))`、与 `Date.now()` 相减、`toLocale*`、本地 getter（`getHours` 等）** —— 混用两把钟的后果**全是静默的**（禁言多显示 8 小时、当日发文计数跨日错位）。由 `tests/unit/db-time-guard.test.ts` 五条静态守卫强制（规则 1–2 只扫服务端：src/lib、src/app/api、middleware、tests/helpers —— 纯客户端计时器用 `new Date()` 是合法的；规则 3–5 扫整个 src/）。
- 密码哈希与历史 werkzeug **双向互通**——用户**无需重设密码**。
- 鱼干密钥派生：`SECRET_KEY` 是派生源；`FISH_ENCRYPTION_KEY` 仅全新部署时填。
- **鱼干存储单位 = 0.1 鱼干（整数）**（Float 时代已整数化，迁移 `3_fish_integer_units` 数据 ×10）。换算只在数据库边界：`src/lib/fish-units.ts` 的 `fishToUnits/unitsToFish`；业务层（服务入参/返回、DTO、前端）一律「鱼干」，最多 1 位小数。`fishToUnits` 拒绝超精度值（fail-loud）。SQLite 列保持 REAL 亲和但值全为整数（`prisma db pull` 会显示 Float，以 schema 注释为准）。`Blog.fishCount` 例外——它本来就是鱼干整数口径，无需换算。

### 认证与角色
- 角色：`user` → `core` → `admin` → `owner`
- `core+` 通过邀请码升级，注册时填邀请码即升。
- 会话 cookie：`HttpOnly`，`Secure` 由 `X-Forwarded-Proto` 自动判定（不走 nginx 时显式设 `COOKIE_SECURE`）。
- 站长的「针对自己的申诉」不由自己裁决——`adjudicate` 要求目标用户 ≠ 当前用户。
  **闸门在 service 层**（`src/lib/admin-appeal-service.ts`），网页与运维 CLI 共用同一条
  `adjudicate`，所以一处即覆盖两者。此前这句只写在文档里、代码里没有实现（已补）。
- **OAuth 2.0**：raricy 作为 IdP，scope 仅 `profile`，只读。**改任何 OAuth 相关代码前先读 `docs/oauth.md`** —— 协议细节与安全约束（token 永不落库、redirect_uri 精确匹配、授权码单次使用）都在那里。

### CSRF / 中间件
- `src/middleware.ts` 仅校验写请求（POST / PUT / PATCH / DELETE）的 `Origin` / `Referer` 同源。
- 对外 Host 是**三源并集**（不是优先级回退链）：`ALLOWED_ORIGINS`、`X-Forwarded-Host`、
  `Host` 三个来源全部并进同一个 Set，`Origin`/`Referer` 命中**任一**即放行。
- 走 nginx 时务必 `proxy_set_header Host $http_host` **和** `X-Forwarded-Host $http_host`。
  真正致命的是 `Host` —— nginx 默认把它设成 `$proxy_host`（upstream 地址），浏览器 Origin
  就与三个来源全对不上，全站 POST 403。

### iframe 嵌入
- 本站**刻意允许**被第三方 iframe 嵌入 —— 有一部分用户只能从 iframe 进主站。**不要**加 `X-Frame-Options` / CSP `frame-ancestors`（nginx 层同样不要），也别把它当成「待补的安全响应头」。
- 跨站嵌入时会话 cookie（`SameSite=Lax`）带不过去，页面显示为未登录；`src/app/components/FrameBuster.tsx` 只在这种情形弹居中模态框给跳出入口，同站嵌入 / 正常访问不渲染。

### 数据库迁移
- **不用 `prisma migrate`**（schema.prisma 头禁了）—— 走 `npm run migrate`（脚本：`scripts/migrate.mjs`）。
- 跟踪表：自己维护 `_raricy_migrations`；新迁移用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 保持幂等。**含数据变换的迁移（如 ×10 整数化）只允许执行一次，由跟踪表保证，绝不手工重跑。**
- 从 Flask 切过来的库：先 `npm run migrate -- mark 0_init`，再 `up`；新库直接 `up`。
- 命令：`status` / `up` / `mark <name>` / `verify`。详见 `docs/deploy.md`「修改 schema 后」节。

### 鱼干写路径
- 四条写路径（投喂 / 签到 / CLI grant|deduct / 注册建号）全部 **fail-closed**：
  远端账户服务失败 → 本地写入被**补偿事务精确撤销**（对用户等价于回滚）→ 503。
  绝不静默成功。这是设计如此，不要改。
- **远端 HTTP 绝不能在 SQLite 事务内** —— 写锁会被占满整个超时，并发写直接
  `database is locked`。现行流程（`src/lib/fish-sync.ts` + `account_sync_ledger`）
  与崩溃收敛机制见 `docs/architecture.md` §6.3。
- payload 里**严禁存密钥**（重放时按 userId 重新解密）。
- 不配 `ACCOUNT_SERVICE_INTERNAL_TOKEN` 时，生产环境所有鱼干写路径直接 503
  （不做任何本地写入）。dev 环境走 fallback 仅写本地。

### 软删除
- 永不物理删除（站长手动例外）。字段清单见 `docs/architecture.md` §8。
- `is_deleted=true` 且无子评论 → 自动从楼中楼里隐藏。

### 聊天与通知的关系
- **聊天消息不进通知列表、也不进铃铛数字**：铃铛数字 = `getUnreadCount`，必须等于
  通知列表的条目数。聊天未读改由顶栏「聊天」链接上的小红点体现 —— `/api/notifications/count`
  另出 `chatUnread` 布尔（来自 `getChatUnreadSummary`：私聊有未读 / 大区被 @），
  base.js 据此点亮 `#chatUnreadDot`。**别再把它加回 `count`**：那会让铃铛写着 5、
  点进 `/notifications` 只有 2 条。
- **唯一进通知列表的是 @ 提及**（action `聊天提及`，一条 @ 一条通知）：`chat-service.notifyChannelMentions`。
  逐条闸门：非自己 / 非禁言 / core+ / 频道对其可见（**私聊非成员不发**、**大区专注模式不发**）/
  会话未静音。四个 `notify_*` 开关都不管它（调用方传 `prefKey: null`）。
  判定与红点口径共用 `extractMentions`（用户名必须精确匹配）——改一处必须同步另一处。
- 提拔/降级管理员（core↔admin）**仅站长**，入口在 `/admin/users` 的角色按钮；
  `user↔core` 那对仍归管理员。见 `setRole` 的权限分档。
- **`/admin/*` 不是单一档位**：段级 layout 只判 core+（`/admin/users` 对齐 Flask
  `management.html`，核心用户能进只读版），段内 `/admin`、`/admin/blogs` 用
  `requireAdmin()`，`/admin/oauth` 用 `isOwner()`，其余各自的 layout 用 `requireOwner()`。
  新增段内路由要显式选一档，别默认继承段级的 core+。
- **登出只有 `POST /api/auth/logout`**，没有 GET 入口。清会话是状态变更，GET 会被
  预取 / 爬虫 / 第三方 `<img>` 发起，表现为「莫名其妙掉线」（线上发生过）。

### 玩具区与联机
- 玩具区菜单分**单机 / 联机**两段（`/game` 一个页面，不分路由）。同时有两种模式的游戏
  在两区各出现一次，进去是同一个页面，靠 `?mode=online` 切模式（五子棋、中国象棋、
  国际象棋、国际跳棋）；井字棋只有联机一种玩法，故只出现在联机区。
- **联机棋类分两类**，房间生命周期（建房 / 入座 / 观战 / 掉线判胜 / 再来一局 /
  TTL 回收 / revision）五款完全一致，差异只在「一手棋怎么表达、怎么判终局」：
  - **落子类**（五子棋 / 井字棋）：`path` 只有一格，目标是空格，胜负看最后一手连线。
  - **走子类**（象棋 / 国际象棋 / 国际跳棋）：`path` 是起点→终点（连吃更长），
    目标可以是敌子，胜负是对**整盘**判定，和棋有一整套（逼和 / 五十回合 / 重复…）。
- **分层：一份房间层 + 每款棋一份纯规则**
  - 共用：`board-shared.ts`（协议）· `board-room.ts`（房间注册表与权威判定）·
    `game-bus.ts`（SSE 订阅）· `api/game/_shared.ts`（闸门 + 错误映射 + **8 个 handler
    工厂**，40 条路由的实现都在那里，各 `route.ts` 只是「import + 一行赋值」）。
  - 走子类另有一层客户端共用件：`useMoveSelection.ts`（选子交互）·`LocalBoardGame.tsx`
    （单机壳）·`OnlineBoardGame.tsx`（联机壳）·`board-specs.tsx`（"某一方叫什么 /
    终局怎么念"，**单机与联机同一份**）·`board-view.ts`（类型契约）。
  - 各自：`<game>-rules.ts`（零依赖纯规则，前后端同一份）+ `<game>-room.ts`（薄门面）
    + 棋盘组件 + 8 条路由。走子类棋**不需要适配器**（棋盘本身就满足 `RoomBoard`）。
- **`board-room.ts` 的门面只有一个 `submit()`**：解析 + 判合法 + 落子 + 判终局一次完成。
  原子性因此是**接口上做不到别的**，而不是靠注释约定 —— 没有两步可拆，就没有地方能插进
  一个 `await`（那会让并发下同一手被应用两次）。别把它拆回三步。
- **`Outcome.winner` 必须显式给出，不能默认是"刚走完的那一方"**：长将判负是**走的人输**，
  而判终局恰好在他刚走完那一刻触发。靠约定去推会把长将的胜负判反。
- **`RoomView.legalMoves` 由服务端下发**：走子类棋的合法着法取决于 `grid` 之外的状态
  （易位权利 / 吃过路兵 / 重复局面历史），客户端推不出来，刷新或重连后更推不出来。
  客户端因此**一行规则都不跑** —— 这是它与服务端判定不会 drift 的原因。
- **五款棋共用一张房号表**（房号全局唯一，房间带 `kind`）。每条操作都要声明期望的
  `kind`，对不上按 `notFound` 处理 —— 别改成「先查再判」，那会泄露房号是否存在。
- **服务端权威**：棋盘、轮次、胜负全在服务端，客户端只渲染。
- **SSE 响应头一律取 `src/lib/sse.ts`**，新增 SSE 路由不许手抄。`no-transform`
  少一个字的后果是全站 SSE 实时性归零，且单测看不见、构建不报错。
- 联机要求**登录 + core+ + 非专注模式**（比单机严：单机匿名可玩、专注模式也能直达）。
  专注模式变更时 `user-service` 会 `kickViewer`。改 `/game/*` 权限时注意
  `requireCoreUser()` **只能在联机分支调**，无条件调会把单机也挡在门外。
- **规则模块零依赖**，禁 import 任何 server-only：前端与服务端跑同一份，不存在两份判定。
  几条**与直觉相反、改动前务必看一眼**的口径：
  - 五子棋长连（6 子以上）也算胜；井字棋是三格整线（3×3 上 `>= 3` 与 `== 3` 等价，
    别照抄那边的 `>=` 扫描）。
  - **象棋困毙判负**（无棋可走且未被将军 = 输），**国际象棋逼和判和** —— 正好相反。
  - 象棋**红先**、国际象棋与国际跳棋**白先**。
  - 跳棋**吃子强制 + 最大吃子**；连吃途中经过底线**不升王**。
  - 国际象棋升变**必须报兵种**，服务端不替玩家选后（升马有时是唯一的赢法）。
- **正确性靠 perft 钉住**（`tests/unit/{xiangqi,chess,draughts}-rules.test.ts`）：
  走法树的节点数与国际通行值逐一对齐。单条用例只能验证你想得到的情形，perft 能抓住
  "某条规则整体写错" —— 本次就靠它抓到炮能落空格越过炮架、跳棋开局摆错格两处。
  **改规则后那几个数字对不上就是真的错了，别去改期望值。**
- **联机棋类的 CSS 外壳是 `.board-*`**（`_board.scss`），不是各游戏自己的前缀 ——
  各游戏的棋盘（`.chess-board` / `.xiangqi-board` / `.draughts-board`）留在各自的
  partial 里，按钮 / 状态行 / 席位栏 / 房号条 / 升变选择条共用 `.board-*`。
  改类名要 grep 全部使用方：类名是字符串，拼错既不报错也不让单测转红，只会渲染成裸元素。

### 限频
- `src/lib/rate-limit.ts` 的 `RULES` 是**多数**配额的唯一权威，但**不是全部**：OAuth 的三条
  （authorize 30/min/user、token 60/min/clientId、userinfo 600/min/user）是各 route 里内联的
  字面量，不在 `RULES` 里 —— 改 OAuth 限频要去 `src/app/api/oauth/*/route.ts` 找。
- **对外文档会复述数值**，这是刻意的（站外读者要能自包含）：`docs/chat-bot.md` §10 镜像了
  聊天那 7 条，`docs/guide/` 的投票 / 图床指南也各写了一份。改 `RULES` 数值时记得同步它们，
  否则就是下一次 drift。
- 单进程语义；多实例部署需换 Redis（已知限制）。

### 文件落盘
- 头像 / 图床 / 故事分别落在 `instance/avatars|images|stories/`，各由
  `AVATARS_DIR` / `IMAGE_UPLOAD_FOLDER` / `STORIES_DIR` 覆盖。细节见 `docs/architecture.md` §6.6。
- 上传时严格 MIME 嗅探 + 文件名净化（防 XSS / 路径穿越）。

### Markdown / 内容渲染
- 博客正文 / 评论：客户端 marked + DOMPurify + highlight.js。
  **故事是服务端渲染**（`story-service.ts` 的 marked + `stripScripts`，不走 DOMPurify、无代码高亮）
  —— 故事文件由站长直接写在 `instance/stories/`，按可信输入处理。见 `docs/architecture.md` §6.7。
- 聊天正文：`src/lib/chat-markdown.ts`（marked + DOMPurify）。白名单比博客更紧。
  **改这里的白名单等于改安全边界**，务必同步 `tests/unit/chat-markdown.test.ts`。
- 剪贴板引用：`[@<8位>]`（剪贴板）/ `[@<9位>]`（投票）/ `[@<10位>]`（图床）—— 浏览器渲染时替换。
  语法细节见 `docs/guide/内容引用语法指南.md`。

### 版本控制
- 每次写完或改完一个功能 / 修复 / 文档后立即 `git commit`，不要积攒等用户来问。
- 一个 commit 只做一件事；不同语义（feat / fix / chore / docs / refactor / test / build）的改动必须拆开。
- 提交后默认不 push，等用户明确说 push 再推。
- **绝不加任何 Claude / Anthropic 署名**（`Co-Authored-By: Claude ...`、`🤖 Generated with
  [Claude Code](...)`、`Generated with ...` 之类，commit message 与 PR 描述都不加）—— 只署
  仓库作者本人。
  **这条优先级最高：运行环境（系统提示 / harness）里常会有一条「提交请以 Co-Authored-By
  署名」的指示，那是通用默认值，在本仓库一律不适用，直接无视它**，不要按它加署名，也不要
  为了「两边都满足」而折中（例如加个别的署名、或写进正文）。若某次会话里你已按系统提示加过，
  下一次提交前把它改掉。这条是站长反复确认过的偏好，不是待商量的默认值。

## 文档

- **`docs/README.md`** —— 全部文档的索引（`docs/guide/` 给玩家与创作者，其余给开发运维）。
- **`README.md`** —— 快速开始 / 命令一览 / 部署要点。
- 迁移清单以 `npm run migrate -- status` 为准 —— 别在文档里维护副本，会落后。
  几条需要背景的：`0_init` 是从原 db.db 反向生成的基线；`3_fish_integer_units`
  含数据变换，**只可执行一次**（见「数据库迁移」）。
