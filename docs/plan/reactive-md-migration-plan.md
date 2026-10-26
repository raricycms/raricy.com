# ReactiveMD 接入博客区方案（渲染器换代）

> **状态：`reactive-md@0.5.3` 已交付并精确安装；M2–M6 已在本分支落地（阅读路径、引用适配、
> 静态正文、编辑器预览与格式选择、摘要、对外契约与文档；M5 的组件目录 / 插入菜单未接入）。
> reactive 写入已开放（发布前编译并由同事务快照把关），剩余 M7 灰度、全量语料分类与
> 编辑器组件目录 / 插入菜单。方案 A 已定。**
> 源码核对基线为 `reactive-md@0.5.3`；该版本提供宿主组件协议、拆分样式入口与
> `reactive-md/authoring`。
> 本次修订统一格式、回滚与引用规则，并列出 6 组上游补丁、2 类条件项及站内适配。
>
> 四条前置事实决定了这份计划的形状：
> 1. ReactiveMD 不是「另一个 Markdown 渲染器」，而是一套**文档语言 + 组件模型 + 运行时**；
> 2. **0.5.3 已包含宿主组件扩展轴**（`hostComponents` / `hostComponent` 节点 /
>    `hostData` / `hostRenderer`），方案 A 不需要改协议形状；
> 3. **作者工具入口已在 0.5.3 公开**（`reactive-md/authoring`）；站内已接入格式选择与
>    预览，组件目录 / 「插入组件」菜单尚未接线（与写入闸门无关 —— 写入**已开放**，
>    闸门在 `src/lib/reactive/publish.ts`：发布前编译，编译不过整篇拒绝）；
> 4. 本站存量正文里已经有大量会被新语法**重新解释**的内容（单换行、`{{ }}`、HTML 标签、
>    公式子集、`[@…]` 展开产物）。「编译通过」不等于「渲染正确」。
>
> §3 记录决策，§9 区分接入选择与待验证事项，§11 列上游交付，§12 列站内适配与当前状态。
> 正式接入采用 **npm 精确版本**：`reactive-md@0.5.3`。
> 当前协议为 `component-protocol-2`，语法为 `local-draft-2`。

## 1. 目标与非目标

### 1.1 要交付的行为

- 博客详情页、剪贴板详情页、编辑器完整预览统一走：
  `原始源码 → 引用适配器 → compileLocal → LocalDocumentView`。
- 预览与阅读页共用适配规则、编译选项与渲染组件；相同源码和引用快照应产生相同编译键。
  源码 hash、适配后源码 hash、引用快照版本分别记录，会话权限与引用更新可以产生不同快照。
- 公开文章服务端渲染静态首屏（`staticFirst`），无 JS 时正文可读、脚注可跳、引用有静态降级。
- `[@…]` 五类引用在新渲染器里有与现在等价的能力与权限口径：
  图床 / 音频 / 投票 / 收藏夹 / 剪贴板（含对外视图 `external` 的「不发请求」承诺）。
- 编辑器保留 CodeMirror 6；新增基于组件 schema 的「插入组件」、补全、行内诊断、格式化、
  重命名；组件目录只有一份数据源。
- 导出、摘要、spider 的 `content` 契约与渲染器解耦；外部消费者能分辨内容格式。
- Markdown 文档按篇回退旧渲染器；reactive 文档故障时使用同版本的静态快照。
  线上能观测实际渲染路径与降级原因。

### 1.2 非目标

- 评论、讨论、故事保持现有渲染管线。评论/讨论的剪贴板引用适配层增加格式判断，
  防止把 reactive 源码交给原 Markdown 渲染器；正文渲染器不切换。
- 不开启 ReactiveMD 的 HTML capability flags（`enableCss` / `enableJavaScript` /
  `enableExtendedHtml`）。任一为 true 会把整篇文档切到 sandboxed iframe 分支，Markdown、
  组件、站点样式与权限全部失效。
- 不新增 CSP / `X-Frame-Options` / `frame-ancestors`。本站刻意允许被第三方 iframe 嵌入。
- 不维护第二套编辑器；不替换 CM6。
- 首期不运行嵌套 ReactiveMD 文档；reactive 剪贴板引用显示链接卡片（见 §4 M3）。
- 不在本期把评论/讨论里的 `[@8位]` 升级成嵌套渲染（仍只做「内联正文 / 降级为链接」）。

### 1.3 术语

| 术语 | 指什么 |
|------|--------|
| 旧渲染器 | `blog-renderer.ts` + `blog-content-dom.ts` + `MarkdownRenderer.tsx` |
| 新渲染器 | `compileLocal` + `LocalDocumentView` + 站点适配层（`src/lib/reactive/`） |
| 站点引用 | `[@…]` 五类：图床 / 音频 / 投票 / 收藏夹 / 剪贴板 |
| 宿主组件 | 只在站点侧注册、作者不能直接书写的组件（见 §3 D1） |
| 编译产物 | `compileLocal` 返回的 `LocalCompileResult`，成功时含 `LocalDocument` 与诊断 |
| 渲染实例 | 为一个视图创建的 `LocalRuntime`；有可变状态，不跨用户或视图共享 |

## 2. 审读结论（原计划需要修正的地方）

| # | 原计划假设 | 代码事实 | 影响 |
|---|-----------|----------|------|
| 1 | 旧管线保留给「评论、故事和回滚」 | `MarkdownRenderer` 的三个消费者是博客详情、剪贴板详情、编辑器预览；评论走 `rich-text.ts`，故事走 `story-service.ts` | 博客旧管线用于未迁移 Markdown 与回退；`marked` / `dompurify` 仍有其他消费者 |
| 2 | 需要补齐代码高亮、复制按钮、图片放大、外链加固 | ReactiveMD 已内置：`src/local/code-block.tsx`（lowlight + 复制）、`image-view.tsx`（`<dialog>` 放大）、`LocalDocumentView.tsx:1249-1252`（外链 `_blank` + `noopener noreferrer`） | 要做的是「迁移站点视觉与口径」，不是「从零实现」 |
| 3 | 编译失败才 fallback | `class` / `style` / `on*` 会让整个 HTML 标签降级成源码文本（`parser.ts:670`）；`audio` / `video` / `input` / `button` 不是 P0 HTML，会走「未知组件」分支；这些情况 `ok === true` | fallback 判据必须包含 warning 白名单，不能只看 `ok` |
| 4 | 插件/组件列表来自 ReactiveMD 的 schema | 0.5.3 已提供宿主组件协议与 `reactive-md/authoring` 公共入口；站内尚未接组件目录 / 插入菜单（§12.6） | 按实际导出接入作者工具；`site-embed` 仍不进作者目录 |
| 5 | ReactiveMD 的编辑器可以「移植工具条/命令」到 CM6 | 编辑器是 textarea + overlay（`ReactiveMarkdownEditor.tsx:65`）；可复用的是纯函数 `analyzeLocalSource` / `completeLocalSource` / `renameLocalBinding` / `formatLocalSource` 与 `editor-commands.ts` | 高亮/补全/诊断的 UI 层要按 CM6 重写；计划要写清「哪些可移植」 |
| 6 | 公开文章用 `staticFirst` 即可 | `staticFirst` 存在（`LocalDocumentView.tsx:4454`），但 `LocalReactiveDocument` 在 `useMemo` 里**同步编译**（`LocalDocumentView.tsx:4629`） | SSR 成本、编辑防抖、worker 都不会自动获得，要宿主自己接线 |
| 7 | 外对接口只需要「别暴露组件标签」 | `spider-service.ts:173` 直接返回原始 `content`；`/api/blogs/[id]` 同样；`docs/bot/blog-bot.md:252` 明写「content = Markdown 源文」 | 这是一次对外契约变更，要加 `format` 字段并同步 bot 文档 |
| 8 | RSS/feed 需要检查 | 仓库里没有 RSS 正文管线（`feed-service.ts` 是投喂鱼干） | 真正要检查的是 spider、`/api/blogs/:id`、OG、主页摘要 |
| 9 | 不单独 import `print.css` 即可隔离打印 | 上游 `src/styles.css` 已导入 `print.css`，React 构建入口也导入总样式 | 需要无样式 React 入口与拆分 CSS，见 §11 U2 |
| 10 | 数学不兼容会进入编译诊断 | `math-view.tsx` 会把未知命令、环境与预算失败降级为字面文本，没有对应编译诊断 | 需要数学显示兼容性分析，不能仅依赖 `ok` 与 HTML warning |

## 3. 决策

### D1 站点引用组件：方案 A（已定，ReactiveMD 0.5.2 已实现协议）

**结论**：站点引用组件走 ReactiveMD 0.5.2 的**宿主组件扩展轴**。作者仍然只写 `[@…]`；
适配器在编译前把它改写成宿主专用标签；站点提供 schema、数据与渲染函数。

**标签形状**（属性名必须是 `kind` 与 `ref`：0.5.2 的 `hostData` 键就是
`${node.attrs.kind}:${node.attrs.ref}`，改属性名会让数据永远取不到）：

```markdown
<site-embed kind="audio|vote|favorite|clipboard" ref="Ab12Cd34E" />
```

**schema（纯数据，可结构化克隆进 worker）**：

```ts
import type { LocalHostComponentSchema } from 'reactive-md';

export const SITE_EMBED_SCHEMA: LocalHostComponentSchema = {
  name: 'site-embed',
  form: 'leaf',
  props: {
    kind: {
      kind: 'enum',
      required: true,
      static: true,
      enum: ['audio', 'vote', 'favorite', 'clipboard'],
    },
    ref: {
      kind: 'string',
      required: true,
      static: true,
      pattern: '^[A-Za-z0-9]{1,32}$',
    },
  },
};
```

**编译**：

```ts
const result = compileLocal(adaptedSource, {
  hostComponents: [SITE_EMBED_SCHEMA],
  limits: { maxSyntaxNodes: 50_000 },
});
```

0.5.2 的实际行为（`src/local/options.ts`、`parser.ts`、`compiler.ts`）：

- 不传 `hostComponents` → 标签仍是未知组件，按原有 fallback 显示源码；
- 传了 → 命中标签生成 `type: 'hostComponent'` 叶子节点，计 **1 个语法节点**；
- 非法 schema → `local.options.invalid`（整次编译失败，不会部分注册）；
- 属性缺失 / 未知 / 枚举越界 / pattern 不匹配 / `static` 属性里出现 `{{ }}`
  → `local.host.attribute`；
- 名字必须是 kebab-case，不能撞 48 个作者标签、P0 HTML 标签名或 `theme`；
- 单次最多 32 个宿主 schema；`pattern` 只接受线性时间安全子集。

**渲染**：

```tsx
<LocalDocumentView
  document={result.document}
  runtime={runtime}
  hostData={hostData}          // JSON-safe，键 = `${kind}:${ref}`
  hostRenderer={renderSiteEmbed}
/>

function renderSiteEmbed(
  node: LocalNode,
  data: unknown,
  ctx: { runtime: LocalRuntime; render: ...; visible: boolean; mode: 'interactive' | 'static' },
) {
  // ctx.mode === 'static' → 只读快照；否则按 kind 渲染交互组件
}
```

- `hostRenderer` 是**客户端函数**，不进 worker；`hostData` 也不进 worker；
  `hostComponents` schema 会随编译请求进 worker。
- 缺少 renderer、缺少 `${kind}:${ref}` 数据、renderer 同步抛错 → ReactiveMD 渲染一个
  可见占位（`local-host-unavailable`），不会白屏、不会走 `onDiagnostics`。
  因此**站点必须保证「发出去的标签一定有数据」**，否则页面上会出现占位而不是产品组件。
- `mode="static"` 走同一分派，由 renderer 自己按 `ctx.mode` 返回只读形态。
- 0.5.2 的 `ctx` **没有 locale / preview 字段**：预览态的「不发业务写请求」由站点在
  闭包里传（例如 `hostRenderer={(n, d, c) => renderSiteEmbed(n, d, c, { preview })}`）。
- `hostData` 与 `hostRenderer` 都会进 `LocalDocumentView` 的 memo 依赖：两者必须是
  **稳定引用**（`useMemo` / `useCallback` 或模块级函数 + 闭包参数），否则每次父级
  渲染都会让整篇文档的环境失效，重新分派所有宿主节点。

**作者不可写**：`site-embed` 不进作者文档、补全、组件目录。适配器在插入自己的标签前，
先**在盖码副本上**定位作者源码里同形的 `<site-embed`，再按区间把原文改写成
`&lt;site-embed` —— 代码块与行内代码里的同形文本**不动**（与 `[@…]` 的盖码纪律同源）。
不转义的话，站点渲染管线带着 `hostComponents` 编译时，作者手打的那个标签会被当成
合法宿主节点（随后因缺数据渲染成占位）。作者手打时，编辑器自己的编译路径不传
`hostComponents`，所以它只表现为未知组件 warning，不会误执行。

**不再采用的备选**：B（占位 + portal）与 C（分段编译）保留在 2026-10-25 的审读记录里，
仅作为历史对照；A 已经落地，不再按它们排期。

**本站仍需自己做的部分**（0.5.2 不提供）：

- `[@…]` → `<site-embed>` 的适配器（含代码块盖码、预算、external 模式）；
- 五类引用的服务端取数与权限（`expand` / `external`）；
- 四个 renderer 与静态形态（音频 / 投票 / 收藏夹 / 剪贴板）；
- 「作者工具组件目录」的公开导出（M5 的前置，见 D5）。

### D2 格式、版本与回滚粒度

新增列（迁移 `35_reactive_md_format`）：

```sql
ALTER TABLE "blog_contents" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE "blog_contents" ADD COLUMN "syntax_version" TEXT;
ALTER TABLE "clip_text"    ADD COLUMN "format" TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE "clip_text"    ADD COLUMN "syntax_version" TEXT;
ALTER TABLE "blogs"        ADD COLUMN "renderer_override" TEXT;
ALTER TABLE "clipboards"   ADD COLUMN "renderer_override" TEXT;
```

- `format`: `'markdown' | 'reactive'`，描述**内容本身**；写入入口只有一个（service 层校验）。
- `syntax_version`: 仅 `format='reactive'` 时写，值是 `LOCAL_SYNTAX_VERSION`（当前 `local-draft-2`）。
  不要把它当渲染开关——它只用于升级审计与迁移提示。
- `renderer_override`: `NULL | 'legacy' | 'reactive'`，只决定兼容的渲染路径，不改变内容格式。
  `format='reactive'` 禁止设置 `legacy`；存量脏值报警并走静态降级，不能交给旧解析器。
- 存量行默认 `markdown`，**迁移不做任何内容改写**。

环境变量：`REACTIVE_MD_MODE=off|shadow|on`、`REACTIVE_MD_PERCENT=0..100`。
全局 `off` 是紧急关闭，优先于单篇 override；`shadow` 的可见路径与 `off` 相同，另做编译观测。
`on` 时再应用合法 override 与百分比分档。灰度按内容类型 + 稳定 ID 取模，编辑正文不改变分档。

| 格式 | off / shadow 的可见结果 | on 的正常结果 | 解释失败时 |
|------|-------------------------|----------------|------------|
| markdown | legacy | 通过语料验收且命中灰度或 override 的文档用 reactive，其余 legacy | legacy |
| reactive | 当前内容版本的静态快照 | reactive；未命中灰度时展示静态快照 | 当前内容版本的静态快照 |

开放 reactive 写入前，必须具备静态快照生成、保存和读出能力；正文与可用快照同版本发布。
编译或快照生成失败时拒绝发布该版本，编辑器保留草稿。快照缺失或过期时显示明确失败态，
不能拿旧版本快照冒充当前正文，也不能把 reactive 源码交给 legacy。

快照属于站点生成的可信产物，不能接受作者上传的 HTML。记录内容版本、编译版本、
选项签名及摘要；共享持久快照按 external 权限生成，成员私有引用、`user_voted` 等会话数据
不得持久化到公开快照。资源链接仍由 raw 路由鉴权。

### D3 编译位置与缓存

| 场景 | 在哪编译 | 说明 |
|------|----------|------|
| 阅读页（成员 / 访客） | 服务端编译缓存；客户端用序列化文档初始化视图 | RSC 只传可序列化文档、诊断和数据；运行时在各渲染实例内创建。若包实测要求客户端重编译，单独测量并记录该成本 |
| 编辑器预览 | 客户端 worker + 防抖 | `LocalCompileScheduler` + `startLocalCompileWorker`；编译期间保留上一版预览，不阻塞输入 |
| 导出 | 客户端，`mode="static"` | 离屏 root + `flushSync` 后读 `innerHTML`；`imageResolver` 用预取的 data URL 映射 |
| 摘要 / 卡片 | 服务端 | 复用编译逻辑；公开摘要只基于作者原文与公开内容，不进入成员引用展开缓存 |

缓存键包含适配后源码 hash、语法版本、精确编译包版本、适配器版本、
`localCompileOptionsKey(options)`。只有相同输入与选项的不可变编译结果可复用。
`LocalRuntime`、renderer 闭包与会话 `hostData` 不进共享缓存；引用取数在请求权限上下文中执行。
缓存按估算字节数设上限（含源码、AST、诊断），不是只算正文长度或条数；命中率与耗时进日志。

### D4 回退判据与可观测性

文档级降级的条件（满足任一；Markdown 回 legacy，reactive 按 D2 走静态快照）：

1. `compileLocal` 返回 `ok: false`；
2. diagnostics 中出现 `local.html`（HTML 属性降级）或 `local.component.unknown`
   （未知标签/组件）——这两类会**静默改变可见内容**；
3. 数学显示兼容性诊断表明会发生字面量降级，且该文档没有批准接受该差异；
4. 全局紧急关闭，或 Markdown 文档的合法 `renderer_override = 'legacy'`。

单个引用取数失败只降级该组件；缺 renderer / 缺数据键作为站点错误单独记录，
不混进内容兼容性统计。预期的 forbidden / 不存在状态遵守各视图的产品口径。

观测：

- 观测值：`legacy | reactive | reactive-fallback | reactive-static`；后者表示 reactive 静态快照。
  App Router 页面先通过结构化日志和外层 `data-content-renderer` 提供事实；响应头需要明确
  可写响应的实现位置，再作为附加输出，不能让 middleware 在编译前猜测结果；
- 服务端日志记 `blogId / format / renderer / diagnostic codes / compile ms / cache hit`；
- 管理端（或运维 CLI）能列出最近回退的文章与原因；
- e2e 断言语义属性和可见结果；响应头落地后补充对账，不依赖样式类名。

### D5 编辑器与组件目录

- 保留 `MarkdownEditor.tsx` 的 CM6、上传、草稿、Ctrl+S、自动保存、导出、textarea 回退。
- `reactive-md@0.5.3` 已公开作者工具入口 `reactive-md/authoring`：schema、
  `getNativeComponentCatalog(locale)`、`renderNativeSnippet`、`insertTemplate` 及相关类型。
  站内尚未接线这部分（§12.6）；分析、补全、重命名、格式化还须接受与预览一致的编译配置。
- 站点只消费这份导出，不手抄组件列表；`site-embed` 不进作者目录。
- 插入走 CM6 transaction（`view.dispatch({ changes, selection })`），保留撤销、选区、IME；
  插入前校验完整候选文档及新增诊断，支持依赖上下文的绑定和结构组件，不能只编译孤立片段。
- 新建格式选择、草稿恢复、保存与 API 写入都显式携带格式（已接入）。不根据标签猜格式；
  默认新建格式的切换与 reactive 发布仍须等 M6 / 持久快照与回滚验收。

## 4. 分阶段实施

### M0 数据层与开关（前置，不改渲染）

**目标**：让「这篇用哪个渲染器」成为可存储、可查询、可回滚的事实。

改动：

- `prisma/migrations/35_reactive_md_format/migration.sql`（按 §3 D2 的列，纯 ADD COLUMN）。
- `src/lib/content-format.ts`（**零依赖**）：`ContentFormat`、`parseContentFormat`、
  `DEFAULT_CONTENT_FORMAT`、`formatLabel`（人话表用 `Record<ContentFormat, string>`，加第三档时 tsc 报错）。
- `src/lib/blog-service.ts` / `src/lib/clipboard-service.ts`：读取时带出 `format` 与
  `syntax_version`；写入时校验白名单；默认值不改变现有行为。
- `src/lib/renderer-select.ts`（纯决策函数，服务端调用）：按 D2 与 D4 返回
  `{ renderer: 'legacy' | 'reactive' | 'reactive-static' | 'unavailable', reason }`。
- 创建/更新博客与剪贴板的 API、校验器、service、读取 DTO 同步携带格式；
  更新请求省略格式时保留原值，新建省略时默认 Markdown。非法格式拒绝，未知存量值报警。
- 预适配阶段拒绝 reactive 写入，直到同版本快照可生成并发布；元数据透传可先上线。
- 快照存储结构先定契约，内容版本、编译包版本、产物摘要与公开数据范围须能查询；
  实际新增表/列另建手写迁移，编号在实施时按迁移清单分配，不与格式列迁移混写。
- `src/lib/reactive/flags.ts`：环境变量解析（**零依赖**，客户端也能读公开的部分）。
- `prisma/schema.prisma`：同步列与注释。

测试：

- `tests/unit/content-format.test.ts`：白名单、默认值、脏值不猜测。
- `tests/unit/renderer-select.test.ts`：两种格式、全局紧急关闭优先、shadow、合法 override、
  稳定 ID 分档、快照缺失与旧版本快照拒绝；另测 API 更新省略格式不改原值。
- 迁移在测试库跑 `up` 与 `verify`。

退出条件：迁移可用；现有页面行为逐字不变；开关默认 `off`。

### M1 存量语料兼容性报告（工具，不是产品代码）

**目标**：把「全量替换意味着每篇旧文章都是验收用例」变成一份可执行的清单。

新增 `scripts/reactive-corpus-report.mjs`（只读库）：

对每篇博客与剪贴板产出：

| 字段 | 内容 |
|------|------|
| `compile` | ok / fail + 全部 diagnostic codes |
| `nodes` | 语法节点数（对比默认 10,000） |
| `textDiff` | 旧渲染纯文本 vs 新渲染纯文本（去掉标签后的序列） |
| `structure` | 单换行数量、`<br>` 差异、表格/任务列表/脚注 |
| `html` | `class` / `style` / `audio` / `video` / `input` / `button` / 其他标签计数 |
| `syntaxCollisions` | `{{`、`<panel>`、`<slider>`、`<theme>`、行首未知标签 |
| `math` | 使用的命令/环境（`\frac`、`\begin{cases}`、`aligned`、宏…） |
| `refs` | 五类 `[@…]` 的数量与预算占用 |
| `images` | 站内 / 历史 IP / 外链数量 |

输出：

- `reports/reactive-corpus.json`（gitignored，机器可读）；
- `reports/reactive-corpus.md`（分桶：A 编译失败 / B 编译通过但文本或结构变了 / C 等价）。

分桶后的处理：

- A → 记录原因，走 fallback 或修上游语法；
- B → 逐类决定：上游兼容选项、逐篇人工修、或让该篇留在旧渲染器；
- C → 候选迁移集合。

上游补丁前先做扫描器、旧管线基准、夹具和原始风险报告。0.5.2 时的编译结论只能作为
试验报告；0.5.3 接入后仍需用固定版本与选项重跑全量语料，分类才可确认（§12.6 仍待办）。
报告以只读数据源运行，默认不输出私有正文，不把生产数据复制进仓库。

退出条件：100% 文档有分类；B 类每一类都有明确处置（不是「以后再说」）；
预算超限的文章数量与清单确定。

### M2 ReactiveMD 地基（跨仓库）

**上游交付（详见 §11）**：

- **已完成（0.5.2，2026-10-26）**：宿主组件扩展轴、`hostComponent` 节点、
  `hostData` / `hostRenderer`、worker 透传 schema、`local.host.attribute`、
  静态模式同一分派、协议升到 `component-protocol-2`。本站直接用，不再设计协议形状。
- 6 组补丁：U1 软换行、U2 样式拆分、U3 公共导出、U4 作者工具入口、
  U5 作者工具编译配置、U6 数学显示诊断。U1/U2/U3/U6 阻塞阅读灰度，U4/U5 阻塞 M5。
- 稳定锚点与数学语法扩展是有触发条件的工作，不预设全面兼容 MathJax。
- 补丁发布后记录实际版本、CHANGELOG、支持入口和验收结果；本站按精确版本安装。

**站内改动**：

- 依赖来源为 npm 精确版本 `reactive-md@0.5.3`（已安装）；不 vendor 上游源码。
  验证安装包内含产物、Node >= 22.12、Next SSR 与 worker 构建，不依赖部署机现场构建上游。
- `src/app/components/reactive/ReactiveDocument.tsx`（`'use client'`）：
  - 入参：`adaptedSource` 或已编译文档、`format`、`mode`、`staticFirst`、
    `locale="zh"`、`urlPolicy`、`hostComponents`、`hostData`、`hostRenderer`、
    `onDiagnostics`；函数型 props 由客户端模块创建，不作为 RSC payload 传递；
  - 内部：编译（或接收编译结果）→ `createLocalRuntime` → `LocalDocumentView`；
  - **wrapper 不做 `[@…]` 适配**：阅读页的适配器在服务端跑（要权限），编辑器的适配器
    在客户端跑（要会话）；wrapper 只认适配后的源码，避免两边各自解析出不同结果；
  - 严格模式下运行时释放按官方 `queueMicrotask` 语义处理，不自己写一套。
- `src/lib/reactive/url-policy.ts`：
  - 按用途分别校验图片、媒体与超链接，保留合法站内链接、外部 http(s) 链接及片段跳转；
    允许同源资源 `/api/images/`、`/api/audio/`、`/api/avatar/`、`/image/i/`（历史 rewrite）；
  - 允许历史写死主机的图片（`next.config.mjs` 注释里那批 `http://116.62.179.232:22822`）；
  - 本次保留博客已有外链图片能力，不把评论/讨论的图片限制套进博客。
    外链收紧单独决策；URL 校验不新增服务端代理或对任意用户 URL 的抓取。
- `src/lib/reactive/compile-cache.ts`：服务端 LRU（见 D3），带命中率指标。
- `src/lib/reactive/diagnostics.ts`：把 diagnostics 映射成结构化日志、渲染路径标识与降级判据。
- 样式：
  - 使用上游交付的无样式 React 入口，显式 import 屏幕样式；入口名以发布包为准；
  - 新增 `src/styles-scss/pages/blog/_reactive-md.scss` 做站点对齐（宽度、字号、行高、
    标题、列表、引用、表格、任务列表、暗色、移动端）；
  - 不通过旧的总样式或 React 默认入口间接引入全局 `@page`；打印由站点控制。
    仅拆出屏幕 CSS 仍不足以完成隔离，必须检查 JS 入口的样式副作用。
- 安全：三个 HTML flag 一律不传；`urlPolicy` 只是客户端白名单，私有资源仍由 raw 路由判权。

退出条件（在 flag=shadow 下）：

- 一个仅管理员可见的 `/reactive-preview/[id]`（或 dev-only 路由）能渲染任意存量文章；
- SSR 首屏有正文；关闭 JS 仍有正文与脚注；
- 暗色/亮色、375px、打印各有一张人工验收截图；
- 编译缓存命中率与 p95 编译耗时进日志。

### M3 站点引用组件

**目标**：五类引用在新渲染器下有等价能力，且权限口径不变。

适配器：

- 新增 `src/lib/reactive/ref-adapter.ts`，复用现有扫描/盖码/预算逻辑：
  - 图床（10 位）→ Markdown `![id](/api/images/id/raw)`；
  - 音频 → `<site-embed kind="audio" ref="…">`；
  - 投票（9 位）→ `<site-embed kind="vote" ref="…">`；
  - 收藏夹（6 位）→ `<site-embed kind="favorite" ref="…">`；
  - 剪贴板（8 位）→ 读取格式后按下面的矩阵决定内联或链接卡片；首期不运行子文档。
- 保留 `MAX_BLOG_REF_ITEMS=50`、`MAX_REF_FETCHES=50`、`MAX_REF_EXPAND_CHARS=500000`、
  `MAX_REF_CONCURRENCY=4`；音频另保留现有最多 3 条的展开上限；代码块盖码规则保留。
- `external` 模式：图片/音频/服务端下发的公开剪贴板可展开；投票/收藏夹保持字面量或
  静态降级，**一个请求都不发**。

这里的「不发请求」指引用解析器不额外发业务 HTTP；服务端可读公开数据，浏览器仍会加载
图片/音频 URL。外部视图不得借宿主组件绕过投票、收藏夹的现有权限。

| 使用位置 | 被引用内容 | 首期行为 |
|----------|------------|----------|
| legacy 博客或剪贴板 | markdown 剪贴板 | 保持原有内联与预算 |
| reactive 管线 | markdown 剪贴板 | 只有通过语义兼容检查的内容可内联一层，否则显示链接卡片 |
| 任一博客或剪贴板 | reactive 剪贴板 | 显示链接卡片，不嵌套编译或运行 |
| 评论 / 讨论 | markdown 剪贴板 | 保持现有首条引用与截断规则 |
| 评论 / 讨论 | reactive 剪贴板 | 生成链接，不把 reactive 源码送进 Markdown 渲染器 |

所有 API / 服务 DTO / externalClips 数据携带 `format`、内容版本及正文。
内联内容进入新语法前也须盖码、检查碰撞并处理作者伪造宿主标签；不能只转义父文档。
适配器返回区间映射与来源，标明父文档或引用文档；生成标签与对应 `hostData` 在同一结果中提交。

数据层：

- 服务端统一解析引用数据（成员 `expand` / 对外 `external`），随 RSC payload 下发给
  `hostData`；阅读页不做客户端取数。
- 投票的 `user_voted` 取当前会话；导出/静态快照取「未投」状态。
- 收藏夹卡片、剪贴板内联仍走现有服务层，不复用旧的 HTML 拼串。
- 抽出结构化读模型时保留 API 的登录、档位、资源可见性检查，不能只调用绕过入口 guard 的底层查询。
- 评论/讨论的引用缓存保存格式与内容版本，reactive 链接不进入原有纯正文展开路径。

渲染：

- 按 0.5.2 的实际 API：`hostData`（键 = `${kind}:${ref}`）+ `hostRenderer(node, data, ctx)`；
- 标签放在**独立行**（块级嵌入）；行内嵌入（如果将来需要）必须重新确认段落语义；
- `hostData` 的每条值都是 `unknown`（**JSON-safe**），站点自己定义形状：
  `{ status: 'ready' | 'error' | 'forbidden', payload }`；
- 每个 renderer 都要处理：ready / error / forbidden 三态，可访问名称，键盘可达；
  `ctx.mode === 'static'` 返回只读快照；
- **`external` 模式解析不到时不要发标签**：保留 `[@…]` 字面量，与现在的口径逐字一致；
  否则 ReactiveMD 会渲染 `local-host-unavailable` 占位，页面上多出一行诊断文案；
- 预览态的「不发业务写请求」用闭包传（0.5.2 的 `ctx` 没有 preview 字段）；
- 组件内部**绝不** `innerHTML`；一律 React 元素。

测试：

- `tests/unit/ref-adapter.test.ts`：输出形状、预算、盖码、external 不发请求；
- `tests/unit/site-embed.test.tsx`：三态、静态模式不请求、id 校验；
- 安全用例：伪造 id、`javascript:`、属性逃逸。

退出条件：五类引用与现有 e2e 的产品行为逐条对齐（类名可以改，行为不能变）。

### M4 只读阅读页切换

改动：

- `src/app/blog/[id]/page.tsx`：读取 `format` / `renderer_override`，选择渲染器；
  新渲染器走 `ReactiveDocument`（`staticFirst`），旧渲染器保持现状。
- `src/app/clipboard/[id]/ClipDetailClient.tsx`：同上。
- `resolvePublicClipRefs` 的产物改为 reactive 适配器可消费的形状；旧的 HTML 展开
  只在 legacy 分支使用。
- 回退与观测按 §3 D4。
- 决定 `force-dynamic` 的去留：M4 **先保持**，只测量 TTFB 与编译耗时；优化放到 M7。
- 无 JS、打印、暗色、移动端的验收。

测试：

- e2e：`blog-visibility`、`content-ref`、`vote-embed`、`clipboard-*`、`blog-timestamps`
  按新 DOM 改写；保留产品契约断言（正文出现、投票可投、图片可放大、代码可复制）。
- 新增 e2e：`javascriptEnabled: false` 下正文与脚注可见；渲染路径标识正确；
  逐篇 override 生效。

退出条件：获准迁移的文档在 flag=on 且命中灰度时使用新渲染器；Markdown override 可回旧管线，
reactive 可关交互并展示同版本快照。页面、摘要、导出各按格式验收；spider 的源码契约保持稳定。

### M5 编辑器预览与作者工具

改动：

- 预览：与阅读页共用 `ReactiveDocument`，`mode="interactive"` 但站点嵌入组件以只读态
  渲染（不发业务写请求）。这一层用 `preview` 上下文标记，不用 `mode="static"`。
- 编译调度：`LocalCompileScheduler` + worker；防抖 150–400ms；编译期间保留上一版预览；
  worker 不可用时退回主线程（与官方 Playground 一致）。
- 「插入组件」：
  - 菜单数据来自上游公开的组件目录；
  - 属性表单由 `LocalComponentSchema.props` 生成（文本/数字/布尔/枚举、默认值、必填、
    `bind` 初值）；
  - inline / block 决定光标与前后空行；
  - 走 CM6 transaction，保留撤销、选区、IME；
  - 插入前用相同编译配置校验完整候选文档，拒绝新增的模板/结构错误。
- 作者工具（CM6 扩展，基于纯函数）：
  - `analyzeLocalSource` → 高亮 decoration；
  - `completeLocalSource` → 补全 source；
  - diagnostics → lint gutter；
  - `formatLocalSource` / `renameLocalBinding` → 命令。
- 工具针对作者原文运行并使用与预览一致的编译配置；适配后诊断通过区间映射回原文。
  引用内部诊断归属引用卡片，不能伪造为父文档错误。完整性校验不能修改引用内容。
- 资源面板（图床/音频/投票/收藏夹/剪贴板）继续插入 `[@…]`，不直接插入 `site-embed`。
- 格式进入表单、API 与草稿版本；恢复旧草稿保留原文并沿用文档格式，不能静默转为 reactive。

测试：

- `tests/unit/reactive-authoring.test.ts`：补全/格式化/重命名/插入模板；
- e2e：先验证插入组件、预览与草稿恢复；M6 快照发布链路完成后补齐新建 → 发布 → 阅读闭环；
- 长文（250k 字符）输入不阻塞（测量输入到下一帧）。

作者工具退出条件：作者不需要手写 `site-embed`，草稿恢复、撤销与 IME 通过真实浏览器验收。
reactive 写入保持关闭，待 M6 集成后验证预览/阅读编译键与同版本快照，再开放发布。

### M6 导出 / 摘要 / 对外契约 / 文档

发布快照：

- 服务端用同一编译配置与静态 renderer 生成可信快照，按 D2 的公开权限边界取引用数据。
  不接收客户端导出 HTML 作为发布快照，不要求上游新增独立渲染框架。
- 快照存储迁移、同版本发布、旧版本失效与读路径接线在开放 reactive 写入前完成；
  失败保留旧的已发布版本和本地草稿，不让正文与快照只成功一半。
- 验收后才接通 M5 的发布闭环。M5 的菜单、预览和草稿工具可提前交付。

导出：

- 新增 `renderStaticMarkup(adaptedSource, { hostComponents, hostData, hostRenderer })`：
  - 离屏 `createRoot` + `flushSync` 渲染 `mode="static"`；
  - `imageResolver` 用预取的 data URL 映射（先 fetch 全部图片，再同步映射）；
  - 用同一套 `hostData` / `hostRenderer`（`ctx.mode === 'static'` 分支）；
  - 读 `innerHTML` 后 unmount；
  - 不再读预览 DOM，不再走 `buildSnapshot`。
- `buildExportHtml` 继续负责「拼文件 + 绝对化 URL + 抄 head 样式」；
  `.md-document` 的 CSS 会随全局样式一起进导出件。
- 明确语义：导出件展示的是**初始值**的静态文档（在相同引用快照下与阅读初始状态一致），
  不是作者当前调过的滑杆值；写在导出说明里。
- MathML 在打印/Word/离线环境的差异要有一条人工验收；私有图片/音频在导出件里取不到，
  文案照旧如实说明。

摘要：

- `blog-excerpt.ts` 增加按 `format` 分派；reactive 分支用编译后的 AST 走文本提取：
  - 保留容器（`panel` / `card` / `tab`）内的文字；
  - 丢弃 `computed` / `const` / `validation` / 组件标签；
  - `{{ }}` 用初始状态求值，失败则整个表达式省略（不要输出表达式源码）；
  - 丢弃脚注标记与 `[@…]` token；
  - 结果仍是纯文本，React 直接画。
- 摘要按内容 hash 走编译缓存；不要在 profile 页为每张卡片重复编译。

对外契约：

- 博客详情 API 与 spider 详情接口增加 `format`、`syntax_version`（路由名按现有代码核对）；
  `content` 仍是源码，不新增 HTML 字段。
- `docs/bot/blog-bot.md` 更新「content 是 Markdown 源文」的描述，写明 reactive 文档的
  取值与 format 字段；这是对外契约变更，要在发布说明里点名。
- 搜索：`search_fields=content` 继续搜源码；在 bot 文档里说明组件标签也会被匹配
  （不另做一套正文抽词）。
- 剪贴板读写 API 与引用消费者也同步格式字段；元数据可在 M0 先交付，reactive 写入仍有快照闸门。
- OG/description/sitemap 不变。

文档同步清单：

- `docs/architecture.md` §6.7 / §7.3 / §6.11–6.12，新增一节记录新渲染器；
- `docs/guide/内容引用语法指南.md`（五类引用在新渲染器里的行为）；
- `docs/bot/blog-bot.md`；
- `docs/frontend-styles.md`（`.md-document` 对齐与打印）；
- `docs/README.md`、`src/lib/docs-catalog.ts`、`docs/plan/README.md`；
- 实现完成后在 `CLAUDE.md`「关键约定」补一条指向本文与新落点。

退出条件：同版本发布快照及 M5 发布闭环可用；导出件离线可读；摘要无标签/表达式泄漏；
外部消费者能按 `format` 分支；文档守卫全绿。

### M7 灰度、回滚演练与清理

- 灰度：`off → shadow → 5% → 25% → 100%`，按内容类型 + 稳定 ID 分档；每档观察至少 48h。
- 指标：回退率、warning 码分布、编译 p95、TTFB p95、路由 JS 体积、错误率。
- 回滚演练：Markdown override 回 legacy；reactive 全局 off 展示当前版本静态快照；
  额外验证快照缺失、过期、公开/成员隔离及 API 源码格式不变。
- 清理：100% 且连续两周无回退仅是观察条件。还须确认没有未迁移 Markdown、没有 legacy
  override、回退机制已替代，才单独提交删除博客旧管线。
- 共享依赖按引用审计：`marked` / `dompurify` 仍供评论、故事、文档等使用，继续保留。
  `mathjax-full` 与字体复制脚本只有在全部消费者及部署脚本完成迁移后才可移除。

## 5. 接口与数据结构

### 5.1 内容格式

```ts
export const CONTENT_FORMATS = ['markdown', 'reactive'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export const DEFAULT_CONTENT_FORMAT: ContentFormat = 'markdown';

export interface RendererChoice {
  renderer: 'legacy' | 'reactive' | 'reactive-static' | 'unavailable';
  reason: 'format' | 'override' | 'flag' | 'percent' | 'fallback' | 'snapshot-missing';
}
```

### 5.2 宿主组件（A 方案，ReactiveMD 0.5.2 实际 API）

ReactiveMD 0.5.2 源码中的类型形状如下；接入使用包导出的类型。
`LocalRenderContext` 尚未从 React 公共入口导出，属于 U3 补丁，不能提前假定可 import：

```ts
export type LocalHostPropKind = 'string' | 'number' | 'boolean' | 'enum';

export interface LocalHostPropSchema {
  readonly kind: LocalHostPropKind;
  readonly required?: boolean;
  /** 为 true 时拒绝 {{ ... }}。 */
  readonly static?: boolean;
  /** kind === 'enum' 时必填、非空、去重。 */
  readonly enum?: readonly string[];
  /** 只用于 kind === 'string'，且必须是线性时间安全子集。 */
  readonly pattern?: string;
}

export interface LocalHostComponentSchema {
  readonly name: string;
  readonly form: 'leaf';
  readonly props: Readonly<Record<string, LocalHostPropSchema>>;
}

export type LocalHostData = Readonly<Record<string, unknown>>;

export type LocalHostRenderer = (
  node: LocalNode,
  data: unknown,
  ctx: LocalRenderContext,
) => ReactNode;

export interface LocalRenderContext {
  runtime: LocalRuntime;
  render(nodes?: LocalNode[], visible?: boolean): ReactNode;
  visible: boolean;
  mode: 'interactive' | 'static';
}
```

站点自己定义的数据形状（ReactiveMD 不解释 `payload`）：

```ts
export type SiteEmbedKind = 'audio' | 'vote' | 'favorite' | 'clipboard';

export interface SiteEmbedData {
  kind: SiteEmbedKind;
  ref: string;
  status: 'ready' | 'error' | 'forbidden';
  /** 可访问名称；不要拼用户输入以外的文本。 */
  title?: string;
  /** 仅 ready；每类引用自己的形状，**必须 JSON-safe**。 */
  payload?: unknown;
}

export type SiteHostData = Readonly<Record<`${SiteEmbedKind}:${string}`, SiteEmbedData>>;
```

注意：

- `hostData` 的键由 **`node.attrs.kind` + `node.attrs.ref`** 拼成，所以标签属性名
  必须是 `kind` / `ref`；
- `hostData` 会随 RSC payload 跨服务端/客户端边界，**只能放 JSON-safe 数据**：
  不要放 ReactNode、函数或类实例。静态形态由 `hostRenderer` 根据 `payload` 与
  `ctx.mode` 自己生成；
- `ctx` 里**没有** `locale` / `preview`；需要预览上下文时用闭包；
- `status` 不需要 `loading` / `missing`：数据没准备好就不要发标签（保留字面量），
  发了但缺数据 ReactiveMD 会显示占位。

### 5.3 编译缓存键

```ts
key = `${sha256(adaptedSource)}:${syntaxVersion}:${compilerVersion}:${adapterVersion}:${localCompileOptionsKey(options)}`;
```

### 5.4 渲染路径观测

外层 `data-content-renderer` 与日志记录真实决策；响应头在确认响应可写位置后附加：

```http
X-Content-Renderer: legacy | reactive | reactive-fallback | reactive-static
```

## 6. 失败处理

| 触发 | 行为 | 用户看到 |
|------|------|----------|
| `ok: false` | Markdown 回 legacy；reactive 读当前版本快照；记录诊断 | 旧渲染结果或静态正文 |
| warning 含 `local.html` / `local.component.unknown`，或未接受的数学显示降级 | 按内容格式降级；shadow 阶段只观测 | 同上 |
| 引用数据 5xx 且有静态快照 | 留在新渲染器，嵌入组件显示快照 | 降级卡片 |
| 引用数据 5xx 且无快照 | 该嵌入组件显示 error 态，不整篇回退 | 可重试的失败态 |
| 发了宿主标签但 `hostData` 缺键 / 缺 `hostRenderer` / renderer 抛错 | ReactiveMD 渲染 `local-host-unavailable` 占位；站点同时记一条错误日志（这是站点的 bug，不是文档的 bug） | 一行可见占位 |
| Markdown 单篇 override=legacy | 旧渲染器 | 旧渲染器结果 |
| reactive 被指定 legacy | 拒绝配置；若为脏值则报警并按 D2 降级 | 同版本静态正文或明确失败态 |
| reactive 快照缺失 / 版本不符 | 拒绝发布新版本；读路径不展示过期快照 | 编辑器保留草稿；阅读页显示失败态 |
| 编译缓存不可用 | 直接编译，记一次 miss | 无感 |

原则：**整篇回退只用于「内容解释不了」**；单个资源失败不能拖垮整篇。

## 7. 验收矩阵

| 面 | 证据 | 通过条件 |
|----|------|----------|
| 存量语料 | `reports/reactive-corpus.md` | 100% 分类；B 类逐类有处置 |
| 渲染主链路 | 单测 + e2e | 同源码、同引用快照的编译键一致；五类引用符合格式矩阵 |
| SSR / 无 JS | e2e `javascriptEnabled:false` | 正文、脚注、静态嵌入可见 |
| 主题 / 移动 / 打印 | 人工截图 + e2e 视口 | 暗色跟随；375px 无横向溢出；打印无交互控件 |
| 摘要 / 导出 | 单测 + 人工打开导出件 | 无 `<panel>` / `{{ }}` / 脚注标记泄漏 |
| 外部契约 | API 单测 + 文档守卫 | `format` 字段存在；`content` 仍是源码；bot 文档同步 |
| 性能 | 脚本 | 250k 字符编译 p95、TTFB、路由 JS 体积有基线并在预算内 |
| 安全 | 单测 + 代码审读 | 宿主组件无 HTML 拼串注入；快照仅接受服务端产物；HTML flags 全 false；无新 CSP 头 |
| 回滚 | 演练记录 | Markdown 回 legacy；reactive 当前版本快照；API 源码格式不变 |

## 8. 测试影响面（先冻结断言，再改代码）

现有涉及渲染链路的测试：

- 单元：`blog-renderer`、`blog-content-dom`、`blog-markdown`、`blog-ref-render`、
  `blog-excerpt`、`content-ref-*`、`favorite-refs`、`md-editor-export`、
  `md-editor-preview-votes`、`md-editor-upload`、`css-tsx-classes`；
- e2e：`blog-visibility`、`blog`、`blog-timestamps`、`clipboard-layout`、
  `clipboard-math`、`comment-layout`、`content-ref`、`editor-hardening`、
  `editor-resources`、`vote-embed`。

其中被钉死的产品契约：`.vote-embed*` 的投票行为、`.copy-btn` 复制、图片放大、
`#userContentContainer` / `.blog-content-container` 的容器关系。M1 之后先出一份
「保留 / 可改 / 删除」清单，再动渲染器。

## 9. 接入选择与待验证事项

| 项目 | 本计划采用的方案 | 仍需验证 |
|------|------------------|----------|
| 软换行 | 上游 U1；旧 Markdown 启用，reactive 默认保持 CommonMark 语义 | 两种配置的语料和 worker 一致性 |
| 外链图片 | 保留博客现有能力；收紧策略单独讨论 | 历史 IP、相对地址、外链及导出 |
| 索引 | 延续现有 public 可索引、link / internal 等非 public 不索引策略 | 无 JS 正文、robots 与权限一致；SSR 不等于新开放可见性 |
| 嵌套剪贴板 | 按 M3 格式矩阵；reactive 统一链接卡片 | Markdown 内联的语义碰撞和来源诊断 |
| 依赖 | npm 精确版本 `reactive-md@0.5.3`（已安装），不 vendor 上游源码 | 包产物、Node / Next / worker 兼容性及后续版本升级 |
| 作者工具 | U4 公共入口 + U5 配置一致性 | CM6 撤销、选区、IME 与长文输入 |
| 评论 / 讨论引用 | Markdown 保持首条引用展开，reactive 显示链接 | API 格式字段与缓存升级 |

实际实施时还需确定：静态快照的持久化表结构和内容版本标识、响应头写入位置、
性能预算的数字阈值，以及 §11 条件项是否被语料或产品要求触发。
这些问题不阻塞 §12 中纯函数、格式透传、夹具和只读扫描的预适配。

## 10. 风险

- **「编译通过」不等于「渲染正确」**：换行、HTML 子集、数学子集、锚点都会静默变化。
  fallback 判据必须有 warning 白名单；corpus 报告必须看文本与结构 diff。
- **投票/音频/收藏夹/剪贴板的现有展开产物与 ReactiveMD 完全不兼容**：`class` 被拒、
  `audio` 不是 P0 HTML。不要试图「适配一下」，要用 0.5.2 的宿主组件落点重做。
- **宿主组件的失败是可见的**：缺 renderer / 缺 `hostData` 键 / renderer 抛错都会渲染
  一行 `local-host-unavailable` 占位。它不会白屏，但会把站点的数据错误暴露到页面上；
  所以「发标签」与「发数据」必须在同一处原子地决定。
- **`hostData` 的键是 `${kind}:${ref}`**：改属性名、改大小写、给 `ref` 做 URL 编码都会
  让数据对不上，而症状只是「页面上出现占位」，不报错。
- **数学是子集**：`aligned` / `matrix` / 自定义宏 / `\(...\)` 会原样显示。先量化，再决定
  修上游还是让相关文章留在旧渲染器。
- **锚点被命名空间化**：文档内部链接已有重写；外部章节分享依赖实例生成的 ID，
  跨布局变化的稳定性须验证。需要稳定外部深链时触发 §11 C1，不把内部跳转误报为全部失效。
- **SSR 编译成本**：`force-dynamic` 下每请求编译会抬 TTFB；必须有缓存与指标。
- **样式全局面**：总样式和 React 入口都会间接导入带 `@page` 的打印规则；
  等 U2 后再接入正式页面。`.md-document` 自带 `<article>`，需要容器与语义调整。
- **对外契约**：spider 的 `content` 被文档承诺为 Markdown；换语言等于换契约，必须
  加 `format` 并公告，不能悄悄改。
- **回滚不是「留着旧代码」**：没有逐篇标记和可观测性，就不知道线上哪篇在用哪个渲染器，
  回滚只能靠猜。
- **包与运行时**：ESM-only、Node >= 22.12（本站 `engines` 写的是 >= 20）。
  核对的源码树不含构建产物；正式使用有产物的 npm 精确补丁版本，部署机与 CI 先验证。

## 11. 上游补丁交付清单

本节保留为上游交付的验收清单。`reactive-md@0.5.3` 已交付 U1–U6 所需的公共入口与
诊断（宿主组件协议、拆分样式、公共导出、作者工具、选项贯通、数学诊断）；下表记录
它们当初的范围与站内依赖阶段。入口名、参数名以实际安装的 0.5.3 为准。
源码核对位置以 ReactiveMD 仓库相对路径列出，站点不从这些内部路径深导入。

| 编号 | 补丁 | 上游范围 | 站内依赖阶段 |
|------|------|----------|--------------|
| U1 | 软换行兼容选项 | 编译选项、解析/渲染、worker、签名 | M1 最终分类、M2、M4 |
| U2 | 屏幕/打印样式拆分及无样式 React 入口 | CSS、React 构建入口、package exports | M2、M4、M6 |
| U3 | 公共接口补齐 | 编译选项签名、宿主上下文类型、包声明 | M2 缓存与 wrapper |
| U4 | 作者工具公共入口 | schema、目录、模板、文本编辑纯函数 | M5 |
| U5 | 作者工具编译配置一致性 | 分析、补全、重命名、格式化的解析/校验 | M5 |
| U6 | 数学显示降级诊断 | 数学显示分析、稳定诊断、源码范围 | M1 最终分类、M4 |

### 11.1 U1 软换行

- 增加 `markdownBreaks?: boolean`，默认 false；开启后段落内 Markdown 软换行显示为 `<br>`。
- 类型、合法值校验、worker 配置快照与消息、`localCompileOptionsKey` 全部贯通。
- 保留原始 UTF-16 range；代码、公式、硬换行不受影响。不能用站点预处理插空格解决。
- 验收：默认行为不变；开关后 SSR / hydration / 静态导出一致；仅改选项也触发正确重编译。

### 11.2 U2 样式入口

- 提供无 CSS 副作用的 React 入口、屏幕样式入口及独立可选打印入口。
  建议名为 `reactive-md/react/unstyled`、`reactive-md/screen.css`、`reactive-md/print.css`。
- 原入口保留已有行为，发布说明注明新入口用途。无样式入口的依赖图不能再导入总样式。
- 验收：安装后的包可解析入口；仅用新 React + 屏幕 CSS 时产物无全局 `@page`；
  站点其他页面的打印规则不因访问博客而变化，原入口的现有消费者保持可用。

### 11.3 U3 公共导出

- 从核心入口导出 `localCompileOptionsKey`，从 React 入口导出 `LocalRenderContext`。
- 签名覆盖 U1 与所有影响编译的合法选项，保持与 worker 去重规则一致。
- 验收：通过打包安装后的真实入口导入函数和类型；声明生成、Node 导入及选项差异测试通过。

### 11.4 U4 作者工具入口

- 建议新增 `reactive-md/authoring`，提供 `LOCAL_COMPONENTS` / `getLocalComponent` 及 schema 类型、
  `getNativeComponentCatalog(locale)`、`renderNativeSnippet`、`insertTemplate` 与编辑结果类型。
- 可重导出已有分析、补全、重命名、格式化函数。目录复用编译器与现有模板数据，
  不为宿主维护第二份标签清单；英文、中文目录都可获取。
- 入口为纯逻辑，不加载编辑器组件、DOM 或 CSS。CM6 UI、transaction 和 IME 适配留在站点。
- 验收：纯 Node 与浏览器均可导入；模板、绑定名去重、选区结果与上下文中的编译校验通过。

### 11.5 U5 作者工具配置

- 为分析、补全、重命名和格式化增加可选编译配置，保留原函数调用的默认行为。
- 当前 `src/local/authoring.ts` 直接用默认选项调用 `parseLocal` / `compileLocal`；
  新参数须贯通全部解析、诊断与改写后的校验，不能只改最外层函数签名。
- 站点可见作者目录与编译时识别的宿主 schema 分开：宿主节点不自动进入补全或插入菜单。
- 验收：一篇超默认 10,000 节点但处于宿主预算内的合法文档，在阅读、分析、格式化和重命名
  中判断一致；非法配置也返回一致结果，原有无配置调用不变。

### 11.6 U6 数学显示诊断

- 对显示数学提供可在服务端调用的兼容性分析，输出稳定诊断码、原始源码范围及原因。
  原因至少区分未知命令、未知环境、解析失败与预算降级；文档级扫描也覆盖未被识别为公式的历史定界符。
- 当前 `src/local/math-view.tsx` 会降级为字面文本；分析与实际显示共用语法判断，避免各维护一份支持表。
- 通过编译诊断或独立公开分析接口交付均可，但语料报告与页面选择必须能在渲染前取得结果。
  诊断码由上游定名并列入公开目录，本站不靠解析英文报错匹配。
- 数学显示支持与绘图计算支持分别验证，不能拿 `compileLatex` 可计算的子集代替显示兼容性。
- 验收：支持公式不误报；未知命令/环境与超预算可检出；SSR 与客户端显示降级结论一致。

### 11.7 条件项与发布门槛

| 编号 | 触发条件 | 要求 |
|------|----------|------|
| C1 稳定锚点 | 本期要提供外部章节分享，或语料证明必须保留已有深链 | 宿主指定稳定命名空间；保留同页多文档隔离；测试 SSR/hydration、布局改变与重复标题 |
| C2 数学显示扩展 | M1 中实际文章因 `aligned`、矩阵、宏或历史定界符等无法等价迁移 | 按语料列支持集合与夹具，逐项实现或明确让对应 Markdown 文档留在 legacy |

U1/U2/U3/U6 通过打包安装、声明、SSR 与 worker 验证后，才进入阅读灰度。
M5 还要求 U4/U5。实际接入版本为 `reactive-md@0.5.3`；语法或协议是否升级按实际兼容性
决定，不把新能力写成旧版本的能力。C1/C2 的未触发状态不阻塞其他工作。

## 12. 现在可预先做的站内适配

本节列上游补丁前的适配范围，已按下表完成预适配，具体结果见 §12.5。
旧页面路径与默认 Markdown 写入行为保留，正式渲染、快照存储与作者工具仍按后续阶段交付。
预适配优先完成纯数据契约和受闸门保护的服务适配，不提前开放 reactive 编辑或发布。

### 12.1 可立即实施的任务

| 编号 | 任务与落点 | 依赖 | 验收与边界 |
|------|------------|------|------------|
| P1 | 格式枚举、格式列手写迁移、Prisma、博客/剪贴板 service 与 API DTO | 无上游依赖 | 存量默认 Markdown；新建默认不变；更新省略格式保留原值；reactive 写入暂拒绝 |
| P2 | 纯渲染选择函数、开关解析、稳定 ID 分档、观测结果类型 | P1 的类型，可先用内存输入 | off 优先；shadow 不改变可见结果；reactive 不送 legacy；快照缺失明确失败 |
| P3 | 引用扫描、预算规划、区间替换与来源映射 | 现有盖码与引用常量 | 不 import 上游；保持代码块、行内代码；音频 3 条及其他预算；生成标签/数据同时提交 |
| P4 | 服务端结构化引用读模型、权限适配、带格式的 externalClips 与客户端 DTO | P1/P3 | 与现有 API 的登录/档位/资源判权一致；external 无额外业务 HTTP；不串会话 |
| P5 | 剪贴板引用按格式分派、评论/讨论引用缓存升级 | P1/P4 | Markdown 原行为不变；reactive 只给链接；迁移前可用夹具模拟 reactive 响应 |
| P6 | 只读语料扫描、旧渲染基准、风险夹具和机器报告格式 | 无上游依赖；全量需只读数据源 | 记录覆盖率、结构/语法风险和预算；不包含私有正文；新编译结论标试验状态 |
| P7 | URL 用途策略、来源 hash、版本化缓存键结构、缓存容量工具 | 无上游依赖 | 资源与超链接分开；保留博客外链图片能力；拒绝危险协议；不缓存 runtime/会话数据 |
| P8 | 快照记录和发布一致性契约、存储迁移设计、读写接口骨架 | P1/P2 | 明确内容版本、公开快照边界和失效规则；可用测试产物验证，不能伪称真实静态导出已完成 |
| P9 | 产品断言清单、格式矩阵和集成测试夹具 | P1–P8 的契约 | 覆盖 API 兼容、引用权限、局部失败、编辑恢复、回滚；现有 legacy 验收仍通过 |

推荐顺序：先 P1/P2；P3 与 P6 可独立准备；再接 P4/P5，补 P7/P8/P9。
表中的路径和类型是计划落点，新增文件前先检查已有模块以免重复实现。
P1 的迁移编号以执行时的 `npm run migrate -- status` 为准；不在生产库手工重跑 ADD COLUMN。

### 12.2 适配结果与边界

引用适配结果至少包含以下信息，具体 TypeScript 命名在实现时确定：

```ts
interface AdaptationResult {
  adaptedSource: string;
  sourceHash: string;
  adaptedHash: string;
  adapterVersion: string;
  referenceSnapshotId: string;
  // UTF-16 半开区间；按原文、生成内容、引用内容分来源。
  segments: AdaptedSourceSegment[];
  hostData: SiteHostData;
}
```

- 替换后正文与映射同时构造，不能二次搜索文本来猜位置；一个 token 可对应完整生成块。
- 同形作者宿主标签在父文档与内联来源中都须检查；代码中的字面演示保持原样。
- 原文直接保留的区间可精确映射；生成区间的诊断定位到引用 token；引用内部错误保留来源 ID。
- 语义兼容性无法在上游补丁前确认的 Markdown 剪贴板，在 reactive 路径暂按链接处理。
- 会话数据按请求获取；引用内容更新使快照标识变化。相同源文 hash 不等于相同渲染输入。

P7 可先交付缓存键各字段和容量管理测试；真正调用上游选项签名、缓存编译产物在 U3 后接线。
P8 可先确定摘要/版本关联和存储接口；生成快照、同版本发布与失败拒绝必须在 M5 开放写入前集成。
持久快照的存储位置、格式及失效规则定稿后，再实施对应迁移。

### 12.3 上游交付后的状态（0.5.3）

- **最终语料分类、自动兼容判定与灰度名单**：仍未完成。`reactive:corpus` 只用夹具验证，
  未扫描业务库；报告仍是 provisional。
- **正式阅读 wrapper、样式、SSR / hydration、worker 构建与运行时生命周期**：已接入
  `ReactiveDocument` / `read-render` / `ReactivePreview`；真机与性能验收仍属 M7。
- **CM6 组件菜单、配置表单、完整诊断与重命名 / 格式化**：`reactive-md/authoring` 已公开，
  站内尚未接线；当前保留现有 CM6、上传、撤销、草稿和工具条。
- **静态快照实际生成、同版本发布**：`snapshot.ts` 契约已由迁移 36
  （`reactive_snapshots`）落地（存编译产物 JSON，不是 HTML）；正文与快照同事务写入；
  离线导出与 reactive 摘要已接入。reactive 写入因此仍关闭。
- **切换默认格式、迁移文章和删除博客旧管线**：仍未开始，等待语料、性能、浏览器与回滚验收。

### 12.4 预适配完成的判据

1. 代码可按任务单独提交；未完成上游补丁时旧页面与默认写入行为保持一致。
2. 格式与引用矩阵、开关决策、预算、位置映射、权限和快照版本均有对应验证。
3. 观测数据区分源码风险、编译失败、引用失败与站点实现错误，不把模拟结果当成上线证据。
4. 没有生产内容重写、没有提前开放 reactive 写入、没有删共享依赖；全量语料分类仍标待完成。
5. 更新本文与 `docs/plan/README.md` 的实际完成状态和验证依据，再安排下一阶段。

### 12.5 预适配实施记录（2026-10-26）

| 项目 | 已交付 | 后续阶段边界 |
|------|--------|--------------|
| P1 格式数据层 | 手写迁移 35、Prisma 字段、博客/剪贴板 service 和 API 格式透传；新建默认、更新保留与写入闸门 | 迁移尚未应用到业务库 |
| P2 渲染选择 | `renderer-select.ts`、flags 解析、稳定 ID 分档、同版本快照选择 | 纯决策函数已交付，现有页面仍使用 legacy |
| P3 引用与映射 | `ref-adapter.ts`、`source-map.ts`；五类引用、伪造标签转义、UTF-16 双向映射 | 剪贴板统一链接卡片；Markdown 内联须等语义验收；宿主 renderer 待 M3 |
| P4 结构化取数 | `ref-reader.ts`、`prepare.ts`；成员/公开权限、公开剪贴板 DTO、共同内容版本和源码 hash | 没有客户端重复取数或会话共享缓存；页面接线待 M2–M4 |
| P5 旧消费者 | legacy 博客引用与评论/讨论 hook 识别格式，缓存携带格式和版本；reactive/未知格式显示链接 | Markdown 原有内联保持；不切换评论/讨论渲染器 |
| P6 语料工具 | `reactive:corpus` 命令支持显式 JSON/JSONL 或 SQLite 只读输入；输出路径不能覆盖输入 | 仅以夹具验证；未扫描业务库，未形成全量语料分类；报告仍为 provisional |
| P7 URL 与缓存 | 用途 URL 策略、完整编译版本键、复制并深冻结的 JSON LRU、字节容量统计 | 尚未接入 ReactiveMD 编译；上游选项签名由未来调用方传入 |
| P8 快照契约 | `snapshot.ts` 的受信任生成器/存储接口、发布协调、版本与摘要校验、失败拒读 | 无生产表或真实快照生成器；服务端静态生成与同事务发布待 M6 |
| P9 验证 | 格式/API、引用权限与预算、位置映射、缓存隔离、快照竞态、扫描只读夹具 | 无 JS、SSR/hydration、IME、移动端与发布闭环仍需真机验收；作者工具尚未接线 |

整合修正包括：保留收藏夹与音频各自 3 条的显示预算；显式 null 格式不按旧 Markdown
解释；统一公开/成员剪贴板内容版本；缓存不受输入对象后续修改影响；快照生成前固定版本，
防止旧 HTML 被标为新内容版本；扫描命令拒绝覆盖输入文件、数据库及其已存在的文件别名。

验证依据：12 个直接相关测试文件共 367 项通过（按变更范围分批运行，修正后只重跑受影响项）；
受影响代码及消费者的定向 TypeScript 检查通过；迁移 SQL 在内存 SQLite 验证正文、默认值和跟踪哨兵。
没有运行文档检查、全量测试、构建或部署；没有操作业务库。

代码提交：`84e5b35f`（格式与选择）、`7da1fef1`（引用与权限）、`09e26819`（扫描/缓存/快照）、
`1cd206e3`（格式落库/API/旧消费者及服务端准备入口）。均为本地 commit，未推送或合并。

### 12.6 0.5.3 实施记录（2026-10-26）

`reactive-md@0.5.3` 已精确安装。本分支在预适配之上接入了阅读与预览链路：

| 阶段 | 已实现 | 文件落点 |
|------|--------|----------|
| M2 地基 | 服务端编译 + globalThis LRU + `mode="static"` 静态正文 + 宿主组件 schema + 诊断回退 + 管理员预览 | `src/lib/reactive/{compile,cache,host-components,diagnostics}.ts`、`src/app/components/reactive/ReactiveDocument.tsx`、`src/app/reactive-preview/[id]/page.tsx` |
| M3 引用 | 五类引用适配、区间映射、external 零业务请求、三态宿主渲染 | `src/lib/reactive/{ref-adapter,ref-reader,prepare,source-map}.ts`、`src/app/components/reactive/{SiteEmbedView,site-embed-static}.tsx` |
| M4 阅读页 | `read-render` 选择器、博客 / 剪贴板详情分叉、静态正文回退 | `src/lib/reactive/read-render.ts`、`src/app/blog/[id]/page.tsx`、`src/app/clipboard/[id]/page.tsx` |
| M5 预览 | 客户端适配 + `LocalCompileScheduler`（worker 回退主线程）、只读宿主渲染、格式选择、草稿格式信封与恢复 | `src/lib/reactive/client-compile.ts`、`src/app/components/reactive/ReactivePreview.tsx`、`src/lib/md-editor/draft.ts`、`BlogForm.tsx` / `clipboard/upload/UploadForm.tsx` |
| M6 摘要 / 契约 | AST 摘要、API / spider 的 `format` / `syntax_version`、导出按格式分派静态渲染 | `src/lib/blog-excerpt.ts`、`src/app/components/MarkdownEditor.tsx`、`src/app/components/markdown-editor/export.ts`、各 API route |
| 样式 | `.reactive-document .md-document` 站点对齐、暗色、375px、打印 | `src/styles-scss/pages/blog/_reactive-md.scss` |

**仍未完成 / 未验收：**

1. **M7 灰度与回滚演练**：`off → shadow → 5% → 25% → 100%`，观察回退率、诊断码分布、
   编译 p95、TTFB；`REACTIVE_MD_PERCENT` 默认 `0`，当前线上仍是 legacy。
2. **持久快照**：生产表 `reactive_snapshots`（迁移 36）与「正文 + 快照同事务发布」已接通；
   存的是 `LocalDocument` + external hostData（JSON），不是 HTML。读取优先同版本快照，
   签名过期时回退到当前正文现编译。
3. **语料分类**：`npm run reactive:corpus` 只用夹具验证，尚未扫描业务库，报告仍是
   provisional；A/B/C 分桶与灰度名单未定。
4. **编辑器作者工具**：格式选择、预览与草稿格式信封已接入；`reactive-md/authoring`
   的组件目录、「插入组件」菜单与行内诊断尚未接线。
5. **观测**：`data-content-renderer` 与结构化日志已落地；响应头
   `X-Content-Renderer` 尚未接入。
