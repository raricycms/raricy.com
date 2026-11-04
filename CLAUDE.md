# CLAUDE.md

本文件是 Claude Code、Codex 等 agent 共用的仓库指引。`AGENTS.md` 保持指向本文件的软链接，
不要复制成两份内容。Windows 若只读到一行 `CLAUDE.md`，改读本文件；链接修复见 `README.md`。

## 项目概述

- raricy.com（聪明山）：Next.js 15 App Router + React 19 + TypeScript，Prisma 6 + SQLite。
- 开发库为 `instance/database/dev.db`，生产库路径以部署环境配置为准；不要混用。
- 主站业务与鱼干账目保持单进程自洽；同仓 `services/realtime/` 是独立实时进程，
  由 `npm run dev` / `npm start` 与主站共同启停。服务边界见 `docs/realtime.md`。
- JWT 会话使用 `session_version` 失效机制；SQL 迁移走手写脚本，不用 `prisma migrate`。
- 不恢复已删除的 Flask 实现。注释应解释当前规则与理由，不引用已删除实现来解释业务决策。
  仍在数据库中的历史格式约束见 `docs/legacy-constraints.md`。

## 工作方式与提交

- 开始先看 `git status --porcelain`、`git log --oneline -3`、`git stash list`，区分本次工作与他人改动。
- 同一工作区可能有其他 agent：不覆盖、恢复、stash 或修复他人的未完成改动。
  需要对照 HEAD 归因时，在独立 worktree 验证，并确保自己的改动也包含在验证对象中。
- 按用户请求完成一个连贯任务后，完成适用验证并提交；不要求每个小步骤立即 commit。
  一个功能及其测试、文档可以在同一提交中；无关任务才拆分。只 `git add <具体路径>`，不 `git add -A`。
- 默认不 push，等用户明确要求。commit 与 PR 不加 Claude / Anthropic 或其他 agent 署名。
- 先用 `rg` 定位，再读取相关段落。已经读过且未变化的内容无需重读；不要为小改动通读架构文档。
- 临时日志、截图、备份放系统临时目录。测试框架自己的数据库和缓存仍使用其配置目录。
- 不群杀 node 进程；确认进程用途与归属后，只停止本任务启动或明确获授权停止的 PID。
  同一工作区不并发跑多套测试、多个 build，或在其他进程占用 Prisma client 时重新 generate。

## 常用命令

完整命令以 `package.json` 的 scripts 为准，使用说明见 `README.md`。

| 用途 | 命令与条件 |
| --- | --- |
| 按锁文件安装 | `npm ci`；只有任务需要调整依赖时才改 package / lockfile，不顺手升级大版本 |
| Prisma client | 安装后缺生成物、或修改 schema 后运行 `npx prisma generate`；不反复生成 |
| 开发 | `npm run dev` |
| 相关测试 | `npm run test:related -- <源码文件>`；已知用例时直接 `npx vitest run <测试文件>` |
| 类型检查 | `npm run typecheck`；不读取 `.next/types`，不要为单纯类型检查先 build |
| 完整构建 | `npm run build`；自动清理 `.next/types`、生成 Prisma client 并构建两个服务 |
| 全量单测 | `npm test`；触发条件见下节 |
| e2e | `npm run e2e` 使用现有构建；构建相关源码或配置变化后先 build，或用 `npm run e2e:ci -- <spec>` |
| 页面查看 | `npm run probe:page -- <路径>`，可加 `--as core`、`--wait <sel>`、`--shot <名>` |
| 运维 CLI | `npm run cli`；命令式调用加 `-- <cmd>`，见 `docs/cli.md` |
| SQL 迁移 | `npm run migrate -- status`；执行用 `up`、校验用 `verify`，步骤见 `docs/deploy.md` |

`probe:page` 连接已有测试服务，不负责启动或种子初始化；先确认目标端口、测试库与登录种子就绪。
它用于查看页面，不代替行为断言。`npm run lint` 当前不存在，不把它当门禁。
修改 CLI 命令时维护 `scripts/cli/registry.ts` 与 `docs/cli.md`，无需另改菜单注册。

## 验证纪律

验证按变更风险选择，不由提交次数决定。只读调研不跑测试；记录实际运行结果与未覆盖范围。

| 改动 | 默认验证 |
| --- | --- |
| 文档、指引、文档目录登记 | 跑对应文档守卫（如 docs-xref、docs-catalog、agent-instructions）；不默认 typecheck / build / 全量 |
| 简单样式、文案 | 相关静态守卫及必要页面检查；布局改动检查受影响视口，不默认全量 |
| TS / TSX 逻辑或类型 | 先相关测试，再一次 `npm run typecheck`；交互改动补受影响的页面或 e2e 验证 |
| 鉴权、账目、迁移、共享渲染、跨模块逻辑、依赖或测试基建 | 相关测试 + typecheck，再全量单测；按风险补 build / 相关 e2e |
| 构建、启动或部署配置 | 验证受影响的构建 / 启动路径；按影响范围选择单测与 e2e |

- 全量一般在任务完成时跑一次。修改后重跑受影响检查；只有新修改或失败表明需全量时再跑。
- 相关测试通过不能证明全量一定通过，typecheck 也不能代替行为验证。范围不清时扩大验证范围。
- e2e 将相关 specs 合并为一次调用，减少重复启动；按受影响视口选 project，移动端与响应式改动需覆盖 mobile。
  不默认跑全部 e2e，也不为“看一眼”新建探针 spec；需持久回归时再写正式用例。
- 输出完整保存到系统临时目录，用唯一文件名避免其他 agent 覆盖。先捕获退出码，再筛选日志摘要：

  ```powershell
  $testLog = Join-Path $env:TEMP ("raricy-vitest-" + [guid]::NewGuid().ToString('N') + ".log")
  npx vitest run <测试文件> *> $testLog
  $testExit = $LASTEXITCODE
  Select-String -Path $testLog -Pattern "Test Files|Tests  |FAIL "
  # 退出码在 $testExit；完整诊断保留在 $testLog，失败时继续读取相关错误段落。
  ```

- 不将测试输出直接管道截断或丢弃；可以从已保存的完整日志中提取摘要。
- 失败先看日志。`docs/known-red.md` 是排障线索，必须核对当前前提；相同错误文案不等于相同根因。
  修复后重跑受影响检查；没有代码、配置或环境变化时不盲目重复失败命令。
- 怀疑并发或他人 WIP 时先查进程及 diff；不得只凭存在未提交文件就断言失败与本次改动无关。

## 关键约定

以下是跨任务需要知道的边界；具体实现按下一节索引查询。

- 数据默认软删除，物理删除仅限站长明确要求；不对含数据变换的迁移手工重复执行。
- 库内时间使用 `src/lib/db-time.ts`：取当前值用 `nowForDb()`，读写与展示保持其时区语义。
  真实 UTC 行情时间与客户端计时不套数据库时钟，不能混用相减；范围见 `tests/unit/db-time-guard.test.ts`。
- 不在 SQLite 事务内等待外部 HTTP；鱼干写账走 `postEntry`，不绕开服务层直接改余额。
- 本站刻意允许第三方 iframe：不添加 `X-Frame-Options` / CSP `frame-ancestors`，不因此改 cookie 为 `SameSite=None`。
- 评论 / 讨论不把 `img` 加进净化白名单；对外资源读口维持权限与可见性白名单，匿名身份不泄露到通知或审计。
- 第三方素材只有授权允许再分发才入库；自行创作的素材可入库，运行时数据与私密部署信息不入库。
- 产品文案只写功能名称、操作提示和状态等必要信息，不主动添加装饰性副标题。

## 按任务读取

业务注意事项收纳在 `docs/agent-domain-rules.md`。先搜索对应功能、路径或符号，只读相关条目，
包括该功能涉及的跨模块边界；不要将整份手册作为每次任务的前置步骤。

| 任务 | 入口 |
| --- | --- |
| 权限、会话、CSRF、专注模式 | 子系统手册的跨模块边界、认证与角色、CSRF / 中间件；`docs/architecture.md` §8 |
| 数据库、时间、迁移 | `src/lib/db-time.ts`；`docs/deploy.md` 的修改 schema 说明 |
| 鱼干、练手盘、行情与结算 | 子系统手册的鱼干写路径、鱼干练手盘；相关 service 文件头 |
| 讨论、顶栏、通知、SSE | 子系统手册的推送边界与讨论小节；`src/lib/chat-service.ts`、`src/lib/topbar-bus.ts` |
| 实时游戏服务 | `docs/realtime.md`；`services/realtime/` |
| 内容渲染、表情、音频、用户名片 | 子系统手册的 Markdown / 内容渲染与对应引用类型小节；`src/lib/reactive/` |
| 博客对外可见性、匿名评论、收藏夹 | 子系统手册对应小节，重点检查所有对外出口 |
| 头像框、商城与头像渲染 | 子系统手册的头像框小节及对应守卫台账 |
| 样式、组件、布局 | `docs/frontend-styles.md` 中对应组件 / 场景小节；必要时查子系统手册的布局约束 |
| 格式转换器 | 子系统手册的格式转换器小节；保持文件字节不出浏览器 |
| 运维、排障 | `docs/cli.md`、`docs/deploy.md`、`docs/known-red.md` 中相关章节 |

### 限频

数值以 `src/lib/rate-limit.ts` 的 `RULES` 为准；OAuth 还有限频内联在路由中。
修改配额时同步复述该数值的 `docs/bot/` 与 `docs/guide/` 文档，范围见 `docs/README.md`。

## 文档维护

- 改文档链接或结构前读 `docs/README.md` 的「互指怎么写」；普通错字修正无需通读索引。
- 新增 / 改名 / 删除 `docs/` 下文档时，同步 `src/lib/docs-catalog.ts` 和文档索引，标题与 H1 一致。
- 根指引保持简短。新业务细节优先更新对应文档或源码说明，在此仅保留必要入口。
  已由脚本自动处理的步骤不再要求手工执行；历史耗时和单次事故不作为当前工作流判据。
