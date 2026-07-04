\# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

\## 项目概述

Flask 博客（raricy.com），Python 后端 + 原生前端（Jinja2 模板 + 静态 CSS/JS）。

\## 常用命令

\- 运行：python run.py

\- 依赖安装：pip install -r requirements.txt

\- 数据库迁移：flask db migrate -m "描述" / flask db upgrade

\- 管理员权限管理：flask promote-admin <username> / flask demote-admin <username>

\- 站长权限管理：flask promote-owner <username> / flask demote-owner <username>

\- 导入历史博客：flask import-blogs \[--overwrite]

\- 小鱼干管理：flask fish grant <username> <amount> / flask fish deduct <username> <amount> / flask fish balance <username>

\## 架构

\### 应用工厂

run.py → app/\_\_init\_\_.py:create\_app() 创建 Flask 实例，按顺序：加载配置 → 注册 Jinja2 过滤器/全局函数 → 注册蓝图 → 初始化扩展 → 注册 CLI 命令。

\### 配置

app/config.py — 通过 CONFIG\_TYPE 环境变量切换 DevelopmentConfig / ProductionConfig / TestingConfig。所有敏感配置（SECRET\_KEY、数据库 URI、Turnstile 密钥）均从 .env 读取。默认使用 instance/database/db.db 的 SQLite。

\### 蓝图（Blueprint）

在 app/web/\_\_init\_\_.py:register\_blueprints() 中统一注册：

| 蓝图 | URL 前缀 | 用途 |

|------|----------|------|

| home\_bp | / | 首页、robots.txt、联系页面、邀请码生成 |

| auth\_bp | /auth | 登录、注册、认证、资料、用户管理 |

| blog\_bp | /blog | 博客 CRUD、管理后台、API（点赞/评论）、爬虫 API |

| notifications\_bp | /notifications | 通知中心 |

| tool\_bp | /tool | 工具页面 |

| story\_bp | /story | 故事模块 |

| game\_bp | /game | 游戏模块 |

| clip\_bp | /clipboard | 剪贴板模块 |

| image\_bp | /image | 图床（上传、压缩、管理） |

| photo\_wall\_bp | /photowall | 照片墙 |

| vote\_bp | /vote | 投票模块 |

| checkin\_bp | /checkin | 每日签到 |

| sitemap\_bp | /sitemap | 站点地图 |

| audit\_bp | /audit | 管理员操作日志公示 |

| error\_bp | /error | 错误页面 |

| test\_bp | (仅 DEBUG 模式) | 测试路由 |

\### 扩展

app/extensions/\_\_init\_\_.py 初始化：SQLAlchemy (db)、Migrate、Sitemap、Turnstile、LoginManager。

\- Flask-Login：user\_loader 搭配 session\_version 机制实现会话失效（修改密码/被踢下线时递增 session\_version，user\_loader 检测不匹配则清除会话）。

\- Flask-Migrate：数据库迁移，不使用 db.create\_all()（init\_models.py 已废弃）。

\- ProxyFix：信任 Nginx 反向代理的 X-Forwarded-Proto / X-Forwarded-Host，确保 url\_for 生成正确的 HTTPS URL。

\- AccountClient：在 create\_app 中初始化，挂载到 `app.account_client`。封装对账户服务 FastAPI 微服务的 HTTP 调用。详见 [docs/fish-account-refactor/](docs/fish-account-refactor/)。

\### 账户服务 (account-service/)

独立 FastAPI 微服务，管理小鱼干虚拟货币。复式记账（Account + LedgerEntry），幂等控制（IdempotencyKey），双层认证（X-Internal-Token + API Key）。

\- **博客侧客户端**：app/clients/account\_client.py — 同步 HTTP 客户端，封装全部 6 个 API。用户 API Key 用 Fernet 加密存储在 `User.fish_api_key_encrypted`。

\- **当前阶段**：Phase 1.5 写路径 fail-closed 化全部完成（2026-07-04）。所有写路径（投喂/签到/CLI grant/CLI deduct）均遵循：本地先收集变更 → 远端同步成功后才 commit 本地 → 远端失败则 rollback 整个本地事务，并向用户/CLI 返回明确错误（HTTP 503 / exit 2）。读路径仍走远端优先 + 本地 fallback。
  - 决策过程详见 [docs/fish-account-refactor/07-迁移策略与未来扩展.md](docs/fish-account-refactor/07-迁移策略与未来扩展.md) Phase 1.5 章节。已知代价：远端故障时所有鱼干操作瘫痪，需要在账户服务前加 LB + 健康检查。

\- **重构文档**：[docs/fish-account-refactor/](docs/fish-account-refactor/)（8 个文档，含迁移手册）

\### 模型

所有模型使用 UUID 字符串作主键（user.id、blog.id、comment.id），category.id 和审计日志使用自增整数。

\- User (app/models/user.py) — 角色体系：user → core → admin → owner。属性方法：is\_core\_user、has\_admin\_rights、is\_owner。禁言系统（is\_banned / ban\_until / ban\_reason），通知偏好设置，运势统计（total\_fortune），小鱼干余额（dried\_fish，Float 类型），账户服务 API Key（fish\_api\_key\_encrypted，Fernet 加密存储）。

\- InviteCode — 邀请码，注册时提供则直接升级为 core。

\- UserBan — 禁言历史记录。

\- Blog + BlogContent (app/models/blog.py) — Blog 存元信息（标题、摘要、作者、分类、精选、点赞数），BlogContent 存 Markdown 正文。一对一分表，避免正文影响列表查询性能。

\- BlogLike — 点赞记录，唯一约束 (blog\_id, user\_id)。

\- Category (app/models/category.py) — 二级分类层级（parent\_id 自关联），支持排序、启用/禁用、从"全部文章"排除、管理员专属发文的开关。

\- BlogComment + CommentLike (app/models/comment.py) — 楼中楼评论（parent\_id / root\_id），审核状态（pending/approved/hidden），软删除（is\_deleted）。

\- Notification (app/models/notification.py) — 用户通知，支持已读/未读、批量操作。

\- ClipBoard + ClipText (app/models/clipboard.py) — 剪贴板，短 ID（8位 base62），公开/私有。

\- ImageHosting (app/models/image.py) — 图床，10位字母数字 ID，支持软删除，用户配额（core 50MB/admin 50MB/owner 100MB）。

\- PhotoWallItem (app/models/photowall.py) — 照片墙条目，UUID 主键，软删除。

\- Vote + VoteOption + VoteRecord (app/models/vote.py) — 投票，9位 base62 ID，选项关联，每人一票（唯一约束），软删除。

\- DailyCheckIn (app/models/checkin.py) — 每日签到，唯一约束 (user\_id, checkin\_date)。

\- FishTransaction (app/models/fish.py) — 小鱼干交易流水，记录每笔收支（签到、打赏、投喂、管理操作等）。使用原子 UPDATE 防并发超扣。

\- BlogFeed (app/models/blog_feed.py) — 文章投喂记录，用户对文章投喂小鱼干的累计，单用户每篇上限 5。

\- AdminActionLog + AdminActionAppeal (app/models/audit.py) — 管理员操作日志和申诉系统。

\### 博客模块 (app/web/blog/)

采用分层架构：

\- views.py — 用户端路由（列表、详情、上传、编辑、删除）

\- api\_views.py — 前端 API（点赞切换、评论 CRUD、点赞者列表）

\- admin\_views.py — 管理员路由（仪表盘、栏目管理、文章管理）

\- spider\_api.py — 爬虫 API（允许搜索引擎爬取内容）

\- services/ — 业务逻辑层（BlogService、CommentService、LikeService、CategoryService）

\- validators/ — 输入验证层

\- utils/ — 响应格式化、禁言检查等工具

\### 服务层 (app/service/)

\- app/service/notifications.py — 通知发送、查询、已读管理、管理员群发。发送前检查用户通知偏好（除非 force=True）。

\- app/service/audit\_log.py — 管理员操作日志记录和申诉处理。

\- app/service/checkin.py — 每日签到，原子性通过数据库唯一约束保证，UTC+8 硬编码时区。

\- app/service/fish.py — 小鱼干核心服务（get\_balance、add\_fish、deduct\_fish、get\_transactions、排行榜）。与 Flask 解耦，所有函数接受显式 user\_id 参数，外部项目可直接 import 使用。**仅写本地 DB**，不直接调 AccountClient；调用方（如 feed\_fish\_service、checkin、cli fish）负责同步远端——所有写路径（投喂/签到/CLI grant/CLI deduct）均已 fail-closed。

\- app/clients/account\_client.py — 账户服务 HTTP 客户端，封装全部 6 个 API。`AccountClient` 在 create\_app 中初始化，通过 `current_app.account_client` 访问。

\### 工具模块 (app/utils/)

| 文件 | 用途 |
|------|------|
| AES.py | AES 加密/解密（cryptography.fernet.Fernet + SHA-256 密钥派生） |
| avatar\_generator.py | GitHub 风格 identicon 头像生成（hashlib.md5 + Pillow） |
| base\_encodings.py | Base16/32/36/58/62/64/85/91/92 编码解码 |
| generate\_stringid.py | 短 ID 生成（默认 8 位，小写字母+数字），用于剪贴板和投票 |
| invite\_code.py | 12 位 base62 邀请码生成和验证 |
| markdown\_countword.py | Markdown 字数统计（去除代码块、图片、链接等） |
| verify\_email.py | 邮箱格式验证（regex 库） |
| verify\_username.py | 用户名验证（3-20 位 Unicode，regex 库） |

\### 认证与权限装饰器

app/extensions/decorators.py：

\- authenticated\_required — 需要登录 + 已通过邀请码认证（core 及以上角色）

\- admin\_required — 需要管理员权限

\- owner\_required — 需要站长权限

注意：装饰器失败返回 abort(403) HTML 页面，不适合 JSON API 端点。

\### 速率限制

全站限频见 [docs/全站限额与频控汇总.md](docs/全站限额与频控汇总.md)。三种实现方式：

1. **进程内内存列表**（轻量，重启丢失）：
   - 点赞 100次/时、500次/天 | 评论 1200次/天 | 投票创建 10次/时 | 投票 30次/时 | 图床上传 75次/时 | 照片墙放置 30次/时、更新 300次/时
   - 同一 in-memory rate limiter 模式在 like\_service、comment\_service、vote/service、image\_hosting/service、photowall/service 中重复实现 — 写新限频时考虑抽取共享工具。

2. **数据库查询**（精确，跨进程一致）：
   - 博客日发布限额 | 申诉 20次/天 | 剪贴板总数 ≤200 | 投票创建上限 100 | 照片墙每人 30 条

3. **唯一约束**（数据库层保证）：
   - BlogLike(blog\_id, user\_id)、VoteRecord(vote\_id, user\_id)、DailyCheckIn(user\_id, checkin\_date)

\### 前端

\#### 模板体系

\- 模板：app/templates/<blueprint>/，基础模板 base.html。

\- **Template blocks**（base.html）：`title`（默认"聪明山"）、`extra_css`、`content`、`footer_text`、`copyright`、`extra_js`。

\- **admin\_base.html** — 管理端母版，继承 base.html，提供固定左侧边栏 + `admin_content` block。移动端 (<768px) 侧边栏变为水平导航。

\- 博客详情页**组件化 include**，每个组件包含独立 HTML + JS：like\_system、comment\_system、modal\_system、markdown\_renderer、clipboard\_processor、admin\_controls。

\- **Macros**（[blog/\_macros.html](app/templates/blog/_macros.html)）：`render_category_options`（层级分类 select）、`admin_pagination`、`admin_stat_card`。

\- **分页**：window-of-3 模式 + 跳转输入框，URL 查询参数（category、search、tab 等）在分页链接中保留。

\- 自定义 Jinja2 过滤器 datetime\_format。

\- 全局函数 static\_url(filename) — 在静态资源 URL 后追加文件修改时间（?v=<mtime>），用于缓存破坏。

\#### JavaScript 架构

\- 目录：`app/static/js/`，子目录 `core/`（全局基础）、`blog/`（博客组件）、`game/`（游戏）。

\- **Class-based 组件**：所有交互组件为 ES6 class，`DOMContentLoaded` 时实例化。主要组件：LikeManager、CommentManager、ModalSystem、MarkdownRenderer、AdminControlsManager、VoteEmbed、ClipboardPreprocessor。

\- **data-\* 属性传参**：组件从 HTML data 属性读取 URL 和配置，而非内联 Jinja2 变量。如 `data-list-url`、`data-can-comment`、`data-current-user-id`。

\- **API 调用**：fetch() + JSON body + `credentials: 'same-origin'`。响应格式 `{ code, message, ...data }`。按钮提交时禁用、finally 中恢复。

\- **Toast 通知**：全局 `window.showToast(message, type)`，type 为 `success`/`error`/`info`/`warning`。容器动态创建，右上角，3.5 秒自动消失。

\- **全局通信**：通过 `window.*` 挂载（无 bundler、无模块系统）。例外：[cattca.js](app/static/js/cattca.js) 使用 ES module export。

\- 全局服务器数据通过 `<meta>` 标签传递（`user-authenticated`、`notification-api-url`、`logout-url`），由 [base.js](app/static/js/core/base.js) 读取。

\#### 主题/暗色模式

\- CSS 自定义属性（设计令牌）在 `:root` 和 `[data-theme="dark"]` 中双主题定义。

\- `localStorage.getItem('theme')` 存储偏好（`'light'` / `'dark'`）。

\- `<head>` 内联脚本在 CSS 加载前设 `data-theme` 属性防闪烁。

\- MutationObserver 监听 `data-theme` 变化，同步切换 highlight.js 主题（default ↔ monokai）。

\- 主题切换按钮在导航栏，图标旋转动画。

\#### 图标

\- 无图标字体 — 使用自定义 SVG + CSS `mask-image`，颜色继承 `currentColor`，定义在 [components/\_icons.scss](app/static/scss/components/_icons.scss)。

\#### 前端构建

\- **SCSS**：Dart Sass → CSS。开发 `--watch`，生产 `postcss`（autoprefixer + cssnano）→ `main.min.css`。

\- **配置文件**：[package.json](package.json)（前端依赖）、[postcss.config.js](postcss.config.js)（autoprefixer + cssnano）、[.browserslistrc](.browserslistrc)。

\- **scripts/** 目录：获取/构建前端依赖的脚本（PowerShell + Bash 双版本）：
  - `build_scss` — SCSS 编译
  - `fetch_frontend_deps` — 获取所有 JS 库
  - `fetch_dompurify` / `fetch_marked` / `fetch_highlight` / `fetch_vditor` — 单独获取各库
  - `setup_node` — Node.js 环境安装

\- **Vendored JS 库**（被 .gitignore 排除，通过 scripts 获取）：marked.js、DOMPurify、highlight.js、Vditor。模板中保留 CDN fallback。

\- 注册时有 Turnstile 人机验证（可在配置中关闭，仅注册页，登录页无）。

\#### SCSS 样式体系

源码目录 `app/static/scss/`，入口 `main.scss`，构建产物输出到 `app/static/css/`。

**分层目录：**

| 目录 | 用途 | 约束 |
|------|------|------|
| `abstracts/` | 变量、mixin、函数、断点 | 仅被引用，不产出 CSS |
| `base/` | Reset、字体、表单基线 | 全局生效 |
| `layout/` | 容器、栅格、header/footer | 布局级 |
| `components/` | 可复用组件（按钮、导航、卡片等） | BEM 命名，不依赖页面上下文 |
| `utilities/` | 原子工具类（间距、显示、flex） | 前缀 `u-`，控制数量 |
| `pages/` | 页面特有样式（含 admin/、blog/、game/ 子目录） | 不放可复用样式 |

**命名规范：**
- 组件用 BEM：`block`、`block__element`、`block--modifier`（如 `card`、`card__title`、`card--featured`）
- 工具类用 `u-` 前缀（如 `.u-mt-8`、`.u-flex`、`.u-hidden`）
- 嵌套最多 2 层，禁止高特异性选择器
- 禁止 `!important`（utilities 层除外）
- 颜色、间距、字号走设计令牌变量，不硬编码

**main.scss 引入顺序：** abstracts → base → layout → components → utilities → pages

**构建：**
- 开发：`sass --style=expanded --source-map static/scss/main.scss static/css/main.css --load-path=static/scss --watch`
- 生产：先 `sass` 编译，再 `postcss`（autoprefixer + cssnano）压缩为 `main.min.css`
- 模板引用：开发用 `main.css`，生产用 `main.min.css`

**写新前端时：**
1. 新组件样式放 `components/`，用 BEM 命名
2. 页面专属样式放 `pages/`
3. 如果某样式在多页面复用，上提到 `components/` 或 `layout/`
4. 组件不要依赖页面上下文（不写 `.blog-page .card {}` 这种）

\### 安全

\- **无 CSRF 保护**：项目不使用 flask-wtf，无 CSRF token。表单和 AJAX 请求均无 CSRF 防护。新增敏感操作时需注意。

\- **无 CORS 中间件**：无 flask-cors，仅信任同源请求。

\- **spider API 无认证**：[spider\_api.py](app/web/blog/spider_api.py) 端点为搜索引擎公开访问，有意不加装饰器。

\- **SVG XSS 防护**：SVG 图片以 `Content-Disposition: attachment` 提供，文件名经 [sanitize\_filename()](app/web/image_hosting/service.py) 净化。

\- **密码哈希**：werkzeug `generate_password_hash` / `check_password_hash`（pbkdf2:sha256）。

\- **登录重定向安全**：`is_safe_url()` 验证 `next` 参数防开放重定向。

\- **Nginx 反代**：ProxyFix 信任 X-Forwarded-Proto / X-Forwarded-Host。

\- **装饰器注意**：`admin_required` / `owner_required` 失败返回 `abort(403)` HTML 页面，不适合 JSON API 端点。API 需自行处理权限检查并返回 JSON。

\### 关键约定

\#### 软删除

以下模型使用软删除（字段名略有不同），永不物理删除（除站长操作外）：

| 模型 | 字段 | 默认 |
|------|------|------|
| Blog | `ignore` | False |
| BlogComment | `is_deleted` | False |
| BlogLike | `deleted` | False |
| ClipBoard | `ignore` | False |
| Vote | `ignore` | False |
| ImageHosting | `ignore` | False |
| PhotoWallItem | `ignore` | False |

例外：ImageHosting 站长可硬删除（同时删除磁盘文件）；CategoryService.delete\_category() 物理删除。

\#### 日期时间

\- 所有模型使用 **naive datetime**（`datetime.now()`），无时区感知（无 pytz/zoneinfo）。

\- 签到服务硬编码 UTC+8：`datetime.utcnow() + timedelta(hours=8)`。

\- `to_dict()` 序列化用 `.isoformat()`（博客用 `.strftime('%Y-%m-%d')`）。

\#### Markdown 渲染分工

| 场景 | 方式 | 库 |
|------|------|-----|
| 博客正文 | **客户端**渲染 | marked.js + DOMPurify + highlight.js |
| 故事内容 | **服务端**渲染 | Python markdown（extra + codehilite + tables + toc） |
| 评论 | 不支持 Markdown | `markupsafe.escape()` + `\n` → `<br>` |

\#### ID 生成策略

| 模型 | ID 方式 | 说明 |
|------|---------|------|
| User / Blog / Comment / PhotoWall / Notification | UUID4 | 36 字符 |
| ClipBoard | base62 8 位 | `random.choice`（非加密安全） |
| Vote | base62 9 位 | `random.choice` |
| ImageHosting | 字母数字 10 位 | `secrets.choice`（加密安全） |
| Category / Audit | 自增整数 | 数据库自动递增 |

\#### 评论系统

\- 楼中楼：`parent_id`（直接父级）+ `root_id`（根评论），实现嵌套回复。

\- 内容 HTML 转义（不渲染 Markdown），换行转 `<br>`。

\- 审核状态 `pending`/`approved`/`hidden`（当前默认 approved）。

\- `_filter_deleted_leaves()` 自动移除无子评论的已删除叶子节点。

\- `Blog.comments_count` 和 `Blog.last_comment_at` 冗余字段在每次评论操作时更新。

\#### 禁言系统

\- `User.is_currently_banned()` 自动过期检测（当前时间 > ban\_until 则清除禁言状态）。

\- `UserBan` 表记录所有禁言/解禁历史。

\- `ban_user()` / `lift_ban()` 自动创建历史记录。

\#### 会话失效

\- `user_loader` 每次请求比较 `session['session_version']` 与 `user.session_version`。

\- 不匹配时清除三个 session key：`_user_id`、`session_version`、`_fresh`，静默登出。

\- 触发时机：修改密码、管理员强制下线。

\#### instance/ 目录结构

```
instance/
  avatars/    — 用户头像 PNG（<uuid>.png）
  blogs/      — 博客文件目录（遗留，现内容存数据库 BlogContent 表）
  database/   — SQLite db.db
  images/     — 图床上传文件
  stories/    — 故事 .md / .cattca 文件 + info.json 元数据
```

使用 `python check_instance.py` 可自动创建上述目录结构。

\#### 模块分层程度

只有 blog 模块有完整分层（views → services → validators → utils）。game 模块也开始拆分（game\_api.py 独立文件）。其他模块（clipboard、tool、vote、photowall、checkin）路由多写在 `__init__.py`，服务层更简单，无独立验证器目录。写新模块时参考 blog 的分层结构。小鱼干（fish）服务层位于 app/service/fish.py，与 Flask 解耦，值得参考。

\#### 文档

[docs/](docs/) 目录含 10 个参考文档：项目概述与技术架构、全站限额与频控汇总、部署与运行、前端样式构建指南、内容引用语法指南、云剪贴板使用指南、cattca-guide、cattca-syntax、故事模块、atamas-game（ATAMAS 游戏规则）。

\#### 其他

\- 所有用户输入需通过验证层（Validators）处理。

\- API 响应统一格式：`{ code: 200, message: ..., ...data }`。

\- 日志中使用 ANSI 颜色码输出彩色终端提示。

\- CLI 命令：[cli\_notification\_cleanup.py](app/cli_notification_cleanup.py) 是独立脚本（非 Flask CLI），`python cli_notification_cleanup.py cleanup [--days 30] [--dry-run]` / `stats`。
