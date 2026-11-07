# ReactiveMD 接入博客区方案（渲染器换代）

> 状态：早期接入与实施记录（`reactive-md@0.5.3` → 0.6.1）。现行规则由
> `docs/plan/reactive-md-simplification-plan.md` 与 `src/lib/reactive/read-render.ts` 定义；
> 旧 `src/lib/renderer-select.ts` 已随 legacy 渲染整条退役删除（`3f2508c6`）。
> 当前依赖 `reactive-md@0.7.0`，0.5.x 协议细节与分阶段记录见 Git 历史。
>
> **2026-11 校订（R3-703）**：§10 的「Node ≥22.12 但 engines 写 ≥20」「print.css 由总样式
> 间接导入」已过时 —— `package.json` 的 `engines` 现为 `>=22.12.0`；print.css **明确不 import**
> （见 `ReactiveDocument.tsx` 与 `export.ts` 注释），站点打印规则在 `_reactive-md.scss` 的
> `@media print`。D1 的「五类引用都改写成宿主标签」也不成立：图床输出行内 `![](…/raw)`，
> 宿主 kind 枚举是 6 项（`host-components.ts`）。

## 1. 当前事实与入口

- 博客详情、剪贴板详情与编辑器预览共用一条管线：源码 → 引用适配
  （`src/lib/reactive/ref-adapter.ts`）→ `compileLocal` → `LocalDocumentView`；服务端按需
  编译并复用有界内存 LRU（`compile.ts` / `cache.ts`），不读写数据库快照。
- 走哪条路径只由 `selectContentRenderer` 决定：格式无法识别 → `unavailable`；其余一律
  `reactive`。`REACTIVE_MD_MODE` 与「`off` 时交回旧渲染器」的分支已随 legacy 渲染整条退役
  （`3f2508c6`），现在没有第二条管线。没有百分比灰度、`shadow` 或逐篇 override 决策。
- 迁移 35 的 `format`、`syntax_version` 仍在表里，供 API、草稿与旧消费者辨别内容；
  `renderer_override` 只剩列与透出；`X-Content-Renderer` 响应头未接入（见 §12），
  `ADAPTER_VERSION` 进缓存键（见 §5.3），结构化日志与 `data-content-renderer` 已落地。

## 3. 决策

### D1 站点引用组件：方案 A（宿主组件，已落地）

作者只写 `[@…]`；适配器在编译前把五类引用改写成宿主标签
`<site-embed kind="audio|vote|favorite|clipboard" ref="…" />`，站点提供 schema、数据与渲染
函数。属性名必须是 `kind` / `ref`（`hostData` 的键为 `${kind}:${ref}`，改名、改大小写或给
`ref` 编码都只会让页面出现占位），代码块与行内代码里的同形文本保持原样，`site-embed` 不进
作者组件目录。缺 renderer / 缺数据时渲染 `local-host-unavailable` 占位，属站点数据错误。

### D2 格式、版本与回滚粒度

- `format`（`markdown` | `reactive`）描述内容本身，写入入口只有 service 层校验一处；
  `syntax_version` 仅 `reactive` 时写（值 `LOCAL_SYNTAX_VERSION`，当前 `local-draft-3`），
  服务升级审计与迁移判断，不是渲染开关。
- `renderer_override`（`NULL | 'legacy' | 'reactive'`）自 2026-11 起不参与渲染决策，列与
  透出保留给旧消费者；`format='reactive'` 的正文任何情况下都不交给旧解析器。
- 迁移 35 是纯 `ADD COLUMN`：存量行默认 `markdown`，不改写任何内容。
- 回退粒度是整篇：编译失败即 `unavailable`，不按诊断码局部降级，也不拿旧快照冒充当前正文。

## 5.3 编译缓存键

缓存键由适配后源码 hash、语法版本、精确编译包版本、适配器版本（`ADAPTER_VERSION`）与
`localCompileOptionsKey(options)` 组成。`LocalRuntime`、renderer 闭包与会话 `hostData` 不进
跨请求共享缓存，引用取数在请求权限上下文中执行；缓存按估算字节数设上限，命中率与耗时进日志。
每次改变适配器输出形状或转义规则都必须递增 `ADAPTER_VERSION`。

## 10. 风险（仍然成立）

- **「编译通过」不等于「渲染正确」**：换行、HTML 子集、数学与锚点都会静默变化。改兼容层或
  升级包版本要看文本与结构 diff，不能只看 `ok`。
- **数学是子集**：`aligned` / `matrix` / 自定义宏 / `\(…\)` 会原样显示，本地语料只命中个别
  文章的局部降级（见 §11 的 C2）。
- **外链图片、字体与打印样式**：外链资源不保证可达；`print.css` 由总样式间接导入，打印与
  导出按实际页面核对。
- **iframe 约定不变**：本站刻意允许被第三方 iframe 嵌入，不新增 `X-Frame-Options` /
  CSP `frame-ancestors`，也不因此把 cookie 改成 `SameSite=None`。
- **包与运行时**：ESM-only、Node >= 22.12（`engines` 写的是 >= 20），部署机与 CI 先验证。

## 11. 上游交付与条件项

U1–U6（软换行兼容、屏幕 / 打印样式拆分、公共导出、作者工具入口与配置贯通、数学显示诊断）
已随 0.7.0 交付，`reactive-md/authoring` 已被编辑器工具栏与站点作者工具直接使用。两个条件项
当前都未触发，不阻塞其他工作：

- **C1 稳定锚点**：要提供外部章节分享、或语料证明必须保留已有深链时才做——宿主指定稳定
  命名空间并保留同页多文档隔离，补 SSR / hydration、布局变化与重复标题的验证。
- **C2 数学显示扩展**：确有个别文章因 `aligned`、矩阵、宏或历史定界符无法等价迁移时，按
  语料列出支持集合与夹具逐项实现，或把该文档的降级明确写成已知限制。

## 12. 仍有效的未完成事项

| # | 事项 | 归属 | 需产品决策 | 依据 / 详见 |
|---|------|------|:---:|------|
| 1 | `X-Content-Renderer` 响应头 | 渲染 / 观测 | 是：做，还是正式撤销该要求 | `src/` 内零命中；结构化日志与 `data-content-renderer` 已落地 |
| 2 | 是否完全退出旧 Markdown 引擎 | 渲染 | 已完成 | **已退出**：legacy 渲染整条退役（`3f2508c6`），`renderer-select` 与 `REACTIVE_MD_MODE` 不再存在 |
| 3 | C1 稳定锚点 | 渲染 | 是：有外部章节分享才触发 | §11 |
| 4 | C2 数学显示扩展 | 渲染 | 是：实现，或标为已知限制 | §11；语料只命中个别文章的局部降级 |
| 5 | 生产发布核对 | 运维 | 是（站长 / root） | 迁移 35 / 36 / 37 / 40 是否已应用、搜索索引是否重建、PR #20 远端状态，仓库内无法核实 |
| 6 | 每日一言存量重复的只读统计 | 签到 / 一言 | 是：统计后是否补偿旧重复投喂 | `docs/plan/daily-quote-repair-plan.md` §4.3 |
| 7 | 编辑器剩余验收 | 编辑器 | 否 | `docs/plan/editor-plan.md` §7.2：M3 就地装饰、M4 表格辅助与大纲（可选）；真实设备 / IME、长文性能、真实网络与打印仍无证据 |
| 8 | 转换器剩余验收与功能缺口 | 工具 | 否 | `docs/plan/format-converter-roadmap.md` §16.2：真机矩阵、上限样本、音频矩阵、中文可搜索 PDF、HTML / DOCX 排版导出 PDF |
