# Chat ReactiveMD 渲染与机器人流式输出设计

校对日期：2026-11-22。状态：R1/R2 已实施（未 push/上线）；视觉审核与性能测量待站长复核。

本方案采用已确认的范围：聊天消息继续保存原始 `content`，数据库结构和历史正文均不改动；浏览器复用博客的 ReactiveMD 编译引擎。机器人通过新增接口提交生成中的文本，完成后进入现有正式消息发送流程。本文是实施契约与代理分工；R1/R2 已按此落地，尚未 push/上线。

## 1. 决策与交付范围

| 项目 | 本轮决定 |
| --- | --- |
| 存储 | 保留 `chat_messages.content` 及既有附件字段，不增加 `format`、`syntax_version`、生成任务表或 AST 快照 |
| 解析 | 正式消息在前端统一按 Markdown 与 RMD 混合源码编译，不对内容猜测格式 |
| 编译器 | 复用 `src/lib/reactive/compile-source.ts` 与 `reactive-md@0.9.2`；聊天使用独立配置 |
| 渲染 | 首版 `LocalDocumentView` 采用静态模式；展示公式和允许的静态组件，控件只读 |
| 引用 | 保留聊天现有图床、剪贴板、音频、表情、黄脸和名片语义，由聊天适配器处理 |
| 机器人 | 站外机器人继续使用自己的 core+ 账号和会话 cookie；本站接收文本，不负责请求模型 |
| 实时投递 | 扩展主站 `/api/chat/stream`，临时事件不占用消息游标 |
| 生成状态 | 主站 Next 进程的有界内存状态，挂 `globalThis`；重启后失效 |
| 实施阶段 | R1 正文渲染、R2 机器人流式接口分别验收和提交 |

首版不增加聊天编辑器、RMD 交互状态持久化、模型密钥配置、续写服务或跨重启生成恢复。若以后开放消息内交互，需要单独确认允许的组件、运行预算及读者状态生命周期。

无版本字段意味着所有历史消息按当前锁定的 RMD 版本重新解释。普通 Markdown 与 RMD 的语法有重叠，旧文本中的组件标签、插值、原生 HTML 可能改变解释；上线前用旧消息样本评估这些变化。升级依赖时做相同回归，不自动重写历史正文。

## 2. 当前实现与复用边界

| 现有入口 | 当前职责 | 本轮接法 |
| --- | --- | --- |
| `src/app/chat/ChatMarkdown.tsx` | 包装 `RichContentBody` | 替换为聊天 RMD 包装组件 |
| `src/lib/chat-markdown.ts`、`src/lib/rich-text.ts` | marked、净化及 DOM 引用后处理 | 评论保留；聊天完成切换后退出这条调用链 |
| `src/app/components/RichContentBody.tsx` | 剪贴板、名片取数，媒体降级、裸图和灯箱 | 提取或重用纯规则；聊天以 React 组件实现相同行为 |
| `src/lib/reactive/compile-source.ts` | 统一编译入口及异常输入预算保护 | 直接复用，不复制 parser |
| `src/lib/reactive/compile.worker.ts` | 单文档编译会话与 Worker 协议 | 复用会话/API 用法；聊天新增多任务编译入口 |
| `src/app/components/reactive/CompiledDocumentView.tsx` | 文档 runtime 与通用视图 | 其当前 URL 策略偏向博客；聊天单独包装视图与策略 |
| `src/lib/reactive/ref-adapter.ts`、`SiteEmbedView.tsx` | 博客引用和业务组件 | 不整体接到 Chat；可抽取纯 AST 工具，保持场景规则分离 |
| `src/lib/chat/messages.ts` | 发送、序列化、广播、未读、提及 | 流式完成仍走这里；补内部持久化回执 |
| `src/lib/chat-bus.ts`、`src/app/api/chat/stream/route.ts` | 按可见频道投递及正式消息补齐 | 增加无 SSE id 的临时生成事件 |

`services/realtime/` 当前负责独立实时游戏。聊天生成状态、会话验证和 SSE 均留在主站，避免增加跨进程通道。

架构背景见 `docs/architecture.md` §6.7/§6.23；引用约束见 `docs/agent-domain-rules.md`；机器人现行接口见 `docs/bot/chat-bot.md`。实施完成时再更新这些文档的现行行为描述。

## 3. 前端渲染流程

```text
正式消息 content / 生成中的累计 source
  → Chat 页面共享编译队列
  → Worker 内 compileSource(source, chatOptions, phase)
  → 检查并收缩文档能力
  → Chat AST 引用适配
  → 按当前查看者取引用数据
  → LocalDocumentView(mode="static") + ChatHostView
  → 原有气泡、附件、消息菜单与详情外壳
```

源码、编译文档和引用数据分开保存。Worker 只接收源码与可序列化编译参数，不接收 cookie、用户资料、资源响应或权限数据。

### 3.1 聊天配置与能力

新增 `CHAT_RMD_COMPILE_OPTIONS`，使用现有 `LocalCompileOptions`：

```ts
const CHAT_RMD_COMPILE_OPTIONS = {
  strict: false,
  markdownBreaks: true,
  enableCss: false,
  enableJavaScript: false,
  enableExtendedHtml: false,
  limits: {
    maxSyntaxNodes: 10_000,
    maxParseWork: 1_000_000,
    maxMarkdownDepth: 64,
  },
};
```

这些预算是首版初值，需用消息样本测量，调整时同步配置身份和预算用例。正文输入沿用 `CHAT_TEXT_MAX`/`CHAT_CAPTION_MAX`，目前都是 trim 后 5000 个 JavaScript 字符单位；流式内存还约束未 trim 的累计长度。

静态模式不承担权限隔离。文档策略还要检查节点、属性以及 document 上的 capabilities、组件定义和计算信息：作者脚本、样式、网络组件、iframe、未批准的宿主节点均不得进入聊天运行时。M0 允许列表包含现有 Markdown 节点、无副作用的公式展示、minimal preset 的静态展示组件 `alert` / `badge` / `panel` / `card` / `section` / `grid` / `text`，以及 P0 HTML 的 `div align`；组件只保留各自白名单里的静态属性，属性值含插值即回退源码。输入控件、条件组件与表达式仍按源码显示。

原生图片节点默认转回字面量，只有聊天引用适配器生成的受控媒体组件可以加载图片。源码不能通过伪造 `chat-ref` 标签获得引用权限，宿主数据必须来自适配器登记的槽位并二次验证字段。

聊天链接继续限制为站内路径、http(s) 和 mailto，跨站加 `noopener noreferrer nofollow` 与新标签页行为。使用 `chat-msg__link` 样式；不直接照搬博客允许外部图片的 URL 策略。

### 3.2 历史消息与 Worker 队列

一个 Chat 页面建立一个编译管理器和一个 Worker，列表中每条消息订阅自己的结果。独立保存页面同样通过页面级 provider 共享管理器，列表与详情共用。历史消息使用独立的 final 编译任务，按 `request_id` 回收结果；生成任务按 `generation_id` 管理会话。Worker 内的会话数量有上限，终态、频道离开或过期时释放。

`LocalCompileScheduler` 是单文档 latest-wins 调度器，不能把 300 条历史消息逐个传给同一 scheduler，否则会丢掉尚未编译的消息。聊天管理器维护多文档队列，同一 generation 只保留最新待编译快照；可复用上游编译会话和基础 Worker 协议，但不复用跨文档增量 baseline。

初始策略：视口内正式消息 final 优先，随后处理生成中的最新快照，再处理视口附近的消息。离屏内容先显示源码，进入视口再排队。连续流式任务与历史任务采用轮转，防止其中一类长期饥饿。正在执行的同步编译不能抢占，优先级只影响尚未执行的任务。

缓存只保存不可变 final 编译结果，初始上限 300 条及估算 16 MiB，两者任一到顶即淘汰。键包含源码身份、RMD 版本、Chat 配置版本和文档策略版本；哈希命中还要核对源码。引用适配创建副本，权限数据不放进 AST 缓存。私聊内容不写 localStorage、IndexedDB 或服务端编译缓存；切换账号、退出聊天时释放页面内存。

每次回调同时核对页面 epoch、消息/generation key、revision 和 phase。删除、频道切换、取消、组件卸载后的结果丢弃；streaming 的旧结果不能覆盖 final。取消单个任务只撤销订阅与队列项，不终止共享 Worker。

### 3.3 失败与正文入口

编译失败、超预算或 Worker 不可用时，React 文本节点显示完整源码，使用 `white-space: pre-wrap`。首版不在主线程批量补编译。诊断只记录错误码、版本和耗时，不把私聊正文写入日志。

替换所有实际复用 `ChatMarkdown` 的正文位置，包括消息列表、详情、搜索结果和保存消息页；实施时以调用点搜索为准。复制仍复制存储源码，回复摘要、通知摘要、侧栏预览保持既有纯文本逻辑。拍一拍和已删除消息保持独立分支。

保存页若由服务端传入消息，服务端与客户端首帧都先显示同一份转义源码，挂载后再请求浏览器编译，避免水合不一致。不要为了该页面给聊天增加服务端 RMD 编译链。

## 4. 聊天引用兼容矩阵

| 内容 | 本轮行为 | 限额与失败行为 |
| --- | --- | --- |
| 10 位图床引用 | 受控 React 图片，沿用 `/api/images/:id/raw` 权限 | 最多 50 个；保留现有不可用展示，不绕过 raw 授权 |
| 8 位剪贴板引用 | 按当前查看者同源读取，Markdown / ReactiveMD 子文档内联一层 | 最多 1 条；正文超过 2000 字截断并给回链；不递归 |
| 未知格式剪贴板 | 站内回链 | 库内认不出的格式不进聊天；旧响应缺格式时沿用现有 Markdown 兼容 |
| 9 位投票、6 位收藏夹 | 保留字面量 | 不因复用博客编译器而新增展开能力 |
| `[@音频/ID]` | 原生音频控件，`preload="none"` | 最多 3 个；媒体解码错误也保留播放器，只有非法 URL / 载荷回原 token；raw Range 路径不变 |
| `[@合集/表情]`、内置黄脸 | 站内受控资源 | 两类共计最多 30 个；错误名字或资源失效回原 token |
| `[@用户/用户名]` | 头像、头像框和站内主页链接 | 最多 5 个位置；失败回原 token；不触发 @ 通知 |
| 独立 `image_id`、`blog_id`、回复附件 | 继续使用现有消息 DTO 和卡片 | 不塞回正文 AST |

从正文 AST 的 text 节点识别引用。跳过完整 link 子树、code、inlineCode、fallback 及被拒绝的结构；行内代码、围栏代码、缩进代码里的 token 保持字面量。链接内嵌强调的情况也跳过，这会收紧旧 DOM walker 的少数边界行为，需单独回归。

表情与名片沿用各自模块的白名单、上限和保留命名空间，正则不得放宽空白匹配。名片数据根据当前查看者读取 `/api/users/:name`，只使用现有公开字段。引用请求并发初始上限 4，按查看者与页面作用域去重；切账号或权限失效清理。剪贴板失败不长期缓存，不显示服务端返回的私密标题或正文。

剪贴板作为子文档独立编译，使用同一 Chat 静态安全策略，避免与父正文拼串后改变 Markdown 结构。子文档中的图床、音频和表情继续受父消息的总预算限制，子剪贴板不再展开；名片沿用已有取数范围。按最终可展示 AST 收集请求，代码或链接里的名字不占取数预算。AST 编译完成即释放 Worker 执行槽，引用适配在队列之外进行；子编译重新排队，避免占着唯一执行槽等待自己的子任务。

保留 `rich-sticker-ref`、`rich-emoji-ref`、`rich-emoji-solo` 等样式契约。裸图规则由最终可见结构计算：无其他正文、恰一张允许的图片，且消息无独立图片/博客附件及 missing 占位。根节点继续直接使用 `chat-msg__md` 和必要的 `chat-msg__md--single-image`，满足气泡样式的直子级关系。图片降级为文本时同步撤掉裸图状态。

流式预览首版只编译正文与公式，所有站内引用保留 token，链接渲染为无可导航 href 的文本；允许的公式和节点也不启动资源请求。final 后再取引用数据。这样半个 token 和随后被修正的片段不会触发媒体或资源请求。

## 5. 机器人生成接口

新增接口复用现有 cookie 会话、core+、禁言、专注模式、频道成员和 CSRF 规则。author 从会话取得，客户端不能指定。generation id 不是授权凭据；所有生产者接口仅任务作者可调用。首版生成只带文本与可选 `reply_to`，图片和博客可通过正文引用或既有正式接口发送。

| 方法与路径 | 请求 | 响应核心字段 |
| --- | --- | --- |
| `POST /api/chat/channels/:id/generations` | `{client_request_id, reply_to?}` | `generation_id, next_seq, idle_timeout_ms, max_duration_ms` |
| `POST /api/chat/generations/:id/chunks` | `{seq, delta}` | `accepted_seq, next_seq, revision` |
| `POST /api/chat/generations/:id/complete` | `{last_seq}` | `status, message_id, chat_message?` |
| `POST /api/chat/generations/:id/cancel` | `{}` | `status: "cancelled"` 或既有终态 |
| `GET /api/chat/generations/:id` | 无 | `status, next_seq, revision, message_id?` |

使用现有 JSON 信封 `{code, message, ...data}`。新增响应里的 `message` 固定为提示字符串，正式消息对象放 `chat_message`，避免复制现有发送 API 中 `message` 被对象覆盖的特例。上述字段、错误标识均为待实现的新协议。

`client_request_id` 使用客户端生成的 UUID。幂等键为 `(author_id, channel_id, client_request_id)`，重复请求核对 `reply_to` 等规范化元数据，冲突返回 409。鉴权后先查重，再判断活跃任务和限频；同进程回执保留期内重复创建返回同一个 id。机器人必须保留该 key，不因网络超时生成新 key。

`seq` 从 1 开始，为正安全整数；`delta` 必须为非空字符串。接受 `seq === next_seq` 后追加正文、递增序号和 revision；旧序号且 delta 相同返回原结果，既不追加也不广播；旧序号内容不同或跳号返回 409，并给 `next_seq`。空闲续期只发生在新片段被接受时，重放请求不能无限续命。

`complete.last_seq` 必须与最后接受的序号一致，防止尚未上传完成就发布。完成接口不再附带新正文，最后一个分块先收到确认再 complete。未提交片段的任务使用 `last_seq: 0`，并按空正文校验失败。空正文、超长和无效回复目标沿用正式发送校验。

新增错误统一给稳定的机器标识 `error`。参数错误 400、未登录 401、失权 403、未知任务 404、序号/元数据/状态冲突 409、仍保有过期回执的任务 410、请求过大 413、限频 429；容量不足 503。finalizing 时 cancel 返回 409，重复 complete 共用同一结果。终态 GET 在仍有回执且作者有权时返回 200，通过 `status` 和 `error` 描述结果；重复 complete 返回保存的原 HTTP 状态和结果，completed 必有 `message_id`。回执同时保存 `last_seq`、状态、错误与正式 id，避免重复请求的响应漂移。

### 5.1 初始资源预算

| 预算 | 首版建议 | 记账位置 |
| --- | --- | --- |
| 每作者活动任务 | 1 个，含 finalizing | 内存状态 |
| 全站活动任务 | 32 个 | 内存状态 |
| 累计源码 | 沿用 `CHAT_TEXT_MAX`，未 trim 内容也受限 | 每次接收片段前 |
| 单片段 | 最多 1024 个 JavaScript 字符单位，最多 8 KiB HTTP body | 路由限长及服务校验 |
| 每任务片段 | 最多 512 个 | 内存状态 |
| 空闲 / 总时长 | 120 秒 / 10 分钟 | 单调经过时间；不使用库内墙上时钟相减 |
| 创建速率 | 每作者 12 次/分钟，另限制 HTTP 请求洪泛 | 新 `RULES` 项，实施时同步对外文档 |
| 临时广播 | 每任务最多约 10 帧/秒，合并为最新完整快照 | 生成状态服务 |
| 终态回执 | 最长 15 分钟，全站最多 4096 条 | 有界回执缓存 |

这些数值是方案初值，未修改当前 `RULES`。回执超容量会提前淘汰，接口文档必须说明保留期是上限。generation 完成后释放正文与片段缓冲，仅保留元数据、序号指纹与正式消息 id。总时长限制开始 complete 的截止时刻；finalizing 中的超时不能释放唯一提交权或将任务恢复为 active。

正式 `chatMinute`/`chatDaily` 配额只在 complete 调用现有发送逻辑时扣一次。create/chunks 使用独立的流量和并发预算。生成完成仍可能遇到正式发言 429，此时终止任务并给明确错误；首版不预留发言名额，不引入外部可传的 `skipRateLimit`。机器人若希望重新发送，必须先处理这个已知失败，不能对所有错误盲目重试。

路由在读取完整 JSON 前执行 body 字节限制，不能只信 `Content-Length`。过期清扫使用一个可释放的共享定时器，并在每次操作前补查；测试显式复位内存和定时器。

## 6. 生成状态机与发布回执

```text
active → finalizing → completed
   │          ├────→ failed
   │          └────→ commit_unknown
   ├────→ cancelled
   └────→ expired
```

generation 保存 author、channel、reply、累计源码、序号、revision、时间、已接受片段的比对信息及 finalizing Promise。状态变更按任务串行。先完成会话与访问检查，再在同步临界段重查幂等映射、身份、状态、有效期和容量，并登记占位/提交权；登记后才能 await 创建或发送的后续动作。chunk/cancel 也在异步鉴权之后同步复查并变更状态，避免把鉴权开始时的旧快照当成当前状态。

complete 原子地将 active 改为 finalizing，冻结源码，并登记同一个 Promise。同参数并发 complete 共用结果；不同 `last_seq` 拒绝。finalizing 拒绝 chunk 和 cancel，清扫不能把它当 active 过期删除。cancel 先取得状态锁则不发布；complete 先取得锁则不能承诺取消成功。

### 6.1 唯一正式发送出口

生成服务调用 `src/lib/chat/messages.ts` 中现有发送内核，继承最终权限、正文长度、回复有效性、配额、软删除、提及与未读规则。`chat-service.ts` 继续只做 re-export。不得在 generation 模块另写 `prisma.chatMessage.create` 或另发一次 @ 通知。

现有发送过程在 `prisma.chatMessage.create` 之后仍有异步 DTO 构建。需要补一个仅内部使用的持久化回执：取得新消息 id 后、任何后续 await 前，立即同步记录到 generation。内部回执钩子不接受 HTTP 输入、不允许抛异常影响已提交结果；普通发送调用方无需传入。

一旦记录了 `message_id`，后续 DTO、广播或通知失败都按已提交处理，complete 返回 `status: "completed"` 和 `message_id`。客户端可用现有列表/补齐读回正式消息，禁止再次进入发送内核。内存回执必须在完整发送 Promise 结束前就生效。

如果写库调用抛错且无法确认是否提交，进入 `commit_unknown`，返回 `error: "commit_unknown"` 和 `retryable: false`，不把任务恢复成 active。只有能证明未写入的校验或限频失败才归入 failed；首版所有终态都不自动重新发送。

本方案保证同一进程、有效回执仍在时重复 complete 不重复写入。进程崩溃、重启或回执淘汰后，404/410 不能证明原请求没有发布。机器人需查询近期频道消息并由自己的发送记录辅助核对；源码相同不能作为严格唯一证据。跨重启精确幂等需要持久标识，本轮在不改数据库的约束下不承诺这项能力。

### 6.2 权限与副作用

每次 create、chunk、complete、cancel、状态查询均重新验证生产者；complete 再判频道与回复目标。失权任务停止接收，清空尚未发布缓冲。流接收者继续经过 `verifiedStreamWriter`，权限变化不得绕过现有踢连接与逐帧校验。

临时内容不建立消息 id，不推进 read、不创建未读、不更新侧栏 last_message、不发站内通知。正式发布只执行一次既有 @ 处理，仍基于最终原始正文；`[@用户/名字]` 和表情 token 不变成提及。读会话时清提及、在看时不发铃铛通知的规则继续由现有代码决定。

生成过程中不占 SQLite 事务，也没有事务内外部 HTTP。资源取数由当前读者在浏览器独立授权。

## 7. SSE 协议与客户端交接

现有事件类型仍放在 JSON `type` 字段，客户端继续使用一个 `onmessage`。新增事件不写 SSE 的 `id:` 字段，也不发送空 id 重置已有游标。

| 事件 | 必要字段 | 客户端动作 |
| --- | --- | --- |
| `generation_snapshot` | `generation_id, channel_id, revision, author, source` | 创建或替换该任务的完整临时正文 |
| `generation_terminal` | `generation_id, channel_id, revision, status, message_id?`、失败时 `error?` | 记录终态，清理预览或按正式消息 id 交接；不含 source/author |
| 正式 `message` | 既有字段，可选外层 `generation_id` | 按 message.id 去重、移除对应预览 |

广播采用完整快照，累计正文最多 5000 个 UTF-16 字符单位，序号与 delta 只用于机器人提交 API。这样首次接收发生在生成中途、或丢掉前一帧时，都能显示后续快照。每次接受新 chunk 更新服务端累计正文，合并计时器仅发最新快照；终态转换递增 revision，先保存回执再广播，并取消定时器，禁止终态后再发快照。

author 使用与正式消息相同的展示字段和序列化规则，不由机器人填写。大区走现有广播并过滤专注屏蔽连接，私聊只投递该频道成员，且包含作者的其他标签页。清扫或错误事件只带任务身份与公开错误标识，不暴露私聊正文。

正式实时 `message` 的外层可带 `generation_id`，数据库 DTO 无需加字段。断线补齐的 `message` 没有这个字段也有效，客户端仍按消息 id 合并。terminal 的 `message_id` 和 complete 响应都能完成关联；到达顺序不限。

客户端维护正式 `messages` 与临时 `generations` 两份状态，禁止拿负数 id 伪装正式消息。同一 generation 的 snapshot 只有 revision 更新且任务未终止才接受；保留有界终态标记，避免迟到快照复活气泡。

收到正式 message 后，在一次状态更新里追加正式消息、移除临时消息并记录终态，正式正文先显示源码也可以。final 编译结果回来后再替换内容；旧 streaming 结果不得反向覆盖。若先收到 completed terminal 且正式 id 尚不在列表，立即触发现有补拉逻辑，按 id 去重并遵守历史窗口规则；不依赖后续一定还有正式 SSE 帧。

客户端断线、resync、切频道、退出页面或进入后台时清理临时消息及编译订阅，重连依靠现有正式消息补齐。首版不增加读者的生成恢复接口，生产者 GET 只用于查询自己的任务状态。重连后若又收到活动任务快照，可以重新显示；长期无更新的临时行由客户端超时清掉。

保持底部跟随与历史窗口规则：更新前贴底才随内容增高滚动；离底保持阅读锚点；历史视图不插入临时行。引用异步落位和图片加载后的高度变化也服从该规则。临时消息不能保存、回复或拍一拍；普通消息菜单不接收其 DTO。

## 8. 共享接口与文件布局

以下名称为实施目标，M0 确定后各代理依此开发。新增文件由各自负责人创建，既有路径按仓库实际调用点调整。

```ts
type ChatSourcePhase = 'streaming' | 'final';

interface ChatCompileRequest {
  key: string;
  revision: number;
  source: string;
  phase: ChatSourcePhase;
  priority: 'visible' | 'nearby';
}

interface ChatReferenceDocument {
  document: LocalDocument;
  hostData: Record<string, unknown>;
  // 每个引用位置有自己的 slot id，同一资源出现两次不能共享失败状态。
  bareImageCandidateSlot: string | null;
}
```

编译管理器提供 `subscribe(request, listener) → unsubscribe`，回调包括 key、revision、phase 和编译结果。引用层提供 `adaptChatReferences(document, context)`，只接收通过 Chat 文档策略的文档，返回不可变适配结果。异步 context 包含查看者作用域、取消信号、`compileChild(source, signal)`、父消息引用预算和当前展开深度。React 宿主层根据候选 slot、DTO 传入的 `allowBareImage` 和各位置的媒体失败状态计算最终裸图类名。

generation 的状态类型及错误标识集中到零依赖共享模块；主站服务对象与计时器不进入客户端包。共享协议由协调者独占修改，其余代理通过接口协作。

## 9. 子代理分工与并行安排

当前会话最多同时运行 6 个代理，包括协调者，因此实施时采用 1 名协调者 + 5 名执行代理。协调者负责 M0，执行任务 A–J 共十项，用空出的代理槽继续下一项；不为增加代理数量让多人同时改同一文件。

### 9.1 文件所有权

| 任务 | 责任与专属文件 | 输入 | 交付及验收 |
| --- | --- | --- | --- |
| M0 协调者 | 共享协议与接线；`src/lib/chat-shared.ts`、新 `src/lib/chat-generation-shared.ts`、`ChatApp.tsx`、计划状态 | 本文 | 冻结类型、错误标识、阶段和所有权；集成两阶段 |
| A 编译基础 | 新 `src/lib/chat-rmd/{options,compile-manager,compile.worker,document-policy}.ts` 及对应单元测试 | M0 类型 | 一页面一 Worker、多文档隔离、有界缓存、取消、phase 防过期 |
| B 引用适配 | 新 `src/lib/chat-rmd/{references,reference-reader,reference-types}.ts` 及对应单元测试 | M0 及 A 文档约束 | 完整兼容矩阵、代码/链接屏蔽、当前查看者取数 |
| C 正文视图 | 新 `src/app/chat/ChatRmdMessage.tsx`、`ChatRmdHostView.tsx`、`ChatRmdProvider.tsx`、聊天专属视图/URL策略及视图测试 | A/B 接口 | 静态 RMD、转义回退、媒体降级、裸图/黄脸、页面级共享管理器 |
| D 生成服务 | 新 `src/lib/chat/generations.ts`、generation 路由、`src/lib/chat/messages.ts`、`src/lib/rate-limit.ts` 及对应服务/路由测试 | M0 协议 | 生命周期、seq 幂等、提交锁、持久化回执、流量预算 |
| E 事件与临时状态 | `src/lib/chat-bus.ts`、`src/app/api/chat/stream/route.ts`、新 `useChatGenerations.ts`/reducer 及相应测试 | M0 事件类型、D 发布接口 | 快照合并、权限投递、终态关联、无游标和未读副作用 |
| F 正式入口接入 | `ChatMessageItem.tsx`、`ChatMessageDetail.tsx`、搜索/保存页实际正文调用点及保存页 client root | C 视图/provider | 所有正文入口一致，传入 allowBareImage，复制和非正文分支不回归 |
| G 样式与交互 | `src/styles-scss/pages/_chat.scss` 及专属 Chat RMD 样式文件；媒体交互辅助代码 | C/F DOM | 气泡、表格、代码、媒体和移动端；实际页面审核 |
| H 站外文档与示例 | `docs/bot/chat-bot.md` 及必要指南 | M0/D/E 稳定协议 | 自包含 create/chunks/complete/cancel 示例、重试与重启限制 |
| I 浏览器验收 | 本功能专属 e2e 行为用例与临时性能测量脚本 | R1/R2 可运行 | 多入口、桌面/移动、SSE、流式与正式交接；不固定文案/纯样式 |
| J 独立评审 | 只读评审集成 diff，问题回传各负责人 | R1/R2 diff | 安全、竞态、资源释放、无数据库变化审计 |

F/G/H/I/J 不要求常驻新代理，可重用 A–E 已完成的代理，继续保留清晰的文件所有权。对共享文件的修改请求交给其负责人；不通过恢复、stash 或覆盖别人的 WIP 解决冲突。

### 9.2 执行波次

| 波次 | 同时工作 | 合并条件 |
| --- | --- | --- |
| W0 | 协调者冻结 M0；其余代理准备对应边界用例和数据样本 | 类型和所有权明确，RMD 0.9.1 基础升级单独验证 |
| W1 | A、B、C、D、E 并行；C/E 可先用固定 fixture 接口开发 | 各自模块通过相关测试，接口未擅自漂移 |
| W2 | F、G 接入 R1；D/E 完成 R2；H 写新协议文档 | R1 先独立可用；协调者统一改 ChatApp |
| W3 | I 写/执行计划、J 审查；A/B 负责人处理反馈；协调者串行验证 | R1/R2 验收清单完成，问题均有归属 |

测试代码可并行编写，测试执行、typecheck、build、Prisma generate 和 e2e 由协调者集中调度，不同时运行多套测试服务或构建。子代理报告改动路径、行为变化、实际验证和剩余问题，不把未运行的检查写成通过。

## 10. 验收矩阵

| 范围 | 必须验证的行为 | 推荐层级 |
| --- | --- | --- |
| 编译 | 多条消息不会 latest-wins 丢失；流式 partial、final、失败；旧结果不覆盖新结果 | 单元 + 浏览器 |
| Markdown | 换行、表格、代码、任务列表、裸 URL；旧 HTML/插值边界得到明确展示 | 单元 + 样本审核 |
| 引用 | 全部类型、限额、重复、代码/链接屏蔽、剪贴板授权与截断、失败降级 | 单元/组件 + 相关 e2e |
| 安全 | 脚本、CSS、扩展 HTML、外链图、网络组件与伪造 hostData 不获得能力 | 单元/组件 |
| 正文入口 | 列表、详情、搜索、保存箱一致；软删和拍一拍不进入 RMD | 组件 + 相关 e2e |
| 创建与分块 | 创建重放/元数据冲突、分块重放/异内容/跳号、空片段/超长/超预算 | 服务 + 路由 |
| 完成与竞争 | 两次 complete 一次落库；cancel/complete 竞争；finalizing 不被清扫 | 服务 |
| 持久化故障 | create 成功后 DTO/广播/通知故障仍给原 id；未知提交状态禁止自动重发 | 故障注入服务用例 |
| 权限 | 非作者不能写任务；私聊第三方看不到；大区屏蔽与失权逐帧生效 | 路由 + SSE |
| 副作用 | 临时事件不影响 read、未读、last_message、@；正式消息配额/提及一次 | 服务 + 相关 e2e |
| 断线与终态 | 无临时 SSE id；正式补齐不变；消息与 terminal 任意顺序不重复；旧快照不复活 | reducer + SSE/e2e |
| 资源释放 | 切频道、离页、后台、超时、删除、账号切换清队列/数据；Worker失败转文本 | 单元 + 浏览器 |
| 体验与负载 | 50 条首屏、300 条长列表、多任务快照、贴底/离底/历史窗口、资源异步增高 | 桌面/移动实际测量 |

性能验收记录浏览器、设备、数据规模、源码显示到编译完成耗时、长任务与内存变化。硬边界是 Worker/队列/缓存数量有上限，输入与滚动不被同步批量编译阻塞；具体时延目标由 W0 基线测量后补充，不填写没有测过的提升百分比。

现有 `tests/unit/chat-markdown.test.ts` 同时保护评论旧管线，不因聊天切换整体删除。结合已有 chat SSE、mention、image、fold、saved-message 等测试补行为缺口。遵守项目测试范围：不新增前端文案断言、纯样式守卫或外观快照。

## 11. 验证、发布与回退

本次只交付设计文档及登记，执行 `npm run guards`。应用代码、RMD 升级 WIP 和未跟踪素材不混入本次文档提交。

实施 R1/R2 时先执行受影响测试；集成后一次 typecheck、一次全量单测和 guards。共享渲染、Worker 打包及新 API 完成后验证 build，再把相关桌面/移动 e2e 合为一次调用。无 schema/SQL 修改，不运行迁移验收。完整日志保存到系统临时目录并记录退出码；只有失败或后续修改要求时才重复扩大验证。

R1 完成后交付正文渲染；R2 完成后再公布流式机器人契约。各阶段完成适用验证并提交，默认不 push。上线顺序采用服务端事件/接口先兼容旧前端，再发布新前端；旧客户端忽略未知事件，现有一次性发送接口继续可用。

R1 回退恢复原 ChatMarkdown 调用，无数据库恢复工作。R2 回退停止新建任务，已有 active 任务终止或等其结束；已提交正式消息继续存在，不物理删除。正式发送接口保留，机器人可以恢复一次性发送。回退 RMD 版本前检查已发布增强语法的表现，保持编译失败可读源码。

## 12. 完成清单

- [x] M0：类型、配置能力列表、预算初值、代理所有权冻结。
- [x] R1：共享队列、RMD 正文、全部聊天引用与正文入口完成。
- [x] R1：评论旧管线及博客现有行为通过相关回归。
- [x] R2：生成接口、权限、seq、终态回执与资源预算完成。
- [x] R2：临时 SSE、前端预览、正式消息交接及滚动完成。
- [x] 站外协议、架构分工、内容引用指南按实际实现更新。
- [x] 相关测试、typecheck、全量、guards、build 与相关 e2e 有真实记录
  （guards 仅剩既有 docs-xref 断链；e2e 合并运行时两条图床选择器用例因负载抖动失败，
  单独复跑均通过）。
- [ ] 性能测量与桌面/移动页面审核完成，记录剩余问题
  （有界队列/缓存/离屏不排队等结构边界已落实；具体数值测量与视觉审核待站长复核）。
- [x] 确认无 schema/SQL/历史正文变更，按阶段提交且默认不 push。
