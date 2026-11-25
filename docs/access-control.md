# 权限、归档与资源标识

页面、接口和后台 CLI 共用角色与归档语义。新增数据读口或管理操作时，按以下规则选择判断位置。

## 1. 软删除与归档

永不物理删除（站长手动除外）：

**账号归档**：`User.archivedAt` 为非空时按账号级软删除处理，独立于角色与禁言。
归档、恢复及原始资料仅限后台 CLI（`docs/cli.md` 的用户归档节），HTTP 管理页也无豁免。
`archive-scope.ts` 在 Prisma 查询扩展内给用户、自有内容与凭据的读取、计数和修改附加归档过滤；
只有 `scripts/cli.ts` 的 `runAsBackendOps` 异步上下文可绕过，不能通过请求参数开启。
扩展不处理嵌套 relation 和 raw SQL：评论/讨论在共同序列化出口抹掉归档作者及原文、附件、引用摘要，
管理端评论显式过滤作者，讨论 raw 未读 SQL 显式排除归档作者。新增这类读口必须沿用这条边界。

`user-archive-service.ts` 在同一事务内写归档状态、撤销文章/评论点赞并重算冗余计数、
通过 `postEntry` 清空钱包（`archive_clear` 流水）、作废未结清仓位（独立终态 `archived`），
撤销凭据、软隐藏关联通知并记录内部审计。记账内核独立检查 `archivedAt:null`，
即使在 CLI 上下文里也不能再向归档钱包入账。恢复只解除账号状态，原内容的删除标志保留，
余额、点赞、凭据、隐藏通知和作废仓位不恢复。SSE 每帧（含心跳）查数据库复核权限，
覆盖 CLI 与网站不同进程时无法靠内存 bus 踢人的情形。

| 字段 | 默认 | 模型 |
|------|------|------|
| `Blog.ignore` | false | 博客 |
| `BlogComment.isDeleted` | false | 评论 |
| `BlogLike.deleted` | false | 点赞记录 |
| `CommentLike.deleted` | false | 评论点赞记录（同样软删，不物理删除） |
| `ImageHosting.ignore` | false | 图床 |
| `AudioHosting.ignore` | false | 音频床（软删后磁盘文件保留；站长可在管理端硬删，见 `docs/guide/音频床使用指南.md`） |
| `Vote.ignore` | false | 投票 |
| `ClipBoard.ignore` | false | 剪贴板 |
| `ChatMessage.isDeleted` | false | 讨论消息 |
| `Favorite.deleted` | false | 收藏夹（配对 `deletedAt`） |
| `FavoriteItem.deleted` | false | 收藏夹条目（配对 `deletedAt`） |

**软删即抹掉附件与原文**：评论被软删后，序列化时 `content` 与 `content_html` 一律换成
占位文案，`image` / `blog` 一律置空（`image_missing` / `blog_missing` 也置 false —— 软删
不是「附件丢了」）。漏掉任何一项都等于「删了没删」：原文还在 DOM 里，或删掉的图仍能
点开看原图。讨论消息同此口径（`chat-service.ts` 的 `attach…`）。

## 2. 角色体系与鉴权门

游客没有登录会话。`user` 是已经有账号的历史未认证或资格撤销用户。`core`、`admin` 和 `owner` 都是核心成员，管理权和站长权限逐级收紧。请求凭据、角色、禁言与资源所有权分别检查。

| 页面要求 | 入口 |
| --- | --- |
| 核心成员 | `requireCoreUser` |
| 管理员及站长 | `requireAdmin` |
| 站长 | `requireOwner` |

页面级检查在 `src/lib/guard.ts`。未登录时保留返回地址并引导登录，角色不足时就地返回 403。API 自行核对会话与权限并返回相应错误。后台布局允许核心成员访问只读的用户列表；文章管理、审计等页面各自要求管理权，站长专属操作再核对 owner。

**页面与接口必须同档。** 导航项可用于引导登录，按钮是否可见不能决定权限。每个写入口还需核对资源归属。文章的编辑与删除要求核心成员本人；评论删除允许评论作者或管理员。账号降档后，已有内容的归属不会恢复其功能资格。

**公开资源逐项放行。** 文章的可读性与可枚举性由业务服务决定，列表、链接、预览图与公开搜索复用相同判据。对外可见性见 `docs/agent-domain-rules.md` §2.19。接口约定见 `docs/bot/account-bot.md`。

## 3. 标识符与引用

| 实体 | ID |
|------|----|
| User · Blog · BlogContent · Comment · Notification | UUID4 |
| ClipBoard | 短 ID：**base36**（小写字母 + 数字，8 位，`short-id.ts`） |
| Vote · ImageHosting · AudioHosting | 短 ID：**base62**（9 位 / 10 位 / 10 位） |
| Favorite | UUID4（所有者管理页的路由参数；不可枚举，见 `docs/agent-domain-rules.md` §2.21）＋ 可选 `publicId`：**6 位纯数字**，**仅公开收藏夹有值** |
| FavoriteItem | 自增整数（join 行） |
| Category · AdminActionLog · AdminActionAppeal · UserBan | 自增整数 |

裸引用按长度区分收藏夹、剪贴板、投票和图片。音频同为 10 位，使用具名语法 `[@音频/ID]`。新增资源需检查命名冲突与既有稿件的解析结果。作者使用的完整语法见 `docs/guide/内容引用语法指南.md`。
