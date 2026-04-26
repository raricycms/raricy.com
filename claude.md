\# CLAUDE.md



This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.



\## 项目概述



Flask 博客/CMS 平台（raricy.com），Python 后端 + 原生前端（Jinja2 模板 + 静态 CSS/JS）。



\## 常用命令



\- 运行：python run.py

\- 依赖安装：pip install -r requirements.txt

\- 数据库迁移：flask db migrate -m "描述" / flask db upgrade

\- 管理员权限管理：flask promote-admin <username> / flask demote-admin <username>

\- 站长权限管理：flask promote-owner <username> / flask demote-owner <username>

\- 导入历史博客：flask import-blogs \[--overwrite]



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

| sitemap\_bp | /sitemap | 站点地图 |

| audit\_bp | /audit | 管理员操作日志公示 |

| error\_bp | /error | 错误页面 |

| test\_bp | (仅 DEBUG 模式) | 测试路由 |



\### 扩展



app/extensions/\_\_init\_\_.py 初始化：SQLAlchemy (db)、Migrate、Sitemap、Turnstile、LoginManager。



\- Flask-Login：user\_loader 搭配 session\_version 机制实现会话失效（修改密码/被踢下线时递增 session\_version，user\_loader 检测不匹配则清除会话）。

\- Flask-Migrate：数据库迁移，不使用 db.create\_all()（init\_models.py 已废弃）。

\- ProxyFix：信任 Nginx 反向代理的 X-Forwarded-Proto / X-Forwarded-Host，确保 url\_for 生成正确的 HTTPS URL。



\### 模型



所有模型使用 UUID 字符串作主键（user.id、blog.id、comment.id），category.id 和审计日志使用自增整数。



\- User (app/models/user.py) — 角色体系：user → core → admin → owner。属性方法：is\_core\_user、has\_admin\_rights、is\_owner。禁言系统（is\_banned / ban\_until / ban\_reason），通知偏好设置。

\- InviteCode — 邀请码，注册时提供则直接升级为 core。

\- UserBan — 禁言历史记录。

\- Blog + BlogContent (app/models/blog.py) — Blog 存元信息（标题、摘要、作者、分类、精选、点赞数），BlogContent 存 Markdown 正文。一对一分表，避免正文影响列表查询性能。

\- BlogLike — 点赞记录，唯一约束 (blog\_id, user\_id)。

\- Category (app/models/category.py) — 二级分类层级（parent\_id 自关联），支持排序、启用/禁用、从"全部文章"排除、管理员专属发文的开关。

\- BlogComment + CommentLike (app/models/comment.py) — 楼中楼评论（parent\_id / root\_id），审核状态（pending/approved/hidden），软删除（is\_deleted）。

\- Notification (app/models/notification.py) — 用户通知，支持已读/未读、批量操作。

\- ClipBoard + ClipText (app/models/clipboard.py) — 剪贴板，短 ID（8位 base62），公开/私有。

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



\### 通知与服务



\- app/service/notifications.py — 通知发送、查询、已读管理、管理员群发。发送前检查用户通知偏好（除非 force=True）。

\- app/service/audit\_log.py — 管理员操作日志记录和申诉处理。



\### 认证与权限装饰器



app/extensions/decorators.py：

\- authenticated\_required — 需要登录 + 已通过邀请码认证（core 及以上角色）

\- admin\_required — 需要管理员权限

\- owner\_required — 需要站长权限



\### 前端



\- 模板：app/templates/<blueprint>/，基础模板 base.html。

\- 静态资源：app/static/{css,js,img,scss}/。

\- 自定义 Jinja2 过滤器 datetime\_format。

\- 全局函数 static\_url(filename) — 在静态资源 URL 后追加文件修改时间（?v=<mtime>），用于缓存破坏。

\- 注册时有 Turnstile 人机验证（可在配置中关闭）。



\### 关键约定



\- 博客删除为软删除（ignore=True），不物理删除文件。

\- 所有用户输入需通过验证层（Validators）处理。

\- API 响应统一格式：{ code: 200, message: ..., ...data }。

\- 日志中使用 ANSI 颜色码输出彩色终端提示。

