# 文档索引

raricy.com 的全部文档。分两层：**`guide/` 给玩家和内容创作者**，**根下给开发与运维**。

> ⚠️ `guide/` 下的**文件名是接口**：站内 4 个页面（表里标 ★ 的）通过
> `src/app/components/MarkdownGuide.tsx` 在请求时按文件名读盘渲染。
> 改名或移动会让页面静默变成一句「指南文档暂时无法加载。」且照样返回 200 ——
> 所以别改文件名，要移动就一起改 `MarkdownGuide.tsx` 的基准目录。
> 两道闸门盯着：`tests/unit/guide-docs.test.ts`（静态）与 `scripts/smoke.mjs` §2b（线上查正文）。

## guide/ —— 玩家与内容创作者

| 文档 | 讲什么 |
|------|--------|
| `guide/云剪贴板使用指南.md` ★ | Markdown 内容管理与复用 |
| `guide/图床使用指南.md` ★ | 图片托管、直链与压缩 |
| `guide/投票箱使用指南.md` ★ | 创建投票、嵌入博客 |
| `guide/cattca-guide.md` ★ | Cattca 互动叙事入门（零基础） |
| `guide/cattca-syntax.md` | Cattca 脚本语法参考（命令逐条） |
| `guide/内容引用语法指南.md` | `[@<内容ID>]` 在博客里嵌入内容 |
| `guide/story-module.md` | 故事模块：文件结构 / 合集嵌套 / URL |
| `guide/atamas-game.md` | ATÅMAS 圆盘组合游戏玩法 |
| `guide/gomoku-online.md` | 五子棋联机对战：开房、邀请、掉线判胜、观战 |

★ = 被站内页面渲染（`/clipboard/guide` · `/image/guide` · `/vote/guide` · `/tool/cattca-guide`）

## 开发与运维

| 文档 | 讲什么 |
|------|--------|
| `architecture.md` | 进程拓扑 / 路由 / 子系统 / 数据流 / 风险 |
| `deploy.md` | 从零到上线：环境、`.env`、数据库、systemd、nginx、TLS、备份、排障 |
| `cli.md` | 运维 CLI：交互式向导 / 命令式用法；角色、用户、内容检索与恢复、鱼干、邀请码、审计、申诉 |
| `oauth.md` | raricy 作为 OAuth 2.0 IdP 的完整协议与集成 |
| `chat-bot.md` | 聊天机器人接入：接口契约 / SSE / 限频（面向站外开发者，自包含） |
| `comment-bot.md` | 评论区机器人接入：接口契约 / 轮询 / 限频（面向站外开发者，自包含） |
| `frontend-styles.md` | SCSS 目录 / 设计令牌 / 组件约定 / 响应式 |
| `instance-restore.md` | 从 `instance.zip` 还原数据目录与数据库（灾备） |

## 相关

- `../CLAUDE.md` —— 给 Claude Code 的项目约定（约束与反直觉决策）
- `../README.md` —— 快速开始、命令一览、部署要点
