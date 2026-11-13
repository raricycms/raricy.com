# 测试套件价值审计与精简清单

> 审计日期：2026-11-13。基线是当日 `npx vitest run` 全量（272 文件中 2 个红：
> `tests/service/migrate-entry.test.ts` 与 `tests/route/oauth-token-ratelimit.test.ts` 的
> 真实 scrypt 用例，原因见 `docs/known-red.md` 同批记录）。本清单是**建议**，执行与否、
> 删到哪里，由站长逐档确认；未执行前本文不改变任何测试行为。

## 1. 结论

- 全量 272 个文件 / 5,208 条用例 / 4 worker 下 **803.6s（13.4 分钟）**。其中 service 层
  1,474.9s（73.5%）、route 层 357.4s（17.8%）、unit 层 173.4s（8.6%）。
- 按本清单处置后，预计减少 **795s 工作量（约 40%）**，并把「静态守卫」「迁移验收」
  「启动生命周期」移出默认 vitest 门禁。
- 按站长口径，**玩具区与前端文案不再设测试**（见 §2.1）：玩具区 26 个文件整档删
  （389 条用例 / 16.9s），文案类断言在各文件内部删除。
- 最反直觉的一条：**「废话测试」的时间占比很小**。全部 DELETE 合计只有 31 个文件 /
  425 条用例 / 17.1s（0.85%），其中大头还是「按口径删玩具区」。真正的时间在两类东西上——
  **该留但铺得太开的安全网**（42 个文件可裁 1,088s 里的约 425s）和**每用例清库的固定
  开销**（90 个文件 / 2,297 条用例每次 resetDb）。
- 光删测试到不了「3 分钟」：按当前并发效率，审计全部落地后全量约 **8 分钟**；再叠加
  「resetDb 单事务、拆重文件、worker 4→6」等基建优化后约 **5–6 分钟**。要把全量压到
  3 分钟只能动安全网覆盖，不建议。
- 真正的日常杠杆是**分层**：精选快层（34 个文件 / 574 条用例 / 122.4s 工作量）在 4 worker
  下约 **60–90 秒**，够覆盖钱、鉴权、可见性、迁移、限流、时间语义、净化与对外契约八个面。

## 2. 审计口径

判定只问一句：**这个文件里的断言，在什么真实故障上会变红？** 四档：

| 档 | 含义 | 判定 |
|---|---|---|
| KEEP（保） | 安全网，坏在静默处 | 钱/账本、鉴权/会话/越权、可见性/匿名、迁移/数据变换、限频、时间语义、净化（XSS/SSRF/路径）、对外契约（bot/CLI/OAuth/公开 API 形状）——找不到更低层已覆盖时保留 |
| TRIM（裁） | 有价值但铺太开 | 同一规则与更低层重复、循环烧配额/大样本暴力验证、DTO 字段形状与类型重复、逐字文案与顺序契约、纯外观/几何断言 |
| MOVE（搬） | 不该占 vitest 门禁 | 扫源码/文档的静态守卫（归 `npm run guards`）、空库全量迁移验收（独立命令）、起子进程/端口的启动生命周期（CI 慢车道） |
| DELETE（删） | 无外部契约 | 实现细节复述、纯外观/几何、已退役行为、只验常量或自己 mock 自己 |

两点补充：

1. 「静态守卫」不是没价值，而是**放错了执行入口**：它们 90% 的时间在启动 vitest 环境，
   断言本身是文本扫描；收进一个 `npm run guards` 脚本进 CI 更便宜，也不会随 `npm test`
   一起断。
2. 每个文件的成本取当日全量实测（4 worker、日志逐文件汇总），TRIM 的节省按该文件实测的
   30–70% 估算，**误差按 ±20% 计**；按批次执行时应以实测为准。

### 2.1 站长口径（2026-11-13，优先于分片判断）

1. **玩具区（`/game` 下全部，含联机玩具）不写测试。** 现有 26 个 vitest 文件整档删除
   （389 条用例 / 16.9s），e2e 侧对应的 13 个玩具 spec 同步删除（`game` / `craft-games` /
   `hinge` / `hinge2` / `hinge3` / `lumen` / `lumen2` / `quandi` / `twinshade` / `wand` /
   `wand2` / `wand2-controls` / `yiwen`）；今后不为玩具区新增用例。游戏内容、关卡、引擎、
   素材与联机协议的回归，靠试玩与发布前检查。保留 `tests/e2e/game-https.spec.ts`（协议闸）
   与 `tests/e2e/focus-mode.spec.ts`、`tests/e2e/access-control.spec.ts`（跨功能）。
2. **前端文案不写测试。** 按钮 / 提示 / 标题 / aria / 占位符等逐字文案断言删除，今后
   不再新增；错误码、状态码、数据落库与权限语义仍要测 —— 那些是契约，不是文案。

与安全相关、但不属于玩具内容的共享机制仍保留：中间件协议闸（`tests/unit/middleware.test.ts`、
`tests/unit/https-guard.test.ts`）、游戏启动票据服务（`tests/service/realtime-ticket-service.test.ts`）
—— 它们测的是 CSRF / HTTPS / 票据一次性与身份复核，不是玩具玩法。

## 3. 总览

| 档 | 文件 | 用例 | 当前耗时 | 预计节省 | 处置后 |
|---|---:|---:|---:|---:|---:|
| DELETE 删 | 31 | 425 | 17.1s | 17.0s | 移出 |
| MOVE 搬 | 22 | 150 | 352.9s | 352.9s | 移出默认 vitest |
| TRIM 裁 | 42 | 1,898 | 1,088.3s | 425.4s | 保留覆盖、削掉重复 |
| KEEP 保 | 177 | 2,735 | 549.5s | 0s | 原样保留 |
| **合计** | **272** | **5,208** | **2,007.9s** | **795.3s** | 工作量 −40% |

单位说明：表中的秒是**各文件耗时之和**（worker 时间），不是墙钟。当前 4 worker 墙钟
803.6s ≈ 工作量 × 0.40；审计后工作量 1,212.6s，按同一效率约 485s（8.1 分钟）。

## 4. 分档说明

### 4.1 DELETE（31 个文件 / 425 条用例 / 17.1s）

- **玩具区 26 个文件（389 条 / 16.9s）**：按站长口径整档删（§2.1）。其中
  `tests/unit/craft-marbling.test.ts` 一项 11.9s，是玩具区里最贵的（含 6000 段长夹具）。
  玩具区不再设测试，也不再补。
- **非玩具 5 个文件（36 条 / 0.2s）**：`reactive-syntax-budget`（预算诊断复述）、
  `dev-tools-response-read`（内部 helper 类型宽容）、`cli-output`（终端列宽/ANSI，属显示）、
  `daily-quote-card`（按钮文案/aria，按文案口径删）、`blog-visibility-tag`（两张常量表非空，
  tsc 已保证键；成本≈0，想留可留）。

> DELETE 档合计只值 17.1s：收益是**降噪与减少维护面**，不是提速。若不想承担逐条判断成本，
> 整档跳过也不影响后文的 5–6 分钟目标（提速来自 MOVE 与 TRIM）。

### 4.2 MOVE（22 个文件 / 150 条用例 / 352.9s）

- **`tests/service/migrate-entry.test.ts`（300s）**：单独一笔。空库全量 `up` 要逐个迁移
  spawn `prisma db execute`（43 次，单次冷启动实测 4.1s；裸跑 `node scripts/migrate.mjs up`
  实测 123.8s，全量并发下超过 300s 上限）。搬成 `npm run test:migrations` 单独验收，
  并保留 300s 上限观察真挂起。
- **21 个静态守卫（约 52.9s）**：扫源码/文档/资产的文本断言。`npm run guards` **目前不存在**，
  必须先建、先接 CI，再删 vitest 里的对应文件；否则等于净删除（`docs-catalog`、
  `db-reset-tables`、`blog-visibility-guard` 这类静默故障面会失去门禁）。
- 三个拆分类：`db-time-guard` 只搬 9 条扫描、留 16 条纯函数；`blog-visibility-guard` 只搬
  5 条扫描；`explore-visibility-guard` 只搬 3 条。按 `action` 列执行，不要整档删。
- 慢车道（不占门禁）：`app-start`（真起两个 node 子进程）、`reactive-corpus-cli`
  （4 次 `vite-node` 子进程，9.5s）。

### 4.3 TRIM（42 个文件 / 1,898 条用例 / 1,088.3s → 省 425.4s）

按节省排序的前 10 个就是全部收益的大头（合计约 300s）：

| 文件 | 现耗时 | 省 | 裁法 |
|---|---:|---:|---|
| `tests/service/favorite-service.test.ts` | 139.1s | 76.5s | 五条配额/限频用例各建 200 个夹 → 改成预置行 + 只验第 201 个；条目限频 320 次 → 直填桶 |
| `tests/service/blog-service.test.ts` | 114.0s | 39.9s | `countMarkdownWords` 对拍 15→3、必填/长度**文案按口径直接删**、分页/sort 6→3、删「现状固化」2 条 |
| `tests/route/fish-market-bot.test.ts` | 106.2s | 31.9s | 三条 120 次真打循环 → 预填桶 + 2–3 次真请求；幂等/双流水/step-up 全留 |
| `tests/service/fish-market-service.test.ts` | 57.0s | 25.7s | 配额/白名单四组约 340 笔真实转账 → 直填 `rateLimit` 桶，只留首尾各一笔真转账 |
| `tests/service/chat-service.test.ts` | 76.8s | 25.3s | 侧栏预览/拍一拍/红点汇总与 unit、侧栏重复 → 合并 |
| `tests/service/image-service.test.ts` | 59.6s | 23.8s | 同一净化规则 40 余条属性/枚举复述 → 每组留代表；20000 次 ID 循环 → 数量级样本 |
| `tests/service/notification-vote-clipboard.test.ts` | 64.4s | 22.5s | 通知 DTO/时间序列化、逐字**文案按口径直接删**、ID 大样本 → 删；偏好拦截/越权/一人一票全留 |
| `tests/service/user-service.test.ts` | 73.7s | 22.1s | 成功**文案按口径删**、校验顺序契约、现状固化 → 删；scrypt 格式/sessionVersion/邀请码双花全留 |
| `tests/service/admin-user-and-appeal.test.ts` | 66.8s | 21.4s | extra/CAST 三处同一读取路径 → 并；申诉幂等与档位保留 |
| `tests/service/comment-service.test.ts` | 56.5s | 17.0s | 已删叶子过滤 6→3、冗余计数 9→5、`toContentHtml` 4→2；权限树保留 |

其余 32 个 TRIM 的裁法见附录 A，主要模式是：循环烧配额改预置桶、大样本改代表样本、
逐字文案/顺序契约删掉、DTO 逐字段断言与类型系统重复删掉、纯 UI 交互观感删掉。凡涉及
逐字文案的断言，一律按 §2.1 直接删除，不再按 30–70% 估算。

### 4.4 KEEP（177 个文件 / 2,735 条用例 / 549.5s）

按文件命中的风险面粗分（一个文件可命中多面）：钱/账本 37、鉴权/会话/越权 30、
净化/SSRF/路径 41、对外契约 53、可见性/匿名 17、时间语义 9、迁移/数据变换 9、
限频/防滥用 8；其余是与安全无关但行为复杂的模块（编辑器、聊天/SSE、React 组件）。
**这 177 个文件不建议整档删**，其中个别仍有内部可裁项，已在附录里以 TRIM 标出。完整清单见附录 A。

## 5. 执行顺序与验收

分五步，每步独立可回退；不要合成一个提交。

| 步骤 | 动作 | 验收 | 预期 |
|---|---|---|---|
| P0 修红点 | 按 `docs/known-red.md` 修 migrate 超时、oauth scrypt 超时、fish outbox 竞态、image 搜索随机碰撞 | `npx vitest run` 连续两轮全绿 | 先恢复可信信号，否则删改无法验证 |
| P1 建入口 | 新建 `npm run guards`（收 21 个静态守卫）+ `npm run test:migrations` + CI 慢车道；接入 CI 或提交前检查 | guards 全绿；故意改坏一处能变红；删 vitest 文件前先确认新入口覆盖 | 待搬 52.9s 守卫 + 300s 迁移不占默认门禁 |
| P2 删 | 31 个 DELETE（玩具区 26 + 展示层 5），分 2–3 批 | 每批 `npx vitest run <相关>` + 一次全量 | −17.1s（主要是降噪与去掉玩具维护面） |
| P3 裁 | 42 个 TRIM，按节省从大到小，每批 3–5 个文件 | 每批相关测试 + 抽样全量；批次边界写进提交说明 | −425.4s |
| P4 基建提速 | `resetDb` 改单事务（实测 10.1ms vs 39–139ms，×2,297 次调用）；拆薄 4 个 >60s 文件；worker 4→6；配额类改预置桶 | 连续两轮全量绿且 ≤6 分钟 | 再省约 70–150s 工作量 |
| P5 快层 | 新建 `npm run test:fast`：精选 34 个文件 / 574 条用例 / 122.4s 工作量 | 4 worker 下 ≤90s；覆盖八个风险面 | 日常门禁改成「快层 + `test:related`」 |

快层候选（全部来自 KEEP，可按 `docs/testing.md` 的能力清单增删）：

```text
tests/service/fish-service.test.ts              tests/route/fish-tokens.test.ts
tests/service/fish-compensate.test.ts           tests/route/blog-visibility-write.test.ts
tests/service/fish-admin.test.ts                tests/route/chat-auth.test.ts
tests/service/reactive-v07-migration.test.ts    tests/route/read-auth.test.ts
tests/service/fish-token-service.test.ts        tests/route/spider-auth.test.ts
tests/service/fish-ledger-helper.test.ts        tests/route/security-access.test.ts
tests/service/webhook-deadline.test.ts          tests/route/vote-auth.test.ts
tests/route/oauth-revoke.test.ts                tests/route/oauth-unbind-code.test.ts
tests/route/stream-session.test.ts              tests/route/fish-balance-batch.test.ts
tests/route/categories-auth.test.ts             tests/unit/rate-limit.test.ts
tests/unit/webhook-url.test.ts                  tests/unit/session.test.ts
tests/unit/auth-roles.test.ts                   tests/unit/audit-actions.test.ts
tests/unit/fish-amount.test.ts                  tests/unit/migrate-url.test.ts
tests/unit/checkin-migrations.test.ts           tests/unit/daily-quote-migrations.test.ts
tests/unit/appeal-pending-migration.test.ts     tests/unit/fish-migration-21.test.ts
tests/unit/market-direction-migration.test.ts   tests/unit/md-editor-reactive-authoring.test.ts
tests/unit/fish-credential-list-cli.test.ts     tests/unit/audit-log-cli.test.ts
```

## 6. 预期效果

| 阶段 | 全量墙钟（4 worker） | 快层 |
|---|---:|---:|
| 现状（2026-11-13 实测） | 803.6s（13.4 分钟） | 无 |
| 只修红点（P0） | 803.6s，但稳定绿 | 无 |
| P1+P2+P3 落地 | 约 8 分钟 | 无 |
| 再加 P4 基建 | 约 5–6 分钟 | 约 60–90s（P5） |

把全量压到 3 分钟以内**不建议**：剩下的主要是 KEEP 里的钱/鉴权/可见性用例，再砍就是
拿事故风险换几分钟。

## 7. 风险与不做的事

- **MOVE 的守卫必须有新家**：`docs-catalog`、`db-reset-tables`、`blog-visibility-guard` 这类
  一旦搬出去又没进 CI，就是净删除，且它们的故障是静默的（文档不上站、清库漏表、旧档位名
  导致公开可见）。P1 先落地，再动 P2/P3。
- **TRIM 的「顺序契约」需要逐条确认**：`user-service` 的校验顺序、`frame-dto` 的 15 面
  台账、`oauth-connections` 的聚合口径都在分片里标了「待人工确认」，不要按估算一路删；
  文案类断言按 §2.1 直接删即可。
- **玩具区删按口径执行**：若某天玩具要比赛/商业化，再按当时需求补测试（口径优先）；
  保留的只有与安全相关的共享机制（中间件协议闸、启动票据）。
- 估算 ±20%：TRIM 的节省按 30–70% 估的，实际以批次实测为准；本清单不把估算写成承诺。
- 不做：加 retries 掩盖超时、为了绿删安全网、把全量当每次改动的默认门禁、
  在同一个提交里混做删/裁/搬（无法定位回归来源）。

## 附录 A：完整清单（272 个文件）

按档分组；「处置」列是具体动作，「理由」来自审计判断。TRIM/MOVE 的预估节省是上限估计，
执行时以实测为准；标 ⚠️ 的条目建议站长重点复核。

### A.1 DELETE（删）（31 文件 / 425 用例 / 17.1s）

| 文件 | 用例 | 现耗时 | 处置 | 理由 |
|---|---:|---:|---|---|
| `tests/unit/craft-marbling.test.ts` | 27 | 11.9s | 整档删（27 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/public-space.test.ts` | 12 | 1.4s | 整档删（12 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） ⚠️ 联机协议/人数上限属服务端行为；口径下删，若想留安全面可只保留 1 条上限用例 |
| `tests/unit/lumen2.test.ts` | 22 | 0.7s | 整档删（22 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/quandi.test.ts` | 15 | 0.6s | 整档删（15 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） ⚠️ 联机边界与协议；删后边界回归只能靠试玩发现 |
| `tests/unit/craft-papercut.test.ts` | 30 | 0.4s | 整档删（30 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/wand2.test.ts` | 7 | 0.2s | 整档删（7 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/wand2-assets.test.ts` | 1 | 0.2s | 整档删（1 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/lumen.test.ts` | 32 | 0.2s | 整档删（32 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/twinshade-engine.test.ts` | 33 | 0.2s | 整档删（33 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/quandi-assets.test.ts` | 3 | 0.2s | 整档删（3 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/motion-bezier.test.ts` | 25 | 0.2s | 整档删（25 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/craft-draft.test.ts` | 6 | 0.1s | 整档删（6 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/craft-loom.test.ts` | 29 | 0.1s | 整档删（29 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/reactive-syntax-budget.test.ts` | 2 | 0.1s | 整档删除；预算诊断由发布/摘要层用例承接 | 两条只是 compileSource 的复述 |
| `tests/unit/hinge2.test.ts` | 15 | 0.1s | 整档删（15 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/twinshade-levels.test.ts` | 40 | 0.1s | 整档删（40 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/twinshade-progress.test.ts` | 10 | 0.1s | 整档删（10 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/wand2-render.test.ts` | 9 | 0.0s | 整档删（9 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/geometry-expression-eval.test.ts` | 13 | 0.0s | 整档删（13 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/geometry-monomial.test.ts` | 8 | 0.0s | 整档删（8 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/geometry-engines.test.ts` | 2 | 0.0s | 整档删（2 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/hinge3.test.ts` | 16 | 0.0s | 整档删（16 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/hinge.test.ts` | 12 | 0.0s | 整档删（12 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/yiwen.test.ts` | 8 | 0.0s | 整档删（8 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/wand.test.ts` | 3 | 0.0s | 整档删（3 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） ⚠️ 联机物理/协议；删后协议漂移只能靠试玩发现 |
| `tests/unit/game-catalog.test.ts` | 8 | 0.0s | 整档删（8 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/twinshade-session.test.ts` | 3 | 0.0s | 整档删（3 条） | 站长口径：玩具区不写测试（现有整档删，今后不新增） |
| `tests/unit/dev-tools-response-read.test.ts` | 3 | 0.0s | 整档删除；内部 4 个读取函数的类型宽容无外部契约 | 只验 helper 语义而工具各有测试 |
| `tests/unit/cli-output.test.ts` | 27 | 0.0s | 整档删除；终端列宽/对齐/截断/ANSI 剥离属显示外观 | ops CLI 输出无机器可解析契约 |
| `tests/unit/daily-quote-card.test.tsx` | 2 | 0.0s | 整档删除；只断言按钮文案、aria 与禁用态 | 价格与扣费在 service 层，本文件不防事故 ⚠️ 按文案口径删；价格与扣费在 service 层 |
| `tests/unit/blog-visibility-tag.test.ts` | 2 | 0.0s | 整档删 2 条 | 只验两张常量表非空，tsc 已保证键 ⚠️ 成本≈0；它防「第四档漏配成空串」，想保留可不删（时间收益为零） |

### A.2 MOVE（搬出默认 vitest）（22 文件 / 150 用例 / 352.9s）

| 文件 | 用例 | 现耗时 | 处置 | 理由 |
|---|---:|---:|---|---|
| `tests/service/migrate-entry.test.ts` | 4 | 300.0s | 搬：保留断言，移到独立迁移验收命令/CI 慢车道 | 每例起 node 子进程跑 43 条迁移，单文件 300s ⚠️ 搬出前先建 test:migrations；300s 上限保留用于发现真挂起 |
| `tests/unit/db-time-guard.test.ts` | 25 | 17.1s | 静态扫描 9 条搬 npm run guards；nowForDb/dayStart/hoursUntil/isoWithOffset 16 条纯函数留在 vitest | 全 src/ 扫描 17s 属 guards 不属于门禁，纯函数部分留下 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/reactive-corpus-cli.test.ts` | 2 | 9.5s | 整档搬 CI 慢车道，仍验只读与不泄正文 | 9.5s 全耗在 4 次 vite-node 子进程启动 |
| `tests/unit/audit-json-column-guard.test.ts` | 3 | 4.1s | 整档搬 npm run guards | 读源码断言 create 带 select 的静态守卫 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/blog-visibility-guard.test.ts` | 8 | 3.8s | 5 条 readFileSync 全仓扫描移 npm run guards；3 条公开集合常量断言删除（explore 守卫比真实 where 更硬） | 静态源码扫描不该占 vitest 门禁 ⚠️ 搬出前必须先进 CI guards，否则「旧档位名=公开可见」失去门禁 |
| `tests/unit/audit-action-guard.test.ts` | 5 | 3.1s | 整档搬 npm run guards | 全仓扫动作码台账的静态守卫 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/app-start.test.ts` | 5 | 3.0s | 整体搬 CI 慢车道；env 派生与凭据隔离断言随文件同去 | 起子进程/占端口的启动生命周期，不占 vitest 门禁 |
| `tests/unit/fish-scale-guard.test.ts` | 4 | 3.0s | 整档搬 npm run guards；FISH_DECIMALS 同源那 1 条与 fish-units 常量契约重复可删 | 手写标度旁路扫描属 guards ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/docs-xref.test.ts` | 8 | 2.8s | 整档移 npm run guards | 纯文档文本扫描无运行时行为 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/lib-index-guard.test.ts` | 9 | 1.7s | 迁到 npm run guards，复用已有 lib:index:check | 生成物与源码对账，属仓库守卫 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/frame-guard.test.ts` | 4 | 1.4s | 整档搬 npm run guards | 渲染层读原始装备列的静态扫描 |
| `tests/unit/explore-visibility-guard.test.ts` | 4 | 1.1s | 第 1 条（mock prisma 截获两出口 where 相等）留 vitest；其余 3 条 readFileSync 结构检查移 guards | 四条里三条是源码文本断言 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/avatar-sites-guard.test.ts` | 7 | 1.1s | 迁到 npm run guards | 全仓扫描源码文本，属源码守卫 |
| `tests/unit/pwa-metadata.test.ts` | 7 | 0.7s | manifest/磁盘 PNG 尺寸/execFileSync 跑 make-pwa-icons --check 移 guards；detectStandalone 3 条随迁 | 资产台账与出图脚本自检属于守卫 ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/docs-catalog.test.ts` | 19 | 0.2s | 整档搬 npm run guards（docs 守卫） | 文档登记表与磁盘双向对账属 docs 守卫 ⚠️ 搬出前必须先进 CI guards，否则漏登记文档无门禁 |
| `tests/unit/cli-guards.test.ts` | 9 | 0.2s | 移 guards；顶层 import 白名单、new Date 与时间戳比较式全是源码文本扫描 | 源码扫描不该占 vitest 门禁 |
| `tests/unit/anonymous-read-guard.test.ts` | 7 | 0.1s | 整档搬 npm run guards | 扫 route.ts 的免认证读口台账属 guards ⚠️ 风险面文件被判 MOVE，人工复核 |
| `tests/unit/frame-assets.test.ts` | 7 | 0.0s | 移 guards；素材字节与出图脚本文本的哈希台账 | 资产与脚本文本比对属静态守卫 |
| `tests/unit/guide-docs.test.ts` | 4 | 0.0s | 整档搬 npm run guards（docs 守卫） | 指南页引用的 docs 文件存在性属静态对账 |
| `tests/unit/db-reset-tables.test.ts` | 4 | 0.0s | 整档搬 npm run guards | resetDb 表清单与 schema 对账，纯静态 ⚠️ 搬出前必须先进 CI guards，否则清库漏表无门禁 |
| `tests/unit/agent-instructions.test.ts` | 3 | 0.0s | 迁到 npm run guards docs 守卫 | 校验 AGENTS.md 软链接，属仓库守卫 |
| `tests/unit/cli-docs.test.ts` | 2 | 0.0s | 移 guards；docs/cli.md 与注册表双向覆盖 | 文档与注册表文本比对属静态守卫 ⚠️ 风险面文件被判 MOVE，人工复核 |

### A.3 TRIM（裁，保留覆盖）（42 文件 / 1898 用例 / 1088.3s）

| 文件 | 用例 | 现耗时 | 处置 | 理由 |
|---|---:|---:|---|---|
| `tests/service/favorite-service.test.ts` | 51 | 139.1s | 保；内部并 9 条配额/限频：第 201 个被拒、配额只数未删除、配额按人算、复制占配额、导入占配额五条各建 200 个夹 → 合并为删光重建 + 第 201 个被拒；generateFavoriteId 200 次 → 3 次；条目限频 320 次改直填桶 | 配额/限频五条各建 200 个夹、条目循环 320 次，占大半耗时 |
| `tests/service/blog-service.test.ts` | 197 | 114.0s | 保；内部删约四成：countMarkdownWords 对拍 15→3、validateBlogData 必填/长度文案 24→10、listBlogs 分页/sort 6→3、【记录现状】2 条、与 public-blog-search 重复的公开搜索 2 条；文案/逐字断言按口径直接删 | 逐字文案与纯函数对拍、分页边界约占四成 |
| `tests/route/fish-market-bot.test.ts` | 43 | 106.2s | 保契约/幂等/step-up；三条 120 次循环改预填桶+少量真请求，并合 3 条兼容形状 | 120 次真打只验证配额数值，幂等与双流水不可省 |
| `tests/service/fish-market-service.test.ts` | 44 | 57.0s | 保；内部删/改 4 条：白名单之外的账号不受影响（与超过小时配额同一条 429）、config 空白项 32 笔只验解析、超过配额 100 笔与重放 99 笔填充改直填 rateLimit 桶 | 限频/白名单四组约 340 笔真实转账，重复且烧时间 |
| `tests/service/chat-service.test.ts` | 104 | 76.8s | 保；内部并约三成：侧栏预览 3 条（[图片]/[博客]/内联 token）、拍一拍 6→3、红点汇总 6→3、已读回执 3→2、extractMentions 1 条删 | 预览占位/拍一拍/红点汇总与 unit、侧栏重复 |
| `tests/service/image-service.test.ts` | 170 | 59.6s | 裁；内部删约 68 条：sanitizeFilename 不变式 it.each 14 例两组→6 例两组、注入/Unicode/折叠细节 16→8、generateImageId 20000 与 200 次循环、MIME 常量 5→2、listAllImages 搜索与分页边角 9→5、list… | 安全闸门要留，但同一净化规则被 40 余条属性/枚举用例复述 |
| `tests/service/notification-vote-clipboard.test.ts` | 130 | 64.4s | 裁；内部删约 45 条：9 位/8 位 ID 大量生成 2、通知 DTO 与时间序列化 4、batch 端点 401/400 文案 ×6、clipboard 200/201 边界三连、投票 30 次限频循环 3、route 层文案逐字 6、校验顺序 4、字段落库 3；文案/逐字断言按口径直接删 | 三条规则都真，但留的应是偏好拦截/越权/一人一票，其余是文案与常量复述 |
| `tests/service/user-service.test.ts` | 108 | 73.7s | 裁；内部删约 32 条：validateUsername 6→3、validateEmail 3→2、校验顺序契约 4、成功文案 4、现状固化 3（BUG-B/大小写/废码被消耗）、bio 边界 3、密码拒绝重复 4、不串号 2、内核成功路径 1；文案/逐字断言按口径直接删 | 108 条里近三成是文案/顺序/现状固化，事故防线只占一部分 ⚠️ 校验顺序契约是否算契约需确认；成功文案按口径删 |
| `tests/service/admin-user-and-appeal.test.ts` | 112 | 66.8s | 保；内部并 8 条：logAdminAction 的 metadata 落 extra、extra 经 listPublicLogs 往返、listAdminLogs 的 extra CAST 三处同一读取路径；邀请码与 resetUserPassword 各并 1–2 条 | extra/CAST 三处同路径，邀请码与重置密码重复 |
| `tests/service/comment-service.test.ts` | 97 | 56.5s | 保；内部并约三成：filterDeletedLeaves 6→3（保留已删+存活子、三层塌陷、已删父两子）、冗余计数 9→5、toContentHtml 4→2、序列化 2→1、listCommentsForBlog 3→1 | 已删叶子过滤与冗余计数逐条铺开，权限树保留 |
| `tests/unit/utils.test.ts` | 40 | 22.2s | 500 张邀请码逐条落库压到 20 张并改批量插入；删 identicon 的标签成对/背景矩形/前景色等外观断言，保留确定性、尺寸差异、单 path 接缝与 XSS 白名单 | 大样本落库占满 22.2s，形状一张样本即可钉住 |
| `tests/route/oauth-token-ratelimit.test.ts` | 9 | 23.7s | 删 3 格式×60 重复轮与真实 scrypt 轮；窗口恢复改预填桶 | 同一「密码计算前限频」用 3 种格式各跑 60 次复述 |
| `tests/route/blog-auth.test.ts` | 57 | 37.4s | 保 45 条档位三连；57 次 resetDb/建用户提为共享夹具 | 15 handler 三连是唯一安全网，浪费在重复 setup |
| `tests/service/oauth-connections.test.ts` | 29 | 45.4s | 裁；内部删约 9 条：aggregateConnections 7→2（留聚合与时间包络）、listUserConnections「两个应用→两行」与「真 token 也被聚合」、revoke「不波及其他用户」与「found=false」 | 聚合与整应用撤销要留，7 条纯函数聚合与 DB 口径逐条重复 ⚠️ 聚合口径（时间包络 / scopes 并集）的唯一直接断言 |
| `tests/route/favorite-api.test.ts` | 26 | 34.0s | 保档位/头注入/私密 404；删 7 条 service 已覆盖的 CRUD 状态映射 | 改名/条目/导入/句柄形态等由 service 完整覆盖 |
| `tests/unit/reactive-source-migration.test.ts` | 18 | 13.2s | 删 migrateLocalSourceWithSiteBudget 的 5 条 6000/3000/55000 段夹具用例；保留 14 条版本指令与约束解析 | 重复覆盖且超长夹具占 13s ⚠️ 删除的 5 条超长夹具用例若含独有版本指令 → 保留 |
| `tests/route/auth-login-ratelimit.test.ts` | 10 | 16.9s | 保双维度；删「同 IP 扫号」「CF/XFF」两条 300 次循环 | 同 IP 429 已被换 IP 用例包含；XFF 有 unit 覆盖 |
| `tests/route/audio-raw-range.test.ts` | 28 | 20.6s | 保 Range/416/可见性；8 条合法段合并为 2 条表驱动，删同尺寸 ETag 的「大小变」1 条 | HTTP Range 契约重，但段变体逐一复述 |
| `tests/service/frame-dto.test.ts` | 15 | 12.3s | 裁；内部删 9 条：getLikers/getFeeders/getBlogDetail/listUsers/searchCoreUsers/listChannelsForUser/searchTransferTargets/findTransferTargetByUsername/getCoun… | 15 个面同一规则各抄一遍：选两列再过 frameUrlFor |
| `tests/service/admin-category-service.test.ts` | 25 | 13.1s | 保；内部并 8 条文案/默认值断言（名称缺失、slug 缺失、父栏目必须存在、根栏目默认值、focusHidden 缺省、启用↔停用、二级栏目创建、非法字符更新）；文案/逐字断言按口径直接删 | 8 条只逐字钉中文文案与默认值，slug 锁定与删除阻断另有用例 |
| `tests/unit/poster.test.ts` | 30 | 8.8s | 二维码真解码 13 条压到每款 3 条（最短 payload 与 uuid）；删高度比较/占位文案/统计格标签等版式断言；文案/逐字断言按口径直接删 | 13 次 sharp+jsQR 是 8.8s 主因 ⚠️ 二维码真解码压到 3 条后，仍应覆盖最短 payload 与 uuid |
| `tests/service/frame-service.test.ts` | 64 | 12.3s | 裁；内部删约 17 条：pngHasAlpha 11→4（留色型 6/2/3+tRNS/非 PNG）、auditFrameAssets 4→2、grant/revoke 组合 13+8→15、listMyFrames 重复 1 | 白名单与穿越是独有安全网，但解析器与状态机被逐组合枚举 |
| `tests/unit/reactive-authoring-ui.test.tsx` | 26 | 3.2s | 裁组件挑选焦点/搜索/Esc、诊断面板文案约 13 条；留格式门控、Compartment 热替换、prepareSubmit；文案/逐字断言按口径直接删 | 焦点与面板文案是 UI 细节，门控与提交阻断才防事故 |
| `tests/unit/file-converter-table-data.test.ts` | 54 | 3.0s | 删限额常量/类别契约与一半格式往返矩阵；保留 RFC4180、类型推断边界、XLSX 公式缓存 | 常量与登记册断言和 registry 测试重复 |
| `tests/route/fish-tx-shape.test.ts` | 6 | 2.5s | 保「对象完全相等」；删 null 键/值错位/信封 3 条 | 「对象完全相等」已同时覆盖键集与值 |
| `tests/unit/md-editor-export.test.ts` | 32 | 1.1s | 删导出件版式与文案断言（.blog-content-container、<title>、文件名），保留相对地址补全、协议不碰、语法预算拒绝；文案/逐字断言按口径直接删 | 32 条里近半是导出模板外观与标题文案 |
| `tests/unit/docs-render.test.ts` | 10 | 1.1s | 10 条压到 5：保留全量渲染不 500、表格单元格链接、源码路径改写；删围栏/中文 slug/路径 code 包装等重复形态 | 同一 walkTokens 钩子规则的多形态重复 |
| `tests/unit/file-converter-office.test.ts` | 19 | 1.0s | 删 mammoth 提示汇总/截断与重复的 HTML→块 映射；保留多文件拒绝、分段、DOCX 往返 | 提示折算属展示且往返已覆盖映射 |
| `tests/unit/dev-tools-net.test.ts` | 43 | 0.5s | 留 net-guard SSRF 与 qr 的 UTF-8/容量；裁 barcode 三表、subnet 大样本、SVG 渲染约 30 条 | 编码表是标准复述，SSRF 判据才防事故 |
| `tests/unit/sticker-picker.test.ts` | 10 | 0.5s | 裁缩略图加载队列 4 条；留面板记忆 3 条边界 | 排队加载是性能细节，记忆落点才防静默错位 |
| `tests/unit/guard-and-format.test.ts` | 43 | 0.2s | 留 apiOk/apiErr 形状与 requireCore/requireOwner；裁 categoryFullPath/ymd/ymdhm 与展开顺序怪癖约 20 条 | DTO 形状契约留，展示格式是外观复述 |
| `tests/unit/base-js-init.test.ts` | 21 | 0.2s | 留 DOMContentLoaded 事故回归、20s 心跳、Navbar 重渲染；裁主题切换/移动端收起/铃铛 99+ 约 8 条 | 事故回归留，纯交互观感裁 |
| `tests/unit/md-editor-commands.test.ts` | 46 | 0.2s | 46→约 15，留撤销重做与多光标一致性；裁 toggleWrap/列表编号/缩进细节 | 工具条命令变换是编辑器 UX 细节 |
| `tests/unit/chat-message-dom.test.ts` | 5 | 0.1s | 留 grouped 表头在 own-blocks、引用块不在 own-blocks；裁兄弟顺序与纯图片层位 3 条 | 定位祖先规则留一条，兄弟顺序是外观 |
| `tests/unit/market-chart.test.ts` | 45 | 0.1s | 留时间轴 UTC+8 钟面与 mergeLivePrice；裁缩放/平移/刻度几何约 30 条 | 图表算术是显示层，时间语义才是风险面 |
| `tests/unit/profile-blocks.test.ts` | 37 | 0.1s | 删 mobileColumn/projectMobile/swap/moveInMobileOrder 等几何搬运，保留整页校验、重叠拒绝、链接 scheme、文字净化 | 37 条里大半是移动端排版几何算术 |
| `tests/unit/cli-wizard.test.ts` | 25 | 0.1s | 25→约 12，留返回/取消/必填重问；裁逐参数 label 与搜索选择文案；文案/逐字断言按口径直接删 | 提示文案是 UI 复述 |
| `tests/unit/avatar-component.test.ts` | 15 | 0.0s | 删 className/imgClassName/as/size/alt 空串等外观断言，保留无 src 且无 userId 不渲染、有 frameUrl 才画框 | 大半断言在钉 CSS 类名落点与内联尺寸 |
| `tests/unit/market-candles.test.ts` | 15 | 0.0s | 留六档白名单/parseInterval/candleKey；裁 INTERVAL_MS 逐键与标签文本约 8 条 | 白名单是 URL 契约，逐键常量是复述 |
| `tests/unit/file-converter-pdf-layout.test.ts` | 20 | 0.0s | 删 dpi/margin/fitContain 几何算术；保留页序、打包阈值、丢页提示 | 几何算术属外观，页序与丢页才是数据 |
| `tests/unit/dev-tools-registry.test.ts` | 6 | 0.0s | 留 slug/href 唯一与分类存在；裁 metadata 后缀与 helper 文案约 3 条；文案/逐字断言按口径直接删 | 清单完整性留，文案常量裁 |
| `tests/unit/fish-units.test.ts` | 13 | 0.0s | 删 3 条常量契约（FISH_UNIT_SCALE、FISH_DECIMALS 同源、MAX_FISH_UNITS），与 fish-scale-guard 及 schema 注释重复 | 常量断言与守卫重复，换算契约才是钱 |

### A.4 KEEP（保）（177 文件 / 2735 用例 / 549.5s）

| 文件 | 用例 | 现耗时 | 处置 | 理由 |
|---|---:|---:|---|---|
| `tests/service/comment-anonymous.test.ts` | 22 | 30.9s | 保 | 匿名承诺属身份/可见性：真身不出任何出口 |
| `tests/service/daily-quote-service.test.ts` | 22 | 26.7s | 保 | 90 天去重 + 共鸣扣款幂等 |
| `tests/service/checkin-service.test.ts` | 30 | 24.1s | 保 | 钱 + 时间语义核心：UTC+8 跨日、唯一约束并发 |
| `tests/service/fish-webhook.test.ts` | 27 | 24.0s | 保 | 商户回调契约+SSRF+退避时间语义集中于此 |
| `tests/service/fish-service.test.ts` | 48 | 23.1s | 保 | 钱的基础层：加扣与流水形态 |
| `tests/service/feed-service.test.ts` | 42 | 23.1s | 保 | 投喂五处写入同事务，含事务中途故障注入 |
| `tests/service/market-service.test.ts` | 46 | 23.0s | 保 | 开平仓事务与资金语义：扣款、流水、幂等键、旧键兼容 |
| `tests/service/daily-quote-lifecycle.test.ts` | 13 | 21.0s | 保 | 发行幂等 + 计费边界 |
| `tests/service/market-liquidator.test.ts` | 21 | 20.4s | 保 | 后台强平的钱与幂等：不写流水、结算价=爆仓价、fail-closed 闸门 |
| `tests/service/profile-service.test.ts` | 16 | 20.0s | 保 | 访客只收对外可读内容、指针降档即 null、越权块拒绝 |
| `tests/service/frame-shop-service.test.ts` | 25 | 19.1s | 保 | 鱼干与持有行同事务的原子性+续期基准是最高账目风险 |
| `tests/unit/content-format-integration.test.ts` | 23 | 17.5s | 保 | 内容格式写入闸门与落库原子性唯一一层 |
| `tests/service/fish-compensate.test.ts` | 20 | 16.5s | 保 | 全站群发补偿：续跑不重复发放是核心不变式 |
| `tests/service/saved-message-service.test.ts` | 16 | 16.3s | 保 | 只存指针、读时重判权限、被移出频道即 forbidden |
| `tests/route/daily-quote-api.test.ts` | 10 | 14.4s | 保 | 一言的钱/隐私/审核审计 |
| `tests/service/user-archive.test.ts` | 9 | 14.2s | 保 | CLI 归档的鉴权、账本清零与内容匿名化、迁移 SQL |
| `tests/route/vote-auth.test.ts` | 28 | 13.7s | 保 | 投票 6 handler 档位与创建者归属 |
| `tests/service/admin-vote-image-stats.test.ts` | 18 | 12.9s | 保 | 管理端读侧唯一层：三态可见性 + 磁盘文件存在性 + UTC+8 口径 |
| `tests/route/market-trade-api.test.ts` | 27 | 11.9s | 保 | 六处档位各判与专注/禁言分叉 |
| `tests/route/fish-tokens.test.ts` | 17 | 11.5s | 保 | 凭据签发 step-up/吊销即时/明文一次 |
| `tests/route/blog-visibility-write.test.ts` | 12 | 9.2s | 保 | PUT 缺键回填与创建默认档的分叉 |
| `tests/service/feed-fee-refund.test.ts` | 15 | 8.8s | 保 | 钱的补偿：幂等返还与预检拒绝 |
| `tests/service/fish-admin.test.ts` | 9 | 7.6s | 保 | 人工改余额唯一路径：原子扣减与幂等登记 |
| `tests/unit/password.test.ts` | 20 | 7.5s | 保 | 存量用户哈希互通，错了全站登不进 |
| `tests/service/market-stats-service.test.ts` | 9 | 7.3s | 保 | 统计来源是仓位行而非账本，爆仓与零实发平仓的口径 |
| `tests/route/chat-auth.test.ts` | 57 | 7.0s | 保 | 14 handler core+ 与严格 id 解析 |
| `tests/route/read-auth.test.ts` | 20 | 6.8s | 保 | 正文/名片按查看者收敛 |
| `tests/service/reactive-v07-migration.test.ts` | 12 | 5.9s | 保 | 正文语法迁移的阻塞、回滚与一次性标记语义 |
| `tests/service/admin-clipboard-service.test.ts` | 14 | 3.6s | 保 | 管理端可见性唯一层：已删/私有行 + 恢复审计 + 403 |
| `tests/route/spider-auth.test.ts` | 15 | 3.5s | 保 | 五条 spider 读口收紧 core+ |
| `tests/service/likers-feeders.test.ts` | 13 | 3.5s | 保 | 对外读口契约：软删排除、投喂量倒序、分页夹取 |
| `tests/service/fish-token-service.test.ts` | 24 | 3.3s | 保 | 凭据安全属性集中：哈希、吊销、到期、scopes |
| `tests/route/broadcast-target-group.test.ts` | 7 | 3.3s | 保 | 非法分组不得静默回落全站 |
| `tests/service/blog-directory.test.ts` | 7 | 3.1s | 保 | 个人范围取数属可见性边界 |
| `tests/service/realtime-ticket-service.test.ts` | 13 | 3.1s | 保 | 一次性票据跨游戏隔离与服务间凭据鉴权 |
| `tests/service/public-blog-search.test.ts` | 7 | 2.9s | 保 | 公开正文索引只收 public 且撤回即失效 |
| `tests/service/focus-service.test.ts` | 11 | 2.8s | 保 | 专注可见性读路径：NULL 与 [] 分叉、子栏目展开 |
| `tests/unit/blog-excerpt.test.ts` | 23 | 2.7s | 保 | 读时现算的摘要，唯一覆盖层 |
| `tests/route/saved-message-api.test.ts` | 10 | 2.6s | 保 | 保存箱同形 400 不确认存在 |
| `tests/service/fish-ledger-helper.test.ts` | 15 | 2.6s | 保 | 账本不变式助手自检，是几十个钱用例的可信前提 |
| `tests/route/mention-users.test.ts` | 6 | 2.5s | 保 | @ 选人可见性与禁言/静音过滤 |
| `tests/service/cli-wizard-loop.test.ts` | 9 | 2.3s | 保 | CLI 对外契约：确认语义与审计可见性 |
| `tests/service/admin-comment-service.test.ts` | 9 | 2.3s | 保 | 软删评论可见性 + 载荷不带 contentHtml，唯一读口 |
| `tests/route/focus-settings.test.ts` | 8 | 2.3s | 保 | hidden=[] 与 null 语义、默认集合 |
| `tests/route/blogs-search-fields.test.ts` | 9 | 2.2s | 保 | 搜索档位/字段白名单/正文额度 |
| `tests/service/broadcast-service.test.ts` | 11 | 2.2s | 保 | 仅站长可群发 + 目标组，越权即全站触达 |
| `tests/service/spider-comment.test.ts` | 8 | 2.2s | 保 | 对外键集合逐字契约+匿名化不改形状 |
| `tests/service/bubble-service.test.ts` | 8 | 2.2s | 保 | 气泡租金属鱼干扣款，含事务回滚与并发续期 |
| `tests/route/notifications-stream.test.ts` | 8 | 2.1s | 保 | SSE 首帧快照/401/字段补丁 |
| `tests/route/frame-rent.test.ts` | 7 | 2.1s | 保 | 只认会话的租框扣钱边界 |
| `tests/route/security-access.test.ts` | 13 | 2.1s | 保 | 申诉档位/OAuth 类型/禁言签到 |
| `tests/route/frames-equip.test.ts` | 6 | 2.0s | 保 | {} 与 null 的丢失状态差异 |
| `tests/route/image-quota-boundary.test.ts` | 10 | 2.0s | 保 | 真实路由配额边界（等号与角色闸） |
| `tests/route/bubble.test.ts` | 5 | 1.9s | 保 | 气泡会话/扣款/快照权限 |
| `tests/route/image-delete.test.ts` | 9 | 1.9s | 保 | 软删/硬删分工与失败注入 |
| `tests/unit/reactive-compile.test.ts` | 15 | 1.7s | 保 | 宿主节点与作者伪造 site-embed 的安全边界 |
| `tests/unit/md-editor-resource-panel.test.ts` | 9 | 1.7s | 保 | 按可控顺序兑现响应是唯一判据 |
| `tests/service/sticker-service.test.ts` | 21 | 1.7s | 保 | 穿越免疫与 SVG XSS 第二道闸门落在真路由 |
| `tests/route/oauth-revoke.test.ts` | 10 | 1.6s | 保 | 吊销范围与跨站 cookie 不提权 |
| `tests/unit/clipboard-save-lock.test.ts` | 10 | 1.5s | 保 | 保存并发/幂等，重复落库与漏写都是真故障 |
| `tests/unit/realtime.test.ts` | 15 | 1.4s | 保 | 起真服务跑 Origin/认证/限频 |
| `tests/route/admin-blog-ignore.test.ts` | 6 | 1.3s | 保 | PATCH ignore 的审计三件套唯一网 |
| `tests/unit/reactive-format-observer.test.ts` | 5 | 1.1s | 保 | worker 降级与 author tokens 契约唯一层 |
| `tests/route/image-upload-quota.test.ts` | 4 | 1.0s | 保 | 配额预检按压缩后字节 |
| `tests/route/oauth-unbind-code.test.ts` | 3 | 1.0s | 保 | 解绑后旧授权码不得重建绑定 |
| `tests/route/stream-session.test.ts` | 4 | 1.0s | 保 | 快照过期后旧流不投私有帧 |
| `tests/unit/rate-limit.test.ts` | 37 | 1.0s | 保 | 全站配额唯一实现，限频属风险面 |
| `tests/unit/daily-quote-migrations.test.ts` | 8 | 0.9s | 保 | 真实迁移 SQL 在内存库执行，唯一覆盖 |
| `tests/route/chat-stream.test.ts` | 2 | 0.9s | 保 | 断线补齐逐帧复核/大区快照 |
| `tests/route/fish-balance-batch.test.ts` | 3 | 0.9s | 保 | 公开批量余额的 400 与可观察截断 |
| `tests/route/audio-delete.test.ts` | 5 | 0.9s | 保 | 硬删顺序与失败注入唯一网 |
| `tests/route/categories-auth.test.ts` | 3 | 0.8s | 保 | 新读口默认匿名的回归三连 |
| `tests/service/reactive-source-render.test.ts` | 2 | 0.8s | 保 | 快照退役后的负向守卫+旧语法拒绝 |
| `tests/unit/market-math.test.ts` | 24 | 0.8s | 保 | 平仓结算唯一公式，账目一致 |
| `tests/route/upload-quota-race.test.ts` | 2 | 0.7s | 保 | 并发共享末份额度的复现 |
| `tests/route/admin-get-no-store.test.ts` | 4 | 0.7s | 保 | 管理端四 GET no-store 与 PII 缓存 |
| `tests/unit/audit-log-cli.test.ts` | 2 | 0.6s | 保 | CLI --user 语义（执行者或对象）的对外契约 |
| `tests/unit/vote-embed-result.test.tsx` | 2 | 0.5s | 保 | 票数以服务端结果为准，本地 +1 会漂 |
| `tests/unit/market-price.test.ts` | 35 | 0.5s | 保 | 缓存兜底会让看盘的人偷偷套利且测试全绿 |
| `tests/unit/reactive-editor-regressions.test.tsx` | 8 | 0.4s | 保 | 草稿格式与预览引用刷新，错了不报错 |
| `tests/unit/chat-message-menu.test.ts` | 25 | 0.4s | 保 | e2e 无法稳定复现长按计时与拖选收尾 click |
| `tests/unit/dev-tools-data.test.ts` | 47 | 0.4s | 保 | 工具页纯函数口径，无更低层可覆盖 |
| `tests/unit/md-editor-reactive-authoring.test.ts` | 13 | 0.4s | 保 | 只测纯函数会漏旧文档计时器没清 |
| `tests/unit/blog-form-fields.test.ts` | 4 | 0.3s | 保 | 提交载荷漏可见范围是静默故障 |
| `tests/unit/reactive-corpus-scan.test.ts` | 2 | 0.3s | 保 | 语料扫描逐篇隔离与失败记账 |
| `tests/unit/fish-credential-list-cli.test.ts` | 1 | 0.3s | 保 | Date.now 比较在真实到期后 8 小时仍显示有效 |
| `tests/unit/content-refs.test.ts` | 22 | 0.3s | 保 | [@id] 旁路的安全面唯一层 |
| `tests/unit/user-refs.test.ts` | 42 | 0.3s | 保 | 名片 token 不得误触发 @ 通知 |
| `tests/unit/reactive-mixed-content.test.ts` | 2 | 0.3s | 保 | 折行丢失时文本往往相同只有结构能发现 |
| `tests/unit/middleware.test.ts` | 36 | 0.3s | 保 | CSRF + 协议闸，线上事故回归 |
| `tests/unit/checkin-migrations.test.ts` | 11 | 0.3s | 保 | 手写 SQL 迁移在 CI 零覆盖（测试库由 db push 生成），写错炸真库 |
| `tests/route/frames-bytes.test.ts` | 15 | 0.3s | 保 | 字节复核 MIME/拒 SVG/目录穿越 |
| `tests/unit/chat-markdown.test.ts` | 31 | 0.3s | 保 | 两入口共用一条 marked→DOMPurify 管线 |
| `tests/unit/reactive-detect-format.test.ts` | 13 | 0.2s | 保 | 三态判定唯一层 |
| `tests/unit/reactive-ref-adapter.test.ts` | 5 | 0.2s | 保 | 引用展开跨权限取数就是越权读取 |
| `tests/service/reset-password-version.test.ts` | 1 | 0.2s | 保 | 管理员重置与并发撤权的 sessionVersion 单调 |
| `tests/unit/sticker-refs.test.ts` | 32 | 0.2s | 保 | 表情引用旁路语法与安全面 |
| `tests/unit/file-converter-ffmpeg-args.test.ts` | 48 | 0.2s | 保 | 错一个 flag 就是静默走错路 |
| `tests/service/webhook-deadline.test.ts` | 1 | 0.2s | 保 | 回调总时长硬上限：慢速滴流也必须断 |
| `tests/unit/dev-tools-time.test.ts` | 62 | 0.2s | 保 | 时间戳单位与 cron 时区口径算错也不抛异常 |
| `tests/unit/file-converter-encoding.test.ts` | 21 | 0.2s | 保 | 编码是静默错高发区 |
| `tests/unit/use-resolved-content.test.ts` | 13 | 0.2s | 保 | 剪贴板展开的缓存、失败不缓存与竞态 |
| `tests/unit/fish-migration-21.test.ts` | 7 | 0.2s | 保 | 迁移写错只在真库上炸 |
| `tests/unit/base-js-filepick.test.ts` | 8 | 0.2s | 保 | 客户端路由跳转后新挂 input 不被增强的回归 |
| `tests/unit/use-user-cards.test.ts` | 11 | 0.2s | 保 | 中文名不编码会把字节直接塞进 URL |
| `tests/unit/file-converter-queue.test.ts` | 11 | 0.2s | 保 | 串行/取消/代次/预算，静默错状态唯一层 |
| `tests/unit/reactive-client-compile.test.ts` | 5 | 0.2s | 保 | 预览/导出共享取数闸门与并发上限 |
| `tests/unit/file-converter-image-codecs.test.ts` | 25 | 0.1s | 保 | 手拼 BMP/ICO 字节，拼错产出打不开的图且不抛异常 |
| `tests/unit/file-converter-inspect.test.ts` | 47 | 0.1s | 保 | 猜错容器会让后续引擎走错路 |
| `tests/unit/audio-refs.test.ts` | 25 | 0.1s | 保 | 引用语法互不干扰，正则放宽会误发 @ 通知 |
| `tests/unit/reactive-preparation.test.ts` | 15 | 0.1s | 保 | 图片协议白名单 + LRU 字节容量 |
| `tests/unit/file-converter-archive.test.ts` | 20 | 0.1s | 保 | zip-slip 与压缩炸弹闸，解压前判完 |
| `tests/unit/cli-args.test.ts` | 33 | 0.1s | 保 | CLI argv 解析是对外契约 |
| `tests/unit/site-embed.test.tsx` | 12 | 0.1s | 保 | embed 伪造 hostData 与内容泄露风险 |
| `tests/unit/mention-input.test.ts` | 10 | 0.1s | 保 | IME 组字与选词进草稿的输入正确性 |
| `tests/unit/base-js-topbar-stream.test.ts` | 15 | 0.1s | 保 | 连接池占坑与后台标签页仍在轮询 |
| `tests/unit/chat-menu-keyboard.test.tsx` | 3 | 0.1s | 保 | 菜单键盘/焦点语义，a11y 契约 |
| `tests/unit/trade-chart-panel.test.ts` | 4 | 0.1s | 保 | K 线末根落后自动补数（线上事故） |
| `tests/unit/frame-refs.test.ts` | 37 | 0.1s | 保 | 到期比较全仓只此一处，写错就永远戴着框 |
| `tests/unit/market-stats.test.ts` | 22 | 0.1s | 保 | 鱼干盈亏/胜率/爆仓判据，金额算术 |
| `tests/unit/reactive-ref-reader.test.ts` | 4 | 0.1s | 保 | 引用取数权限闸，防探测成员资源 |
| `tests/unit/md-editor-upload.test.ts` | 16 | 0.1s | 保 | 超限 body 会让服务端看不懂或 413 |
| `tests/unit/webhook-url.test.ts` | 97 | 0.1s | 保 | SSRF 策略本身，唯一服务器出站口 |
| `tests/unit/dev-tools-code.test.ts` | 63 | 0.1s | 保 | 文本/颜色/MIME/UA 口径错了静默给错值 |
| `tests/unit/secret-box.test.ts` | 11 | 0.1s | 保 | 改派生会让存量 webhook 密文一次性解不开且不可逆 |
| `tests/unit/blog-timestamps.test.ts` | 7 | 0.1s | 保 | 时间语义（北京时间 vs UTC） |
| `tests/unit/chat-viewport.test.ts` | 16 | 0.1s | 保 | 把捏合缩放当键盘会把界面按倍率挤扁 |
| `tests/unit/cattca-pagination.test.ts` | 9 | 0.1s | 保 | 阅读器分页边界 |
| `tests/unit/file-converter-utils.test.ts` | 15 | 0.0s | 保 | 语法错必须返回 null 而不是静默忽略 |
| `tests/unit/rich-content-image-link.test.tsx` | 3 | 0.0s | 保 | 点击双动作回归 |
| `tests/unit/md-editor-upload-anchors.test.ts` | 45 | 0.0s | 保 | 上传锚点状态机，版面顺序必须与选择顺序一致 |
| `tests/unit/cli-registry.test.ts` | 22 | 0.0s | 保 | 注册表完整性 = CLI 对外契约 |
| `tests/unit/anon-identity.test.ts` | 9 | 0.0s | 保 | 偏一格只会让第 703 个人叫成别的 |
| `tests/unit/image-client.test.ts` | 17 | 0.0s | 保 | 上传归一化，服务端不再当错格式 |
| `tests/unit/appeal-pending-migration.test.ts` | 3 | 0.0s | 保 | 重复 pending 插入不拒会让申诉串案 |
| `tests/unit/auth-roles.test.ts` | 21 | 0.0s | 保 | 角色矩阵与禁言过期，全站鉴权底层 |
| `tests/unit/emoji-faces.test.ts` | 7 | 0.0s | 保 | 手写黄脸清单错则 token 解析不出、图片 404 |
| `tests/unit/turnstile.test.ts` | 16 | 0.0s | 保 | 人机校验失败分类决定 400/503，别把部署问题甩给用户 |
| `tests/unit/file-converter-tar.test.ts` | 12 | 0.0s | 保 | TAR 字节格式与解压限额 |
| `tests/unit/audit-actions.test.ts` | 20 | 0.0s | 保 | 审计详情误显示 metadata 会泄露敏感串 |
| `tests/service/topbar-bus.test.ts` | 13 | 0.0s | 保 | SSE 帧格式、只推目标用户、背压断开、kick 全断 |
| `tests/unit/file-converter-presets.test.ts` | 22 | 0.0s | 保 | 预设引用的边与参数键必须真实存在，改名静默失效 |
| `tests/unit/bubble-refs.test.ts` | 2 | 0.0s | 保 | 把任意 key 拼进类名或 HTML 等于注入 |
| `tests/service/chat-bus.test.ts` | 14 | 0.0s | 保 | SSE 投递语义零成本：帧格式、专注过滤、背压 |
| `tests/unit/market-stream.test.ts` | 15 | 0.0s | 保 | 重连/看门狗/半死判据状态机 |
| `tests/unit/file-converter-subtitle.test.ts` | 15 | 0.0s | 保 | SRT/VTT/ASS 是对外文件契约，时间戳错一位就静默坏 |
| `tests/unit/og-card.test.ts` | 14 | 0.0s | 保 | OG 图对外可达，越界与转义错无人肉眼发现 |
| `tests/unit/file-converter-ffmpeg-seq-pattern.test.ts` | 10 | 0.0s | 保 | 串输出模式展开错则退出码 0 但结果一个文件都没有 |
| `tests/unit/safe-url.test.ts` | 19 | 0.0s | 保 | next 来自 URL，协议相对与反斜杠变体会跨站 |
| `tests/unit/session.test.ts` | 15 | 0.0s | 保 | 会话签发/失效与 Secure 判定，事故回归 |
| `tests/unit/md-editor-draft.test.ts` | 24 | 0.0s | 保 | 草稿时序（发布后写回/离页/卸载）全是静默错 |
| `tests/unit/market-direction-migration.test.ts` | 3 | 0.0s | 保 | 真实迁移 SQL，历史仓位补方向 |
| `tests/unit/page-window.test.ts` | 5 | 0.0s | 保 | 分页窗口算术唯一实现，六个页面共用 |
| `tests/unit/chat-presence.test.ts` | 8 | 0.0s | 保 | 判宽了 @ 通知永不产生 |
| `tests/unit/linkify.test.ts` | 14 | 0.0s | 保 | URL 切分 = 注入面与内容完整性 |
| `tests/unit/md-editor-resources.test.ts` | 9 | 0.0s | 保 | 私有收藏夹列得出但插不进，且要给理由 |
| `tests/unit/site-url.test.ts` | 11 | 0.0s | 保 | 前缀拼错图能生成但扫出来打不开 |
| `tests/unit/file-converter-registry.test.ts` | 14 | 0.0s | 保 | 不存在的边靠改后缀补上会产出废文件 |
| `tests/unit/fish-amount.test.ts` | 15 | 0.0s | 保 | 鱼干金额展示/解析，和账目口径绑 |
| `tests/unit/https-guard.test.ts` | 21 | 0.0s | 保 | 协议闸判据（含回环豁免）是公开行为契约 |
| `tests/unit/migrate-url.test.ts` | 7 | 0.0s | 保 | 相对路径按 prisma/ 解析错会连错库 |
| `tests/unit/read-render.test.ts` | 6 | 0.0s | 保 | 漏传 viewer 会跨权限展开成员引用 |
| `tests/unit/http-cache.test.ts` | 11 | 0.0s | 保 | raw 路由缓存口径，删图仍活着是事故 |
| `tests/unit/json-ld.test.ts` | 8 | 0.0s | 保 | 无 CSP，标题含 script 闭合串即公网 XSS |
| `tests/unit/file-converter-ffmpeg-parse.test.ts` | 17 | 0.0s | 保 | 解析抛错会让探测整条边失败 |
| `tests/unit/mention-shared.test.ts` | 4 | 0.0s | 保 | 邮件/引用 token/过长名字被当成 @ 会误发通知 |
| `tests/unit/pagination.test.ts` | 6 | 0.0s | 保 | skip NaN → 500 的已知 bug 形状 |
| `tests/unit/story-path.test.ts` | 9 | 0.0s | 保 | 路径段读盘前拒绝（穿越/盘符/NUL） |
| `tests/service/audio-upload.test.ts` | 17 | 0.0s | 保 | 入站净化：magic bytes 嗅探 + 声明归一化，零 DB |
| `tests/unit/favorite-refs.test.ts` | 11 | 0.0s | 保 | 误判会让每次渲染都请求不存在的资源 |
| `tests/unit/cattca-frontmatter.test.ts` | 7 | 0.0s | 保 | 阅读器加载层剥离 frontmatter/BOM |
| `tests/unit/chat-grouping.test.ts` | 8 | 0.0s | 保 | 合并表头判据（5 分钟窗口/跨日/拍一拍） |
| `tests/unit/cli-execute.test.ts` | 15 | 0.0s | 保 | 拒绝或 Ctrl-C 时留下半完成写入 |
| `tests/unit/navigation-back.test.ts` | 5 | 0.0s | 保 | iOS A2HS 死键回归 |
| `tests/unit/sse.test.ts` | 7 | 0.0s | 保 | SSE 头与帧格式是传输契约，缺 no-transform 实时性归零 |
| `tests/unit/quota-view.test.ts` | 4 | 0.0s | 保 | 取整口径改一处漏一处会让 bot 显示错配额 |
| `tests/unit/image-compress.test.ts` | 2 | 0.0s | 保 | 动图判定错则 sharp 静默丢帧 |

---

> 复核提示：附录里标 ⚠️ 的是「需要站长拍板 / 执行时容易踩坑」的条目，执行前先看它们；其余条目按档执行即可。判定口径与站长两条硬规则见 §2，执行步骤与验收见 §5。