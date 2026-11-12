# src/lib 根目录索引

> 本文件由 `npm run lib:index` 生成（`scripts/lib-index.ts`），请勿手改；守卫见 `tests/unit/lib-index-guard.test.ts`。

范围：`src/lib` 根目录下全部 `*.ts`，不含 `md-editor/`、`reactive/` 等子目录。

- 文件数：146
- 合计行数：31897（含空行）

| 文件 | 行数 | 导出数 | 一句话职责 |
| --- | ---: | ---: | --- |
| `account-service.ts` | 446 | 16 | 账号 / 凭据事实：注册建号、邀请码核销与升级、改密。 |
| `admin-appeal-service.ts` | 317 | 6 | 申诉列表 + 裁决 |
| `admin-blog-service.ts` | 254 | 7 | 文章管理业务逻辑 |
| `admin-category-service.ts` | 223 | 8 | 栏目管理业务逻辑 |
| `admin-clipboard-service.ts` | 177 | 6 | 云剪贴板的管理端检索与恢复（**含已软删 / 已隐藏**） |
| `admin-comment-service.ts` | 109 | 3 | 评论的管理端检索（**含已软删**） |
| `admin-image-service.ts` | 161 | 5 | 图床的管理端检索与恢复 |
| `admin-log-extra.ts` | 60 | 3 | `admin_action_logs.extra` 的唯一读写入口 |
| `admin-stats-service.ts` | 135 | 2 | 站点概览 |
| `admin-user-service.ts` | 743 | 25 | 用户管理 / 禁言 |
| `admin-vote-service.ts` | 167 | 6 | 投票的管理端检索与恢复 |
| `anon-identity.ts` | 144 | 6 | 匿名评论的**化名**：名字表、发号、按名生成头像 |
| `archive-scope.ts` | 58 | 1 | （文件头未注明职责） |
| `audio-refs.ts` | 192 | 13 | `[@音频/<ID>]` 引用语法的（纯逻辑 + DOM 构造） |
| `audio-service.ts` | 215 | 10 | 音频床元信息读取 / 删除 / 配额 |
| `audio-upload.ts` | 337 | 11 | 音频床二进制上传 |
| `audit-actions.ts` | 350 | 21 | 管理操作日志的**动作词汇表**（中文名、分组、配色档、metadata 说法） |
| `audit-context.ts` | 57 | 3 | 「这条审计日志是谁写下的」 |
| `audit-service.ts` | 530 | 10 | 管理审计公示 + 申诉 |
| `auth.ts` | 114 | 7 | 服务端取当前用户 + 角色/禁言判定 |
| `avatar-refs.ts` | 37 | 2 | 头像地址的**唯一**出处（零依赖，浏览器侧也能 import） |
| `avatar.ts` | 48 | 3 | 头像解析（/api/avatar/[id] 与画报渲染共用） |
| `blog-directory.ts` | 15 | 4 | 博客目录的范围词表；不依赖服务端模块，供筛选条和个人侧栏共用。 |
| `blog-excerpt.ts` | 313 | 6 | 把 Markdown / ReactiveMD 正文压成一段纯文本摘要（纯函数） |
| `blog-limits.ts` | 20 | 3 | 博客“标题 / 描述 / 正文”长度上限的**唯一定义** |
| `blog-public-scope.ts` | 70 | 5 | 「公开文章集合」的**唯一定义**（可索引 = visibility public） |
| `blog-service.ts` | 1653 | 49 | 博客业务逻辑（纯函数 + 显式参数；软删除：Blog.ignore = true 一律排除） |
| `blog-sort-pref.ts` | 18 | 3 | 博客列表排序偏好的存储键（零依赖，server/client 共用） |
| `blog-visibility.ts` | 91 | 8 | 文章对外可见性的**词汇表**（三档的名字、白名单、解析、人话标签） |
| `broadcast-groups.ts` | 24 | 3 | 群发通知的目标用户组（**单一真相源**） |
| `broadcast-service.ts` | 89 | 4 | 管理员群发通知 |
| `bubble-refs.ts` | 48 | 10 | 气泡定义只住代码，客户端与服务端共用；不接收用户提供的 CSS、HTML 或外链素材。 |
| `bubble-service.ts` | 104 | 7 | 气泡持有与装备的唯一写入者。权威在 user_bubbles，users 装备列是副本： |
| `bubble-shop-service.ts` | 64 | 3 | 气泡租赁：与扣款同事务授予，续期基准在事务内读取，防并发少发租期。 |
| `chat-bus.ts` | 173 | 8 | 讨论 SSE 的进程内订阅注册表（服务端专用） |
| `chat-markdown.ts` | 44 | 1 | 讨论正文的 Markdown → 安全 HTML |
| `chat-message-interaction.ts` | 144 | 9 | 讨论消息的指针交互判据（零依赖） |
| `chat-presence.ts` | 78 | 4 | 「谁正在看哪个会话」（服务端专用，进程内） |
| `chat-service.ts` | 75 | 6 | 讨论域对外 API 聚合层（纯 barrel，实现在 src/lib/chat/） |
| `chat-shared.ts` | 204 | 23 | 讨论区「纯常量 + DTO 类型」，供服务端与客户端共享。 |
| `chat-sidebar-pref.ts` | 16 | 3 | 讨论侧栏折叠偏好的存储键（零依赖，server/client 共用） |
| `chat-viewport.ts` | 104 | 6 | 讨论区整屏工作台的「软键盘让位」纯逻辑（零依赖） |
| `checkin-service.ts` | 246 | 8 | 每日签到业务逻辑 |
| `clipboard-limits.ts` | 8 | 2 | 云剪贴板的**对外可见上限**（零依赖，服务端与客户端共用）。 |
| `clipboard-query.ts` | 93 | 3 | 云剪贴板的**只读**查询（含公开性判定） |
| `clipboard-service.ts` | 317 | 18 | 云剪贴板业务逻辑 |
| `comment-markdown.ts` | 49 | 1 | 评论正文的 Markdown → 安全 HTML |
| `comment-service.ts` | 1056 | 21 | 评论业务逻辑 |
| `comment-shared.ts` | 27 | 2 | 评论区「纯常量」，供服务端与客户端共享。 |
| `content-format.ts` | 43 | 9 | Stored language and write gate. Rendering choices never change this value. |
| `content-refs.ts` | 370 | 23 | `[@<内容ID>]` 引用语法的**纯逻辑**（识别 / 替换 / 截断） |
| `credential-auth.ts` | 106 | 3 | 「用户名 + 密码」校验（两个门口共用） |
| `daily-quote-service.ts` | 727 | 21 | 每日一言：全站 UTC+8 每日固定一句。社区只选登一次，经典在社区候选耗尽后循环。 |
| `daily-quote.ts` | 111 | 17 | 客户端与服务端共用的每日一言词表、长度与展示契约；不引入数据库或 Node 模块。 |
| `db-time.ts` | 83 | 6 | 写库时间戳的统一约定 |
| `db.ts` | 43 | 1 | （文件头未注明职责） |
| `docs-catalog.ts` | 653 | 14 | 站内文档页（/docs）的**登记表**与 URL 口径 |
| `docs-service.ts` | 218 | 4 | 把一份登记在案的文档读出来、渲染成 HTML（服务端专用） |
| `emoji-faces.ts` | 90 | 9 | 内置「黄脸表情」合集的清单与地址 |
| `favorite-refs.ts` | 92 | 8 | 收藏夹引用语法 `[@<六位收藏夹ID>]` 的**纯逻辑**（id 词汇 + 盖码） |
| `favorite-service.ts` | 695 | 25 | 收藏夹业务逻辑 |
| `feed-fee-refund.ts` | 177 | 3 | 历史投喂手续费返还（CLI fish refund-feed-fees）。 |
| `feed-service.ts` | 308 | 6 | 文章投喂小鱼干 |
| `fish-admin.ts` | 133 | 4 | 管理员手动发/扣小鱼干（运维 CLI 与补偿批量的底层实现） |
| `fish-amount.ts` | 70 | 7 | 鱼干**金额**的展示与解析（「能有多少位小数」「怎么显示」） |
| `fish-compensate.ts` | 238 | 8 | 群发补偿（CLI `fish compensate`） |
| `fish-idempotency.ts` | 167 | 9 | 鱼干写路径的幂等登记 |
| `fish-service.ts` | 409 | 16 | 小鱼干服务 |
| `fish-token-limits.ts` | 3 | 2 | 零依赖：只读凭据服务与页面共用的数量边界。 |
| `fish-token-service.ts` | 179 | 14 | 鱼干**只读**凭据的签发 / 校验 / 吊销 |
| `fish-transfer-service.ts` | 588 | 10 | 鱼干转账：用户间转账 / 收银台 / 收款人查询（无手续费） |
| `fish-units.ts` | 57 | 5 | 鱼干的存储单位 ↔ 业务单位换算 |
| `fish-webhook-service.ts` | 673 | 22 | 鱼干收款回调：地址配置 + outbox + 投递 |
| `focus-mode.ts` | 158 | 14 | 专注模式共享字面量 / 判定（零依赖，server/client 均可 import） |
| `focus-service.ts` | 138 | 7 | 专注模式的读路径（需要 prisma 的那部分） |
| `format.ts` | 59 | 6 | 序列化 / 展示辅助 |
| `frame-refs.ts` | 263 | 15 | 头像框的**词汇表**（白名单、解析、人话标签、到期判定） |
| `frame-service.ts` | 707 | 22 | 头像框素材域（扫盘 / 缓存 / 查表）+ 持有与装备 + 判定唯一出口（server-only） |
| `frame-shop-service.ts` | 313 | 5 | 鱼干商城：用鱼干**租**头像框（server-only） |
| `game-catalog.ts` | 268 | 14 | 玩具清单只描述陈列方式（标题 / 简介 / 分类 / 模式 / 图标 / 归属合集）；引擎按页面加载， |
| `guard.ts` | 76 | 4 | （文件头未注明职责） |
| `http-cache.ts` | 87 | 4 | 原始字节路由（图床 / 音频床）共用的**条件请求**词汇 |
| `https-guard.ts` | 204 | 9 | 「练手盘与玩具区只走 https」的判据（零 import，Edge 中间件可直接吃） |
| `identicon.ts` | 76 | 1 | 原生 GitHub 风格点阵头像（SVG） |
| `image-client.ts` | 263 | 10 | 浏览器侧「选图 → 图床上传」的公共部分（讨论与评论共用） |
| `image-service.ts` | 201 | 10 | 图床元信息读取 |
| `image-sniff.ts` | 338 | 13 | 「这串字节到底是什么图片」的**单一真相源**（零依赖、零 import） |
| `image-upload.ts` | 283 | 16 | 图床二进制上传 |
| `invite-code.ts` | 201 | 7 | 邀请码生成 |
| `json-ld.ts` | 37 | 1 | 结构化数据（schema.org）的安全出口 |
| `legacy-redirect.ts` | 10 | 1 | （文件头未注明职责） |
| `linkify.ts` | 66 | 2 | 纯文本里的 URL 识别（讨论消息正文用） |
| `market-candles.ts` | 110 | 11 | K 线的**词汇表**：周期、根数上限、线上形状、缓存键 |
| `market-chart.ts` | 435 | 27 | K 线图的全部**纯计算**：窗口、聚合、刻度、映射、实时并线 |
| `market-leverage.ts` | 154 | 13 | 练手盘的**杠杆与方向词表**（零依赖） |
| `market-liquidator.ts` | 386 | 10 | 练手盘的**强平引擎**（本站第一个「自己动手动钱」的后台循环） |
| `market-math.ts` | 156 | 5 | 练手盘结算的**唯一公式**（含杠杆与爆仓） |
| `market-poll-drainer.ts` | 105 | 4 | 练手盘行情的**进程内**定时刷新 |
| `market-price.ts` | 494 | 17 | 练手盘的行情源（币安公开行情域） |
| `market-service.ts` | 756 | 15 | 鱼干练手盘的开仓 / 平仓 |
| `market-stats-service.ts` | 57 | 1 | 练手盘个人统计的**读路径**（取数一段） |
| `market-stats.ts` | 250 | 10 | 练手盘的**个人统计**：把已结清的仓位行折成几组数 |
| `market-stream.ts` | 308 | 6 | 练手盘行情的**常驻 WebSocket 消费端**（只喂展示缓存） |
| `mention-service.ts` | 45 | 1 | @ 选人读路径：只返回当前评论区 / 会话里可被提及的用户，不暴露角色或成员状态。 |
| `mention-shared.ts` | 24 | 4 | 评论与讨论共用的 @ 词汇；零依赖，客户端也可直接使用。 |
| `navigation-back.ts` | 48 | 4 | 文章页「返回上页」的落点判据（纯函数，**零依赖**） |
| `notification-service.ts` | 332 | 14 | 通知业务逻辑 |
| `oauth.ts` | 651 | 45 | OAuth 2.0 Authorization Code 核心库（raricy 作为 IdP） |
| `page-window.ts` | 20 | 1 | 分页页码窗口（window-of-3）：始终显示首尾页，当前页 ±window 的页码照常显示， |
| `pagination.ts` | 27 | 2 | 分页参数的**唯一归一入口**（R3-412 / C11） |
| `password-budget.ts` | 15 | 1 | 网络入口的密码计算预算：会话付款、登录、改密、签发凭据共用用户 ID 桶， |
| `password.ts` | 151 | 4 | 与 werkzeug 完全兼容的密码哈希校验/生成 |
| `poster-render.ts` | 165 | 4 | 取数据 → 拼 SVG → sharp 光栅化成 PNG |
| `poster.ts` | 851 | 28 | 画报 / 收款码的 SVG 构造（**纯函数**：不碰 prisma、不碰 sharp、不碰 fs） |
| `profile-blocks.ts` | 589 | 40 | 个人主页「积木」的词汇表与校验（零依赖） |
| `profile-service.ts` | 492 | 7 | 个人主页「积木」的读写 |
| `public-blog-search.ts` | 131 | 9 | 公开正文检索：写入时编译并提取自身静态可见文字，读取时仅查 FTS 候选。 |
| `rate-limit.ts` | 431 | 9 | 限频（进程内 limiter + 快照持久化） |
| `realtime-auth.ts` | 15 | 2 | （文件头未注明职责） |
| `realtime-ticket-service.ts` | 62 | 5 | （文件头未注明职责） |
| `realtime-url.ts` | 22 | 1 | （文件头未注明职责） |
| `request-ip.ts` | 23 | 1 | 客户端 IP 只读取入口 nginx 覆盖的 X-Real-IP，绝不回退到客户端可控的 |
| `rich-text.ts` | 328 | 6 | 用户输入正文 → 安全 HTML 的**共享管线**（marked → DOMPurify → 后处理） |
| `safe-url.ts` | 73 | 3 | 登录回跳地址的安全校验 |
| `saved-message-service.ts` | 408 | 14 | 私聊消息保存箱 |
| `secret-box.ts` | 109 | 4 | 落盘密钥的对称加解密（Fernet） |
| `service-accounts.ts` | 46 | 2 | 服务账号（配额白名单） |
| `session.ts` | 90 | 5 | 基于 JWT 的会话 |
| `shop-refs.ts` | 22 | 5 | 商城共享租期词汇。一个月固定 30 天，展示、校验与续期必须读同一份表。 |
| `short-id.ts` | 20 | 1 | 短 ID 生成 |
| `site-url.ts` | 98 | 3 | 站点对外地址的**唯一**解析处 |
| `spider-service.ts` | 207 | 6 | 机器人（站外爬虫 / 聚合器）只读 API 业务逻辑 |
| `sse.ts` | 51 | 5 | SSE 传输契约的唯一出处（响应头 + 帧格式 + 重连/背压常量） |
| `sticker-refs.ts` | 333 | 13 | 表情包引用语法 `[@合集/表情]` 的纯逻辑 |
| `sticker-service.ts` | 352 | 9 | 表情包素材的扫盘 / manifest / 查找（**server-only**） |
| `story-service.ts` | 531 | 9 | 故事模块服务端读盘 |
| `stream-session.ts` | 73 | 3 | （文件头未注明职责） |
| `topbar-bus.ts` | 177 | 7 | 顶栏指示器 SSE 的进程内订阅注册表（服务端专用） |
| `turnstile.ts` | 129 | 2 | Cloudflare Turnstile 服务端校验。 |
| `upload-quota.ts` | 34 | 3 | 网络上传落库时的存储配额拒绝；路由映射为现有的 400 文案。 |
| `user-archive-service.ts` | 107 | 2 | 归档/恢复仅限后台 CLI。状态、清余额、撤赞、撤凭据与审计必须一次提交。 |
| `user-refs.ts` | 288 | 12 | 用户名片引用语法 [@用户/<用户名>] 的**纯逻辑**（零依赖，可直接单测） |
| `user-service.ts` | 321 | 7 | 用户公开资料 / 本人资料更新。 |
| `vote-service.ts` | 323 | 14 | 投票业务逻辑 |
| `webhook-drainer.ts` | 102 | 4 | 回调投递的**进程内**定时驱动 |
| `webhook-url.ts` | 372 | 10 | 回调地址的校验与「钉住 IP」的投递 |

头注释约定见 `docs/source-header-style.md`。
