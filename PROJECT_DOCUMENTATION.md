# Raricy.com 项目文档

## 项目概述

Raricy.com 是一个基于 Flask 框架构建的个人网站项目，由聪明山开发维护。该项目集成了博客系统、工具集、故事展示、用户管理等多种功能模块，采用现代化的前后端分离设计理念。

**项目特点：**
- 基于 Flask + Bootstrap + Vditor + Turnstile 技术栈
- 支持用户注册、登录、权限管理
- 完整的博客系统（文章发布、评论、点赞）
- 丰富的工具集（编码转换、加密解密等）
- 响应式设计，支持暗色/亮色主题切换
- 使用 SQLAlchemy ORM 进行数据库操作
- 支持数据库迁移和版本控制

## 项目结构详解

### 根目录结构

```
raricy.com/
├── app/                    # 核心应用代码
├── docs/                   # 项目文档
├── docs2/                  # 部署相关文档
├── export/                 # 数据导出脚本
├── migrations/             # 数据库迁移文件
├── scripts/                # 构建和部署脚本
├── .gitattributes          # Git 属性配置
├── .gitignore             # Git 忽略文件
├── README.md              # 项目说明
├── add_categories.py      # 添加分类脚本
├── check_instance.py      # 实例检查脚本
├── example.env            # 环境变量示例
├── init_production_categories.py  # 生产环境分类初始化
├── package.json           # Node.js 依赖配置
├── postcss.config.js      # PostCSS 配置
├── requirements.txt       # Python 依赖列表
└── run.py                 # 应用启动入口
```

### 核心应用目录 (app/)

#### 1. 扩展模块 (extensions/)
- `__init__.py` - 扩展初始化（数据库、登录管理、Turnstile验证等）
- `decorators.py` - 自定义装饰器（权限验证、管理员验证等）
- `init_models.py` - 模型初始化

#### 2. 数据模型 (models/)
- `__init__.py` - 模型导出
- `user.py` - 用户模型（User, InviteCode, UserBan）
- `blog.py` - 博客模型（Blog, BlogContent, BlogLike）
- `category.py` - 分类模型（支持层级结构）
- `comment.py` - 评论模型（BlogComment, CommentLike）
- `notification.py` - 通知模型
- `clipboard.py` - 剪贴板模型
- `audit.py` - 审计日志模型

#### 3. 服务层 (service/)
- `audit_log.py` - 审计日志服务
- `notifications.py` - 通知服务

#### 4. 静态资源 (static/)
- `css/` - 样式文件（包括高亮主题）
- `img/` - 图片资源（图标、favicon等）
- `js/` - JavaScript 文件
- `scss/` - SCSS 源码（按模块组织）

#### 5. 模板文件 (templates/)
按功能模块组织的 Jinja2 模板：
- `auth/` - 认证相关模板
- `blog/` - 博客系统模板
- `clipboard/` - 剪贴板模板
- `errorhandlers/` - 错误页面
- `game/` - 游戏相关模板
- `home/` - 首页模板
- `notification/` - 通知模板
- `sitemap/` - 站点地图
- `story/` - 故事展示模板
- `test/` - 测试页面
- `tool/` - 工具集模板
- `base.html` - 基础模板

#### 6. 工具函数 (utils/)
- `AES.py` - AES 加密解密工具
- `avatar_generator.py` - 头像生成器
- `base_encodings.py` - 基础编码转换
- `generate_stringid.py` - ID 生成器
- `invite_code.py` - 邀请码生成
- `markdown_countword.py` - Markdown 字数统计
- `verify_email.py` - 邮箱验证
- `verify_username.py` - 用户名验证

#### 7. Web 路由模块 (web/)
按功能模块组织的蓝图：
- `auth/` - 用户认证（登录、注册、个人资料）
- `blog/` - 博客系统（文章、评论、点赞）
- `clipboard/` - 剪贴板功能
- `game/` - 游戏功能
- `main/` - 主页面
- `notification/` - 通知系统
- `sitemap/` - 站点地图
- `story/` - 故事展示
- `test/` - 测试功能
- `tool/` - 工具集
- `error/` - 错误处理
- `audit/` - 审计日志

## 核心功能模块详解

### 1. 用户认证系统

**文件位置：** `app/web/auth/`

**功能组件：**
- `sign_in.py` - 用户登录
- `sign_up.py` - 用户注册
- `profile.py` - 个人资料管理
- `authentic.py` - 认证相关功能
- `user_management.py` - 用户管理（管理员功能）

**特性：**
- 基于 Flask-Login 的会话管理
- 密码哈希加密存储
- Cloudflare Turnstile 验证码集成
- 用户角色系统（user/core/admin/owner）
- 用户禁言机制
- 会话版本控制（安全登出）

### 2. 博客系统

**文件位置：** `app/web/blog/`

**架构设计：**
- **服务层** (`services/`) - 业务逻辑处理
- **验证层** (`validators/`) - 数据验证
- **工具层** (`utils/`) - 辅助功能
- **视图层** (`views.py`) - 路由处理

**功能特性：**
- 文章发布、编辑、删除
- 分类管理（支持层级结构）
- 评论系统（支持点赞）
- 点赞功能
- 管理员审核机制
- Markdown 编辑器集成（Vditor）
- 文章搜索和筛选

### 3. 工具集系统

**文件位置：** `app/web/tool/`

**可用工具：**
- 基础编码转换（Base64、Base32、Hex等）
- URL 编码/解码
- HTML 实体编码
- 哈希计算（MD5、SHA等）
- AES 加密解密

**技术实现：**
- 基于 `app/utils/base_encodings.py`
- 前后端分离的 API 设计
- 实时交互式界面

### 4. 通知系统

**文件位置：** `app/web/notification/`

**通知类型：**
- 文章被点赞
- 文章被编辑
- 文章被删除
- 管理员通知
- 自定义通知

**特性：**
- 用户可自定义通知偏好
- 实时未读计数显示
- WebSocket 实时推送（可选）

### 5. 审计日志系统

**文件位置：** `app/web/audit/`

**记录内容：**
- 用户登录/登出
- 关键操作记录
- 管理员操作
- 安全事件

## 数据库设计

### 核心数据表

1. **users** - 用户表
   - 用户基本信息、权限、通知设置
   - 支持角色分级和禁言机制

2. **blogs** - 博客文章表
   - 文章元信息、分类、统计信息
   - 支持精选文章和忽略显示

3. **categories** - 分类表
   - 支持二级分类结构
   - 分类权限控制（管理员专属）

4. **blog_comments** - 评论表
   - 评论内容、层级关系
   - 点赞统计

5. **notifications** - 通知表
   - 用户通知记录
   - 已读/未读状态管理

6. **audit_logs** - 审计日志表
   - 操作记录和安全审计

## 配置系统

### 环境配置
项目使用环境变量配置，通过 `app/config.py` 管理：

**配置文件：** `example.env`

**关键配置项：**
- `SECRET_KEY` - Flask 应用密钥
- `SQLALCHEMY_DATABASE_URI` - 数据库连接
- `TURNSTILE_SITE_KEY` - Cloudflare Turnstile 站点密钥
- `TURNSTILE_SECRET_KEY` - Cloudflare Turnstile 密钥
- `SERVER_NAME` - 服务器域名

### 多环境支持
- `DevelopmentConfig` - 开发环境
- `ProductionConfig` - 生产环境
- `TestingConfig` - 测试环境

## 前端架构

### 样式系统
- **SCSS 模块化** - `app/static/scss/`
  - `abstracts/` - 变量和混合
  - `base/` - 基础样式
  - `components/` - 组件样式
  - `layout/` - 布局样式
  - `pages/` - 页面特定样式
  - `utilities/` - 工具类

### 主题系统
- 支持亮色/暗色主题切换
- CSS 自定义属性（CSS Variables）
- 本地存储主题偏好

### JavaScript 功能
- 自定义导航栏组件
- 主题切换功能
- 实时通知系统
- 工具交互界面

## 构建和部署

### 依赖管理
- **Python**: `requirements.txt`
- **Node.js**: `package.json`（用于 SCSS 编译）

### 构建脚本
`scripts/` 目录包含构建脚本：
- `build_scss.ps1` - Windows SCSS 编译
- `fetch_*.ps1` - 前端依赖下载

### 数据库迁移
使用 Flask-Migrate 进行数据库版本控制：
- `migrations/` - 迁移文件目录
- `alembic.ini` - Alembic 配置

## 开发指南

### 项目启动
1. 复制 `example.env` 为 `.env` 并配置环境变量
2. 安装依赖：`pip install -r requirements.txt`
3. 初始化数据库：`flask db upgrade`
4. 运行应用：`python run.py`

### 代码规范
- 遵循 Flask 应用结构规范
- 使用类型注解（Python 3.6+）
- 模块化设计，职责分离
- 统一的错误处理和响应格式

### 扩展开发
1. 在 `app/web/` 下创建新的蓝图模块
2. 在 `app/models/` 下定义数据模型
3. 在 `app/templates/` 下创建对应模板
4. 在 `app/static/scss/pages/` 下添加样式
5. 在 `app/web/__init__.py` 中注册蓝图

## 安全特性

- 密码哈希加密
- CSRF 保护
- XSS 防护（Markdown 内容过滤）
- SQL 注入防护（ORM 参数化查询）
- 会话安全管理
- 操作审计日志
- 用户权限控制

## 性能优化

- 静态资源版本控制（避免缓存问题）
- 数据库查询优化（索引、反范式设计）
- 前端资源压缩和合并
- 响应式图片加载
- 懒加载和分页机制

## 项目特色

1. **现代化架构** - 采用分层设计和模块化开发
2. **用户体验优化** - 响应式设计、主题切换、实时交互
3. **安全性强** - 多重安全防护机制
4. **可扩展性好** - 清晰的架构便于功能扩展
5. **文档完善** - 详细的代码注释和项目文档

---

*本文档最后更新：2026年3月9日*  
*项目维护者：聪明山*  
*项目地址：https://raricy.com*

---

ai 写的文档，我也不知道对不对。没救了。