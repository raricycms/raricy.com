# 文档索引

按读者和工作阶段查找文档。

| 要做什么 | 从哪里开始 |
| --- | --- |
| 使用功能、创作内容、开发机器人 | 下方的玩家指南与机器人接口参考 |
| 了解系统或修改业务 | `docs/architecture.md`、`docs/agent-domain-rules.md` |
| 部署、排障、选择验证范围 | `docs/deploy.md`、`docs/known-red.md`、`docs/testing.md` |
| 找下一步或待决策事项 | `docs/plan/README.md` |
| 回看实施依据 | 站内目录的「历史归档」和 Git 历史 |

## 文档写在哪里

架构记录进程职责、持久数据归属、跨模块契约与典型数据流。实现细节放在模块说明或源码附近。对外行为变更时，在同一变更中更新相关指南或接口参考，保留外部读者需要的限额和示例。

活跃状态与下一步由 `docs/plan/README.md` 维护。总索引和站内目录卡片只介绍主题。结案时归还现行规则，再归档有追溯价值的方案。一次性调研按根项目说明保存在本地，公开文档所依赖的决策及操作依据应能从 Git 检出中读取。

## 改文档时：互指怎么写

新增站内互指用反引号包住仓库路径，例如 `docs/architecture.md` §6.5。站内渲染器会把路径和紧随的章节号转成链接。既有 Markdown 相对链接仍可读取。

- 段号链写作 `docs/deploy.md` §6/§13。编号被重新使用时仍可能跳错主题，调整章节要核对入链含义和旧书签。
- 引用同目录文件可用文件名；从文档根目录引用仓库根文件应写 `../README.md` 或 `../CLAUDE.md`。
- 新增、改名、移动或删除文档，同步 `src/lib/docs-catalog.ts` 和相关入口，并运行 `npm run guards`。移动已公开的路径时保留旧 URL 跳转；拆分章节时让旧锚点通往对应主题。
- 下表标 ★ 的六份指南由功能页直接按文件名读取。它们的规范地址、磁盘文件名和站内链接须一起核对。

## guide/ —— 玩家与内容创作者

| 文档 | 讲什么 |
|------|--------|
| `guide/聊天气泡使用指南.md` | 聊天气泡：商城租用、选择、到期、历史消息跟随与款式维护 |
| `guide/云剪贴板使用指南.md` ★ | 内容片段保存与复用 |
| `guide/图床使用指南.md` ★ | 图片托管、直链与压缩 |
| `guide/音频床使用指南.md` ★ | 音频托管（音乐与语音留言）、直链与 `[@音频/ID]` 引用、格式兼容性 |
| `guide/投票箱使用指南.md` ★ | 创建投票、嵌入博客 |
| `guide/cattca-guide.md` ★ | Cattca 互动叙事入门（零基础） |
| `guide/cattca-syntax.md` | Cattca 脚本语法参考（命令逐条） |
| `guide/内容引用语法指南.md` | `[@<内容ID>]`、`[@用户/用户名]` 与 `[@音频/<ID>]` 在博客 / 评论 / 讨论里嵌入内容 |
| `guide/表情包使用指南.md` | 在评论与讨论中使用内置表情和图片合集 |
| `guide/头像框使用指南.md` | 选择、租用、到期和上架新款 |
| `guide/头像框出图规范.md` | 画师交付所需的画布、几何、配色、命名与自查 |
| `guide/收藏夹使用指南.md` ★ | 收藏夹：私密 / 站内共享的区别、复制、分享、导入导出 |
| `guide/每日一言使用指南.md` | 签到弹窗、全站每日同句、往期回看、共鸣投喂、私密一言集、投稿审核与经典出处 |
| `guide/story-module.md` | 故事模块：文件结构 / 合集嵌套 / URL |
| `guide/编辑器使用指南.md` | 编辑器：手机上的工具条与「更多工具」、Enter 与 Shift+Enter 的差别、预览与导出 |
| `guide/格式转换器使用指南.md` | 本地转换、预设、结果损失说明与限额 |
| `guide/个人主页使用指南.md` | 主页内容、布局、配色与移动端调整 |

★ = 被站内页面渲染（`/clipboard/guide` · `/image/guide` · `/audio/guide` · `/vote/guide` · `/favorite/guide` · `/tool/cattca-guide`）

## 开发与运维

| 文档 | 讲什么 |
|------|--------|
| `architecture.md` | 进程、数据归属、跨模块边界与典型读写路径 |
| `access-control.md` | 角色分档、账号归档、软删除与资源标识 |
| `content-rendering.md` | 博客与剪贴板的编译、引用、首屏、预览与导出 |
| `daily-quote.md` | 每日发行、版本审核、共鸣结算与迁移边界 |
| `deploy.md` | 从零到上线：环境、`.env`、数据库、systemd、nginx、TLS、备份、排障 |
| `realtime.md` | 与主站统一配置、共同启停的实时服务：Wand demo、一次性票据、权限复核、连接限制和部署 |
| `cli.md` | 运维 CLI：交互式向导 / 命令式用法；角色、用户、内容检索与恢复、鱼干、头像框、邀请码、审计、申诉 |
| `oauth.md` | raricy 作为 OAuth 2.0 IdP 的完整协议与集成 |
| `frontend-styles.md` | 全站设计标准：视觉基础 / 布局 / 组件 / 动效 / 场景组合 / 实现与验收 |
| `design-philosophy.md` | **可整份转发**的设计哲学：相信什么 / 拒绝什么 / 怎么判断，附一页实现参照（不引用源码） |
| `known-red.md` | 测试与构建排障：核对当前前提，再按日志确认原因与修法，不凭历史记录跳过失败 |
| `testing.md` | 测试基建口径：两层 runner 的库隔离、e2e 单库双 project、retries 语义与顺序依赖规避 |
| `assets-licenses.md` | 素材来源与许可：四类静态素材的生成脚本与许可、第三方图标清单、再分发规则 |
| `agent-domain-rules.md` | 子系统修改约定：按功能查询业务边界、实现注意事项与源码入口，无需每次任务通读 |
| `instance-restore.md` | 从 `instance.zip` 还原数据目录与数据库（灾备） |
| `legacy-constraints.md` | 历史遗留约束：哪些不能删、为什么（含「不是框架痕迹」的辨析）；注释清理口径与已解决问题记录 |
| `source-header-style.md` | 源码头注释约定：头里只留职责 / 唯一出口 / 改动注意，长背景抽到设计说明；含抽取判断与 `npm run lib:headers` |
| `source-design-notes.md` | 从 `src/lib` 文件头抽出的设计背景、踩坑与取舍（当前规则仍以文件头为准） |
| `market-design-notes.md` | 从 `market-*.ts` 文件头抽出的行情源、结算、强平与统计的设计背景 |
| `src-lib-index.md` | `src/lib` 根目录 TS 文件索引：行数、职责与导出（`npm run lib:index` 生成，勿手改） |

## 计划与历史

下一步与候选项见 `plan/README.md`。故事区重做、异文第二章、切页动画和维护工作的设计按主题从该页进入。已交付的每日一言、ReactiveMD、讨论区、编辑器、格式转换器、手工间与测试审计记录在 `docs/archive/`，站内目录提供逐篇入口。

## bot/ —— 站外机器人开发者

机器人文档供站外开发者独立对接。变更配额或错误码时，同步受影响的接口文档，约定见 `../CLAUDE.md` 的限频说明。

| 文档 | 讲什么 |
|------|--------|
| `bot/chat-bot.md` | 讨论消息、SSE、正在输入、已读与限频 |
| `bot/comment-bot.md` | 评论区的读取、轮询、发言与限频 |
| `bot/blog-bot.md` | 栏目、发文、修改、对外可见性与限额 |
| `bot/vote-bot.md` | 创建、投票、查询、锁定与删除 |
| `bot/checkin-bot.md` | 签到资格、每日奖励与重复请求 |
| `bot/like-feed-bot.md` | 文章与评论点赞、投喂、互动名单与删除自己的评论 |
| `bot/image-bot.md` | 上传、批量结果、配额、图片直链与引用 |
| `bot/audio-bot.md` | 音频上传、格式识别、配额、直链与引用 |
| `bot/clipboard-bot.md` | 内容片段的读写、引用与可见范围 |
| `bot/account-bot.md` | 账户资料、通知、公开主页、禁言历史与邀请码 |
| `bot/fish-bot.md` | 凭据、转账、余额、流水、收银台与收款回调 |
| `bot/fish-bank-example.md` | 可运行的收款、提现、回调与对账示例 |
| `bot/trade-bot.md` | 行情、开平仓、结算、成交价格与接口限频 |
| `bot/favorite-bot.md` | 读取共享收藏夹和所有者写入接口 |

## 相关

- `../CLAUDE.md` —— Claude Code、Codex 等 agent 共用的工作流、验证纪律与按需阅读索引
- `../README.md` —— 快速开始、命令一览、部署要点
