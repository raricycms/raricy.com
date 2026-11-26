# 项目架构

聪明山的主站负责页面、账号、权限与业务数据。实时游戏使用同仓的独立进程。本文说明进程之间如何协作、数据归谁管理，以及哪些约束会影响多个模块。

## 1. 技术栈

Next.js App Router 和 React 提供页面与 API。主站通过 Prisma 访问 SQLite，浏览器与实时进程通过 HTTP 或 WebSocket 连接服务端。博客与云剪贴板统一使用 ReactiveMD，服务端生成首屏；讨论在浏览器使用同一编译器和独立的静态策略，评论在客户端净化渲染，故事在服务端渲染。各管线的信任边界见 `docs/content-rendering.md`。

## 2. 进程拓扑

```text
浏览器 ── HTTPS ── nginx ── 页面 / API ── Next.js ── Prisma / SQLite
                       └── /realtime/* ── 实时游戏进程
                                              │
                                  内部 HTTP ──→ 主站票据与会话服务
```

主站与实时进程共同启停。主站签发一次性票据、复核账号状态，实时进程持有游戏内状态。数据库和主站会话密钥只交给主站。主站的 SSE 订阅和限频桶驻留在本进程，实时进程另管自己的连接。协议与部署见 `docs/realtime.md`。

## 3. 目录布局

| 位置 | 职责 |
| --- | --- |
| `src/app/` | 页面、Route Handler、页面组件 |
| `src/lib/` | 业务服务、共享契约与数据库访问 |
| `services/realtime/`、`shared/` | 实时进程、客户端与服务端共用的传输契约 |
| `prisma/`、`scripts/` | 数据模型、手写迁移与运维入口 |
| `instance/`、`public/static/` | 部署数据与用户文件、随应用分发的公共素材 |

## 4. 路由与访问边界

页面与 API 分别检查权限。路由按业务域组织，管理操作、成员内容与公开内容使用各自的访问入口。公开文章详情、列表、搜索、站点地图和预览图共享文章可见性规则；可凭链接阅读与允许枚举是两种权限。操作边界见 `docs/access-control.md` §2，站外接口契约见 `docs/bot/blog-bot.md`。

## 5. 业务逻辑层

页面、API 和运维 CLI 调用业务服务。服务负责授权后的数据读取、事务、幂等与返回值。共享计算放在可由两端复用的模块，数据库客户端留在服务端。按任务查 `docs/agent-domain-rules.md`，按文件查自动生成的 `docs/src-lib-index.md`。

## 6. 跨模块边界

### 6.1 认证与会话

主站签发 JWT，并用数据库内的会话版本复核身份。改密或撤权使旧会话失效，长连接还需复核当前权限。历史密码哈希保持兼容；登出使用 POST。站点支持第三方 iframe 嵌入，跨站写请求仍受同源检查。角色与各入口的授权语义见 `docs/access-control.md` §2。

### 6.2 数据与时钟

业务数据和鱼干账目共用 SQLite。库内历史时间沿用 UTC+8 墙上时间语义，业务读写使用 `src/lib/db-time.ts`。行情事件等真实 UTC 时间使用自己的时钟。变更模型时同步手写 SQL，流程见 `docs/deploy.md` §4。

### 6.3 鱼干账目

`postEntry` 以整数存储单位（0.0001 鱼干）在调用者的事务内同时更新余额和流水。业务结果与账目一同提交，每个账户的余额等于其流水金额之和。转账、投喂、租用与结算复用这一入口。事务内只做本地工作，外部行情在事务外取得。余额不足属于业务拒绝，事务失败属于服务故障。

#### 6.3.1 账户的历史边界

账户服务曾独立部署。现在账目与业务同库，存量幂等记录继续保护可重试操作。历史数据兼容见 `docs/legacy-constraints.md`。

### 6.4 请求入口

反代将域名和协议交给主站。中间件对状态变更请求校验来源，对需要安全传输的路径检查协议。资源级权限由各路由与服务判定。反代配置与故障排查见 `docs/deploy.md` §6/§13。

### 6.5 限频

主站共享进程内限频桶。配额以 `src/lib/rate-limit.ts` 的 `RULES` 和 OAuth 路由内的限制为准。调整外部接口配额时，同步复述该数值的机器人接口文档。多实例部署需要共享计数。

### 6.6 文件与持久存储

用户上传落在部署数据目录，由资源路由根据记录、可见性和内容类型提供；公共站点素材随版本分发。数据库和用户文件需要配套备份与恢复。目录配置见 `docs/deploy.md` §2，恢复见 `docs/instance-restore.md`。

### 6.7 内容渲染

授权先于正文编译。可复用的编译结果与按读者准备的数据分开，引用展开遵循被引用资源自身的访问条件。博客、剪贴板、消息和故事的渲染入口见 `docs/content-rendering.md`。

## 7. 典型数据流

### 7.1 登录

校验凭据 → 创建带会话版本的 cookie → 后续请求复核用户与权限。长期连接与普通请求遵守相同的撤权边界。

### 7.2 投喂

业务服务校验文章、用户与额度 → 在同一事务写入业务记录及收付双方的账目 → 提交后返回结果。接口见 `docs/bot/like-feed-bot.md`。

### 7.3 阅读文章

请求解析文章与查看者 → 先判对外可见性 → 编译源码并按权限准备引用 → 输出静态正文 → 浏览器接管交互。同一篇文章的成员与外部视图可以不同。

### 7.4 浏览目录

站内目录按成员资格读取列表；公开目录、公开搜索和 sitemap 只枚举允许公开索引的文章。公开正文索引由白名单内容派生，可独立重建。

## 8. 关键约定

页面与接口分别核对角色和资源归属。账号归档与禁言有各自的判断条件。软删除后，列表、直接读取、引用展开和长连接都要遵守相同的可见性。软删除与归档见 `docs/access-control.md` §1，角色分档与管理页准入见 `docs/access-control.md` §2，资源标识与引用见 `docs/access-control.md` §3。

## 9. 迁移史速查

主站已从 Flask 切换至 Next.js，鱼干账户服务已并回主站。仍约束当前代码的历史格式与数据见 `docs/legacy-constraints.md`。迁移执行状态以目标数据库的迁移登记表为准。

## 10. 风险与已知限制

- SQLite 的写锁限制并发写入，业务事务应短小。部署备份须包含数据库及关联用户文件。见 `docs/deploy.md`。
- 主站的 SSE、在线状态与限频依赖单实例。横向扩容前需要设计共享订阅、计数与撤权传播。
- 钱包只有一个持久账源，新增写入口须复用记账事务；跨进程游戏认证须继续由主站复核。

## 11. 专题入口

以下入口承接从架构迁出的专题及其旧书签。其他功能可按任务查询 `docs/agent-domain-rules.md` 或 `docs/README.md`。

| 主题 | 维护资料 |
| --- | --- |
| <span id="sec-6.8">画报与收款码</span> | `docs/agent-domain-rules.md` §2.17 |
| <span id="sec-6.9">OAuth 接入</span> | `docs/oauth.md` |
| <span id="sec-6.10">收藏夹</span> | `docs/agent-domain-rules.md` §2.21 |
| <span id="sec-6.11">文章对外可见性</span> | `docs/agent-domain-rules.md` §2.19 |
| <span id="sec-6.12">公开目录与索引</span> | `docs/agent-domain-rules.md` §2.19 |
| <span id="sec-6.13"><span id="sec-杠杆、">练手盘</span></span> | `docs/agent-domain-rules.md` §2.7 |
| <span id="sec-6.14">头像框</span> | `docs/agent-domain-rules.md` §2.22 |
| <span id="sec-6.15">音频床</span> | `docs/agent-domain-rules.md` §2.16 |
| <span id="sec-6.16">匿名评论</span> | `docs/agent-domain-rules.md` §2.20 |
| <span id="sec-6.17">浏览器本地文件处理</span> | `docs/agent-domain-rules.md` §2.23 |
| <span id="sec-6.18">聊天气泡</span> | `docs/guide/聊天气泡使用指南.md` |
| <span id="sec-6.19">实时游戏与票据</span> | `docs/realtime.md` |
| <span id="sec-6.20">私聊消息保存</span> | `docs/agent-domain-rules.md` §2.24 |
| <span id="sec-6.21">个人主页</span> | `docs/guide/个人主页使用指南.md` |
| <span id="sec-6.22">每日一言发行</span> | `docs/daily-quote.md` §1 |
| <span id="sec-6.23">正文编译与首屏</span> | `docs/content-rendering.md` §1 |
| <span id="sec-6.24">浏览器开发工具</span> | `docs/agent-domain-rules.md` §2.25 |
