# 聪明山

基于 Flask 的个人网站，集博客、故事、工具集、剪贴板等功能于一体。

**访问地址：https://raricy.com/**

## 技术栈

- **后端:** Python / Flask + SQLAlchemy + Flask-Login
- **前端:** Jinja2 模板 + SCSS + 原生 JavaScript
- **编辑器:** Vditor（Markdown）
- **验证:** Cloudflare Turnstile

## 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt
npm install

# 2. 配置环境变量
cp example.env .env   # 编辑 .env 填入实际值

# 3. 初始化
python check_instance.py
flask db upgrade

# 4. 启动
python run.py
```

## 管理

```bash
flask promote-admin <username>    # 授予管理员权限
flask promote-owner <username>    # 授予站长权限
```

管理后台：`/auth/user_management`

## 项目结构

| 目录                 | 说明                          |
| ------------------ | --------------------------- |
| `app/models/`      | 数据模型（User, Blog, Comment 等） |
| `app/web/`         | 蓝图路由，按功能模块组织                |
| `app/service/`     | 业务逻辑层（通知、审计日志）              |
| `app/templates/`   | Jinja2 模板                   |
| `app/static/scss/` | SCSS 样式源码                   |
| `app/static/js/`   | JavaScript                  |
| `app/extensions/`  | Flask 扩展初始化与装饰器             |
| `app/utils/`       | 工具函数                        |
| `migrations/`      | 数据库迁移文件                     |

## 详细文档

- [部署与运行](docs/部署与运行.md)
- [项目概述与技术架构](docs/项目概述与技术架构.md)
- [前端样式构建指南](docs/前端样式构建指南.md)

## 联系

有任何建议，请通过 [https://raricy.com/contact](https://raricy.com/contact) 联系我。
