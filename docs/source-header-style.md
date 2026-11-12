# 源码头注释约定

> 给 `src/lib/*.ts`、`services/realtime/` 与有长期约束的 `scripts/` 模块：**文件头回答「改之前必须知道什么」，长背景进 docs/**。

## 头里只留三样

1. **一句话职责**：头注释块里第一行有效内容固定写 `// <文件名> — <职责>`（允许上面压一行 `// ───` 分隔线，仓库多数文件如此）。`npm run lib:index` 靠这一行生成 `docs/src-lib-index.md`，别换格式。
2. **当前规则与唯一出口**：必须遵守的判据、白名单、唯一写入口 / 唯一判定处，以及失效时会静默坏在哪。
3. **改动注意**：改这里必须同步改哪里（守卫测试、路由、另一份实现）、已知限制与单进程前提。

长度目标 ≤ 25 行；规则长到写不下时，说明它该进 `docs/` 或该拆文件，而不是继续拉长头注释。

## 头里不放

- 设计史、事故复盘、备选方案对比、外部数据源实测过程、字段考古 —— 抽到 `docs/source-design-notes.md`；行情 / 交易相关抽到 `docs/market-design-notes.md`。
- `docs/architecture.md` §5 已写过的子系统说明 —— 头里只留指向它的路径，不复制正文。

## 怎么抽（定期执行）

1. 跑 `npm run lib:headers`：列出头注释超过 30 行的文件，按行数倒序。
2. 只搬「为什么当初这样选 / 以前怎么坏过」的背景，**判据、白名单、错误码、失效后果一律留在头里**。
3. 头里补一行指针：`// 设计背景与取舍：<文档> §<节号>`。
4. 抽完跑 `npx vitest run tests/unit/docs-catalog.test.ts tests/unit/docs-xref.test.ts`，必须绿。

## 为什么这样分

头注释离实现最近，读代码的人一定会看到，所以放**还在生效的规则**最划算；但历史背景会过期，而且越写越长，放到 `docs/` 才能被检索和组织。索引由脚本生成，避免人肉表漏项（`docs/architecture.md` §5 自己就写着「漏过两次」）。

## 相关

- `docs/src-lib-index.md` —— 根目录文件索引（`npm run lib:index` 生成，勿手改）
- `docs/source-design-notes.md`、`docs/market-design-notes.md` —— 从文件头抽出的设计背景
- `docs/architecture.md` —— 进程与子系统层面的现行说明
