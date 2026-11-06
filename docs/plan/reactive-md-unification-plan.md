# ReactiveMD 全量应用与编辑器重整计划

> 状态：本地实现与验收完成（2026-11-01，最终 commit `a7b1e963`）。产品目标已达成；
> 持久快照、回填与「正文 / 快照同事务」的要求已由
> `docs/plan/reactive-md-simplification-plan.md` 撤销。远端 PR #20 合并、生产发布与发布
> 范围确认尚未执行，仓库内无法核实。逐阶段过程记录（P0–P6 各轮收口、终审）见 Git 历史。

## 1. 当前事实与入口

- 博客与云剪贴板的 Markdown、Reactive 正文都走同一条管线：授权后按需编译、SSR 静态首屏、
  浏览器接管交互（`src/lib/reactive/read-render.ts` → `compileLocal` → `LocalDocumentView`）。
- 作者不选手动格式：`src/lib/md-editor/format-mode.ts` 从源码推导 effective format，保存时
  提交明确 `format`；草稿把原文、格式与语法版本一起恢复，旧草稿也兼容。
- 共用编辑器四入口：Insert、Components、上传图片、插入引用。Components 目录来自站点当前
  编译配置（`reactive-md/authoring` + `src/lib/md-editor/reactive-authoring.ts`），
  不维护第二份组件清单。
- API 省略格式沿用「创建默认 / 更新保留」；显式写了有效增强语法却声明 Markdown 的写入
  返回具名 400（`src/lib/reactive/publish.ts` 的 `format_mismatch`）。
- 引用权限与预算、静态首屏与无 JS 阅读沿用原口径；HTML capability flags 继续关闭。

## 2. 语料与性能结论（本地开发库）

- 只读扫描 4,909 篇博客 + 196 条剪贴板（共 5,105 篇，均标 Markdown）：5,085 篇无编译诊断，
  20 篇有错误或警告（其中 6 篇失败）。表达式误激活与有效组件误激活均为 0。
- 数学相关诊断 2 篇、节点预算拒绝 3 篇（正常长篇诗文）；实施时已按 0.7.0 实测把
  `REACTIVE_MAX_SYNTAX_NODES` 定为 50,000（`src/lib/reactive/host-components.ts`）。
- 这些数字来自**本地开发库快照**，不是生产结论；正文与完整报告不入库。

## 3. 架构决策（仍然生效）

### 3.1 一套引擎、一个作者入口，保留准确的格式契约

- `format` 不再决定「用新引擎还是旧引擎」，只服务 API、草稿与旧消费者兼容；不为界面统一
  批量把旧 Markdown 改标为 Reactive。
- 已有 Reactive 正文保留其格式与语法版本，删掉一个组件不自动降级。
- 自动识别依据上游语法事实，不用全文正则猜 `{{` 或 `<tag>`，也不把代码 / LaTeX 里的示例
  自动升级；字面语法用 Markdown 转义或代码标记表达。
- 将来删除 `format` / `syntax_version` 须另做完整的消费者迁移，不在本轮靠改默认值隐式完成。

### 3.2 统一编译配置与兼容层

- `src/lib/reactive/host-components.ts` 是阅读、预览 worker、作者分析、导出、摘要与搜索的
  唯一编译配置来源。
- 兼容历史 HTML 时对齐旧管线的允许标签、属性、URL 与净化后语义：未知属性可剥离、保留可读
  子节点，危险能力继续拒绝；优先用上游修复或公共扩展点，不改 `node_modules`。
- 不启用会把整篇分流到原生 HTML iframe 的 capability flags；iframe 嵌入与安全边界见
  `docs/plan/reactive-md-migration-plan.md` §10 与 `docs/architecture.md`。

### 3.3 故障与回退

- 普通阅读默认交互：SSR 先给静态初始状态再水合；预览、打印与静态导出只读。
- 历史无效 HTML、未闭合数学与未知普通标签局部容错；新写入的无效结构给诊断并保留草稿，
  不静默发布丢正文的产物。
- 旧引擎开关已随 legacy 渲染整条退役删除（`3f2508c6`）：`REACTIVE_MD_MODE` 不再被读取，
  Markdown 与 Reactive 同走 ReactiveMD 管线，没有「回到旧渲染器」的路径。

## 11. 完成情况与验收证据

本地已完成（均有提交与测试记录）：

- PR #20 修复与本地合并（merge `9bbf38bc`，后续修复 `58399ce1`、`54822f65`、`2b5e437c`、
  `96f94bab`）；依赖升级到 `reactive-md@0.7.0` / `local-draft-3`。
- Markdown 兼容与预算、博客与云剪贴板统一渲染、四入口工具栏、搜索 / 摘要 / 导出、
  旧 API 与草稿消费者按格式识别内容。
- 验收：全量 vitest 289 files / 5,720 tests（exit 0）、build 与 typecheck exit 0；
  按验收矩阵的 e2e 全部通过（唯一用例 106）。最终 commit `a7b1e963`。

未完成：远端 PR #20 合并、生产部署与备份 / 迁移 / 搜索重建的真实执行，等 root / 站长
确认范围。剩余事项（渲染决策、编辑器与转换器验收、生产发布核对）集中在
`docs/plan/reactive-md-migration-plan.md` §12；现行渲染规则见
`docs/plan/reactive-md-simplification-plan.md`。
