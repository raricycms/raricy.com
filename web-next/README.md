# raricy-next

聪明山 / raricy.com 的 Next.js 重构地基。**直连现有 Flask 的 SQLite 数据库**（零数据迁移）。

> 这是从 Flask 迁移到 Next.js 的**已跑通地基 + 范式**，不是完成品。
> 完整背景、决策、数据库迁移手册、剩余工作，见仓库根目录
> [`docs/nextjs-migration/`](../docs/nextjs-migration/00-总览与决策.md)。

## 现状（已实测）

- ✅ Prisma schema：20 张表 1:1 映射真实库
- ✅ 数据层：对真实数据完成 typed 读取 / 多表 join / 分类树
- ✅ 密码哈希与 werkzeug **双向互通**（scrypt/pbkdf2）——用户无需改密码
- ✅ JWT 会话 + `session_version` 失效机制（对齐 Flask-Login）
- ✅ 博客垂直切片：列表 / 详情 / 点赞 API + SSR 页面 + 登录页
- ✅ `next build` 全绿；运行时端点逐一 curl 通过

## 快速开始

见 [`docs/nextjs-migration/02-快速开始.md`](../docs/nextjs-migration/02-快速开始.md)。TL;DR：

```bash
npm install
npm run db:normalize          # 生成规整后的 prisma/dev.db
cp .env.example .env          # 填 SECRET_KEY（与 Flask 一致）
npm run prisma:generate
npm run dev                   # http://localhost:3000
```

## 技术栈

Next.js 15（App Router）· React 19 · TypeScript · Prisma（SQLite）· jose（JWT）
