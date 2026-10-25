# ReactiveMD 接入博客区方案（渲染器换代）

> **状态：草案（2026-10-26），未实施。方案 A 已定，ReactiveMD 0.5.2 已提供宿主组件协议。**
> 本文把「ReactiveMD 接入博客区」拆成 8 个依赖有序的阶段，并把 2026-10-25 代码审读
> 中发现的、原计划未覆盖的兼容性与工程约束写进对应阶段。
>
> 四条前置事实决定了这份计划的形状：
> 1. ReactiveMD 不是「另一个 Markdown 渲染器」，而是一套**文档语言 + 组件模型 + 运行时**；
> 2. **0.5.2（2026-10-26）已加上宿主组件扩展轴**（`hostComponents` / `hostComponent`
>    节点 / `hostData` / `hostRenderer`），方案 A 不再需要改协议形状，只需按实际 API 接入；
> 3. 但**作者工具所需的组件目录仍未公开导出**（`LOCAL_COMPONENTS` / `NATIVE_COMPONENTS`
>    不在包的公开 entry 里），M5 的「插入组件」仍要上游补导出或 vendor；
> 4. 本站存量正文里已经有大量会被新语法**重新解释**的内容（单换行、`{{ }}`、HTML 标签、
>    公式子集、`[@…]` 展开产物）。「编译通过」不等于「渲染正确」。
>
> §3 记录已定的决策，§9 列出仍然阻塞的待决策项。依赖固定到 **`reactive-md@0.5.2`**
> （`next` 渠道；`latest` 仍是 0.4.0），协议为 `component-protocol-2`，语法仍为
> `local-draft-2`。

## 1. 目标与非目标

### 1.1 要交付的行为

- 博客详情页、剪贴板详情页、编辑器完整预览统一走：
  `原始源码 → 引用适配器 → compileLocal → LocalDocumentView`。
- 预览与阅读页共用同一份编译产物（同一个 source hash），只允许 `mode` 与宿主上下文不同。
- 公开文章服务端渲染静态首屏（`staticFirst`），无 JS 时正文可读、脚注可跳、引用有静态降级。
- `[@…]` 五类引用在新渲染器里有与现在等价的能力与权限口径：
  图床 / 音频 / 投票 / 收藏夹 / 剪贴板（含对外视图 `external` 的「不发请求」承诺）。
- 编辑器保留 CodeMirror 6；新增基于组件 schema 的「插入组件」、补全、行内诊断、格式化、
  重命名；组件目录只有一份数据源。
- 导出、摘要、spider 的 `content` 契约与渲染器解耦；外部消费者能分辨内容格式。
- 旧渲染器按篇可回滚；线上能观测到某一篇实际用了哪个渲染器、是否回退。

### 1.2 非目标

- 不把评论、讨论、故事切到 ReactiveMD。它们分别走 `rich-text.ts` 与 `story-service.ts`
  的独立管线；本次不动。
- 不开启 ReactiveMD 的 HTML capability flags（`enableCss` / `enableJavaScript` /
  `enableExtendedHtml`）。任一为 true 会把整篇文档切到 sandboxed iframe 分支，Markdown、
  组件、站点样式与权限全部失效。
- 不新增 CSP / `X-Frame-Options` / `frame-ancestors`。本站刻意允许被第三方 iframe 嵌入。
- 不维护第二套编辑器；不替换 CM6。
- 不做「嵌套 ReactiveMD 文档」：剪贴板可以内联进博客，但嵌套层级有明确上限（见 §4 M3）。
- 不在本期把评论/讨论里的 `[@8位]` 升级成嵌套渲染（仍只做「内联正文 / 降级为链接」）。

### 1.3 术语

| 术语 | 指什么 |
|------|--------|
| 旧渲染器 | `blog-renderer.ts` + `blog-content-dom.ts` + `MarkdownRenderer.tsx` |
| 新渲染器 | `compileLocal` + `LocalDocumentView` + 站点适配层（`src/lib/reactive/`） |
| 站点引用 | `[@…]` 五类：图床 / 音频 / 投票 / 收藏夹 / 剪贴板 |
| 宿主组件 | 只在站点侧注册、作者不能直接书写的组件（见 §3 D1） |
| 编译产物 | `compileLocal` 返回的 `LocalDocument` + `LocalRuntime` |

## 2. 审读结论（原计划需要修正的地方）

| # | 原计划假设 | 代码事实 | 影响 |
|---|-----------|----------|------|
| 1 | 旧管线保留给「评论、故事和回滚」 | `MarkdownRenderer` 只有三个消费者：`blog/[id]/page.tsx:217`、`ClipDetailClient.tsx:172`、`MarkdownEditor.tsx:685`；评论走 `rich-text.ts`，故事走 `story-service.ts:477` | 保留旧管线的唯一理由是回滚；不要把它当成评论/故事的依赖 |
| 2 | 需要补齐代码高亮、复制按钮、图片放大、外链加固 | ReactiveMD 已内置：`src/local/code-block.tsx`（lowlight + 复制）、`image-view.tsx`（`<dialog>` 放大）、`LocalDocumentView.tsx:1249-1252`（外链 `_blank` + `noopener noreferrer`） | 要做的是「迁移站点视觉与口径」，不是「从零实现」 |
| 3 | 编译失败才 fallback | `class` / `style` / `on*` 会让整个 HTML 标签降级成源码文本（`parser.ts:670`）；`audio` / `video` / `input` / `button` 不是 P0 HTML，会走「未知组件」分支；这些情况 `ok === true` | fallback 判据必须包含 warning 白名单，不能只看 `ok` |
| 4 | 插件/组件列表来自 ReactiveMD 的 schema | 0.5.2 已提供**宿主组件**协议，但 `src/local/index.ts` 与 `src/editor/index.ts` 的公开导出仍不含 `schema.ts` / `native-components.ts` | 站点引用组件可以直接接入；**作者工具目录**（插入/补全）仍要上游补导出或 vendor |
| 5 | ReactiveMD 的编辑器可以「移植工具条/命令」到 CM6 | 编辑器是 textarea + overlay（`ReactiveMarkdownEditor.tsx:65`）；可复用的是纯函数 `analyzeLocalSource` / `completeLocalSource` / `renameLocalBinding` / `formatLocalSource` 与 `editor-commands.ts` | 高亮/补全/诊断的 UI 层要按 CM6 重写；计划要写清「哪些可移植」 |
| 6 | 公开文章用 `staticFirst` 即可 | `staticFirst` 存在（`LocalDocumentView.tsx:4454`），但 `LocalReactiveDocument` 在 `useMemo` 里**同步编译**（`LocalDocumentView.tsx:4629`） | SSR 成本、编辑防抖、worker 都不会自动获得，要宿主自己接线 |
| 7 | 外对接口只需要「别暴露组件标签」 | `spider-service.ts:173` 直接返回原始 `content`；`/api/blogs/[id]` 同样；`docs/bot/blog-bot.md:252` 明写「content = Markdown 源文」 | 这是一次对外契约变更，要加 `format` 字段并同步 bot 文档 |
| 8 | RSS/feed 需要检查 | 仓库里没有 RSS 正文管线（`feed-service.ts` 是投喂鱼干） | 真正要检查的是 spider、`/api/blogs/:id`、OG、主页摘要 |

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
- `renderer_override`: `NULL | 'legacy' | 'reactive'`，运维/站长逐篇强制。
  优先级：`override` > 全局开关 > `format` 推导。
- 存量行默认 `markdown`，**迁移不做任何内容改写**。

回滚粒度：**全局环境开关 + 单篇 override + 编译失败自动回退**，三者都要有。
推荐环境变量：`REACTIVE_MD_MODE=off|shadow|on`、`REACTIVE_MD_PERCENT=0..100`（按内容
hash 取模，保证同一篇稳定落在同一档）。

### D3 编译位置与缓存

| 场景 | 在哪编译 | 说明 |
|------|----------|------|
| 阅读页（成员 / 访客） | 服务端首次渲染 + 客户端 hydration 各一次 | `LocalReactiveDocument`/wrapper 在 `useMemo` 同步编译；服务端加 LRU，按 `sha256(source)+syntax+options` 缓存 |
| 编辑器预览 | 客户端 worker + 防抖 | `LocalCompileScheduler` + `startLocalCompileWorker`；编译期间保留上一版预览，不阻塞输入 |
| 导出 | 客户端，`mode="static"` | 离屏 root + `flushSync` 后读 `innerHTML`；`imageResolver` 用预取的 data URL 映射 |
| 摘要 / 卡片 | 服务端 | 复用同一个编译缓存；不要为摘要另起一套解析 |

缓存键：`sha256(source) + ':' + syntaxVersion + ':' + localCompileOptionsKey(options)`。
缓存按**总字符数**设上限（例如 8MB），不是按条数；命中率与编译耗时进日志。

### D4 回退判据与可观测性

回退到旧渲染器的条件（满足任一）：

1. `compileLocal` 返回 `ok: false`；
2. diagnostics 中出现 `local.html`（HTML 属性降级）或 `local.component.unknown`
   （未知标签/组件）——这两类会**静默改变可见内容**；
3. 站点适配层判定引用数据不完整（例如投票/收藏夹接口 5xx 且没有静态快照）；
4. 单篇 `renderer_override = 'legacy'`。

观测：

- 响应头 `X-Content-Renderer: legacy | reactive | reactive-fallback`（不含内容，仅标识）；
- 服务端日志记 `blogId / format / renderer / diagnostic codes / compile ms / cache hit`；
- 管理端（或运维 CLI）能列出最近回退的文章与原因；
- e2e 可以按响应头断言，不依赖 DOM 类名。

### D5 编辑器与组件目录

- 保留 `MarkdownEditor.tsx` 的 CM6、上传、草稿、Ctrl+S、自动保存、导出、textarea 回退。
- **0.5.2 仍未公开作者工具目录**。M5 之前必须二选一：
  - （推荐）在 ReactiveMD 再加一个公开导出（或新增 `reactive-md/authoring` 入口）：
    `LOCAL_COMPONENTS`、`getLocalComponent`、`NATIVE_COMPONENTS`、`NATIVE_COMPONENT_GROUPS`、
    `renderNativeSnippet`、`insertTemplate` 所需的纯逻辑；
  - 或把 ReactiveMD 源码 vendor 进本站，直接从 `src/editor/native-components.ts` 取目录。
- 站点只消费这份导出，不手抄组件列表；`site-embed` 不进作者目录。
- 插入走 CM6 transaction（`view.dispatch({ changes, selection })`），保留撤销、选区、IME；
  插入前用 `compileLocal` 校验候选片段，失败则给出诊断而不是写入。
- 旧的 markdown / reactive 双格式开关在 M6 之后才移除；迁移期按 `format` 显示只读提示。

## 4. 分阶段实施

### M0 数据层与开关（前置，不改渲染）

**目标**：让「这篇用哪个渲染器」成为可存储、可查询、可回滚的事实。

改动：

- `prisma/migrations/35_reactive_md_format/migration.sql`（按 §3 D2 的列，纯 ADD COLUMN）。
- `src/lib/content-format.ts`（**零依赖**）：`ContentFormat`、`parseContentFormat`、
  `DEFAULT_CONTENT_FORMAT`、`formatLabel`（人话表用 `Record<ContentFormat, string>`，加第三档时 tsc 报错）。
- `src/lib/blog-service.ts` / `src/lib/clipboard-service.ts`：读取时带出 `format` 与
  `syntax_version`；写入时校验白名单；默认值不改变现有行为。
- `src/lib/renderer-select.ts`（服务端）：实现 §3 D4 的优先级，返回
  `{ renderer: 'legacy' | 'reactive', reason }`。
- `src/lib/reactive/flags.ts`：环境变量解析（**零依赖**，客户端也能读公开的部分）。
- `prisma/schema.prisma`：同步列与注释。

测试：

- `tests/unit/content-format.test.ts`：白名单、默认值、脏值不猜测。
- `tests/unit/renderer-select.test.ts`：override / 全局 / 百分比分档 / 非法值。
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

退出条件：100% 文档有分类；B 类每一类都有明确处置（不是「以后再说」）；
预算超限的文章数量与清单确定。

### M2 ReactiveMD 地基（跨仓库）

**上游改动（ReactiveMD 仓库）**：

- **已完成（0.5.2，2026-10-26）**：宿主组件扩展轴、`hostComponent` 节点、
  `hostData` / `hostRenderer`、worker 透传 schema、`local.host.attribute`、
  静态模式同一分派、协议升到 `component-protocol-2`。本站直接用，不再设计协议形状。
- **仍需上游补的两项**：
  1. `markdownBreaks` 编译/渲染选项：把段落内软换行渲染成 `<br>`，默认关闭。
     —— 这是本站 `breaks: true` 的兼容开关，**不要**用预处理改源码
     （会破坏诊断偏移与编辑选区）。0.5.2 的文档仍明确「ordinary single newlines
     remain Markdown soft breaks」，所以这一项**尚未提供**。
  2. 公开作者工具所需的 schema / 原生组件目录（见 D5）。
- 发布版本、CHANGELOG、兼容性说明；本站固定到精确版本 **`reactive-md@0.5.2`**
  （`next` 渠道；`latest` 仍是 0.4.0，不能用 `latest`）。

**站内改动**：

- 依赖来源写死：npm 精确版本 / git tag / vendor `packages/reactive-md`（三选一，见 §9）。
  注意当前 ReactiveMD 仓库**没有 `dist-library` 产物**，走 git/file 依赖必须能跑 `prepack`。
- `src/app/components/reactive/ReactiveDocument.tsx`（`'use client'`）：
  - 入参：`adaptedSource`（**已经过引用适配的源码**）、`format`、`mode`、`staticFirst`、
    `locale="zh"`、`urlPolicy`、`hostComponents`、`hostData`、`hostRenderer`、
    `onDiagnostics`；
  - 内部：编译（或接收编译结果）→ `createLocalRuntime` → `LocalDocumentView`；
  - **wrapper 不做 `[@…]` 适配**：阅读页的适配器在服务端跑（要权限），编辑器的适配器
    在客户端跑（要会话）；wrapper 只认适配后的源码，避免两边各自解析出不同结果；
  - 严格模式下运行时释放按官方 `queueMicrotask` 语义处理，不自己写一套。
- `src/lib/reactive/url-policy.ts`：
  - 允许同源 `/api/images/`、`/api/audio/`、`/api/avatar/`、`/image/i/`（历史 rewrite）；
  - 允许历史写死主机的图片（`next.config.mjs` 注释里那批 `http://116.62.179.232:22822`）；
  - 外链图片默认**拒绝**（与音频一致，避免跟踪像素）；若 corpus 显示存量确有需要，
    再加显式 host 白名单，不要放开成「任意 http(s)」。
- `src/lib/reactive/compile-cache.ts`：服务端 LRU（见 D3），带命中率指标。
- `src/lib/reactive/diagnostics.ts`：把 diagnostics 映射成日志、响应头与回退判据。
- 样式：
  - 只在客户端边界 import 一次 `reactive-md/styles.css`；
  - 新增 `src/styles-scss/pages/blog/_reactive-md.scss` 做站点对齐（宽度、字号、行高、
    标题、列表、引用、表格、任务列表、暗色、移动端）；
  - **不要全局引入 `reactive-md/print.css`**：它有全局 `@page { margin }`，会改全站打印。
    打印样式按需截取或让上游 scope 掉。
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
  - 剪贴板（8 位）→ 默认内联源文；若嵌套内容本身是 `reactive`，改为
    `<site-embed kind="clipboard" ref="…">`，**最多一层**，不递归。
- 保留 `MAX_BLOG_REF_ITEMS=50`、`MAX_REF_FETCHES=50`、`MAX_REF_EXPAND_CHARS=500000`、
  `MAX_REF_CONCURRENCY=4`；代码块盖码规则逐字保留。
- `external` 模式：图片/音频/服务端下发的公开剪贴板可展开；投票/收藏夹保持字面量或
  静态降级，**一个请求都不发**。

数据层：

- 服务端统一解析引用数据（成员 `expand` / 对外 `external`），随 RSC payload 下发给
  `hostData`；阅读页不做客户端取数。
- 投票的 `user_voted` 取当前会话；导出/静态快照取「未投」状态。
- 收藏夹卡片、剪贴板内联仍走现有服务层，不复用旧的 HTML 拼串。

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
- 新增 e2e：`javascriptEnabled: false` 下正文与脚注可见；响应头标识正确；
  逐篇 override 生效。

退出条件：flag=on 时，博客与剪贴板详情页全部走新渲染器；任意一篇都能通过 override
回到旧渲染器且四处（页面/摘要/导出/spider）一致。

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
  - 插入前 `compileLocal` 校验候选片段，失败不写入。
- 作者工具（CM6 扩展，基于纯函数）：
  - `analyzeLocalSource` → 高亮 decoration；
  - `completeLocalSource` → 补全 source；
  - diagnostics → lint gutter；
  - `formatLocalSource` / `renameLocalBinding` → 命令。
- 资源面板（图床/音频/投票/收藏夹/剪贴板）继续插入 `[@…]`，不直接插入 `site-embed`。
- 双格式开关：仅在 `format='markdown'` 的文档上显示迁移提示；M6 之后再移除。

测试：

- `tests/unit/reactive-authoring.test.ts`：补全/格式化/重命名/插入模板；
- e2e：新建 reactive 文档 → 插入组件 → 预览 → 发布 → 阅读，字符一致；
- 长文（250k 字符）输入不阻塞（测量输入到下一帧）。

退出条件：预览与发布后的正文来自同一 source hash；作者不需要手写 `site-embed`。

### M6 导出 / 摘要 / 对外契约 / 文档

导出：

- 新增 `renderStaticMarkup(adaptedSource, { hostComponents, hostData, hostRenderer })`：
  - 离屏 `createRoot` + `flushSync` 渲染 `mode="static"`；
  - `imageResolver` 用预取的 data URL 映射（先 fetch 全部图片，再同步映射）；
  - 用同一套 `hostData` / `hostRenderer`（`ctx.mode === 'static'` 分支）；
  - 读 `innerHTML` 后 unmount；
  - 不再读预览 DOM，不再走 `buildSnapshot`。
- `buildExportHtml` 继续负责「拼文件 + 绝对化 URL + 抄 head 样式」；
  `.md-document` 的 CSS 会随全局样式一起进导出件。
- 明确语义：导出件展示的是**初始值**的静态文档（与发布后读者看到的一致），
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

- `GET /api/spider/blog/:id` 与 `GET /api/blogs/:id` 增加 `format`、`syntax_version`；
  `content` 仍是源码，不新增 HTML 字段。
- `docs/bot/blog-bot.md` 更新「content 是 Markdown 源文」的描述，写明 reactive 文档的
  取值与 format 字段；这是对外契约变更，要在发布说明里点名。
- 搜索：`search_fields=content` 继续搜源码；在 bot 文档里说明组件标签也会被匹配
  （不另做一套正文抽词）。
- OG/description/sitemap 不变。

文档同步清单：

- `docs/architecture.md` §6.7 / §7.3 / §6.11–6.12，新增一节记录新渲染器；
- `docs/guide/内容引用语法指南.md`（五类引用在新渲染器里的行为）；
- `docs/bot/blog-bot.md`；
- `docs/frontend-styles.md`（`.md-document` 对齐与打印）；
- `docs/README.md`、`src/lib/docs-catalog.ts`、`docs/plan/README.md`；
- 实现完成后在 `CLAUDE.md`「关键约定」补一条指向本文与新落点。

退出条件：导出件离线可读；摘要无标签/表达式泄漏；外部消费者能按 `format` 分支；
文档守卫全绿。

### M7 灰度、回滚演练与清理

- 灰度：`off → shadow → 5% → 25% → 100%`，按内容 hash 稳定分档；每档观察至少 48h。
- 指标：回退率、warning 码分布、编译 p95、TTFB p95、路由 JS 体积、错误率。
- 回滚演练：任选一篇已切换文章，改 `renderer_override='legacy'`，确认页面/摘要/导出/
  spider 四处一致；再做一次全局 `off` 演练。
- 清理：100% 且连续两周无回退后，**单独一次提交**删除旧管线；在此之前不删
  `blog-renderer.ts` / `blog-content-dom.ts` / `MarkdownRenderer.tsx`，
  也不从 package.json 移除 `marked` / `dompurify` / `mathjax-full`。

## 5. 接口与数据结构

### 5.1 内容格式

```ts
export const CONTENT_FORMATS = ['markdown', 'reactive'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export const DEFAULT_CONTENT_FORMAT: ContentFormat = 'markdown';

export interface RendererChoice {
  renderer: 'legacy' | 'reactive';
  reason: 'format' | 'override' | 'flag' | 'percent' | 'fallback';
}
```

### 5.2 宿主组件（A 方案，ReactiveMD 0.5.2 实际 API）

ReactiveMD 公开的类型（**照抄，不要自定义同名形状**）：

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
key = `${sha256(source)}:${syntaxVersion}:${localCompileOptionsKey(options)}`;
```

### 5.4 响应头

```http
X-Content-Renderer: legacy | reactive | reactive-fallback
```

## 6. 失败处理

| 触发 | 行为 | 用户看到 |
|------|------|----------|
| `ok: false` | 切旧渲染器 + 日志 + 响应头 `reactive-fallback` | 旧渲染器结果 |
| warning 含 `local.html` / `local.component.unknown` | 同上（可在灰度期先只告警） | 旧渲染器结果 |
| 引用数据 5xx 且有静态快照 | 留在新渲染器，嵌入组件显示快照 | 降级卡片 |
| 引用数据 5xx 且无快照 | 该嵌入组件显示 error 态，不整篇回退 | 可重试的失败态 |
| 发了宿主标签但 `hostData` 缺键 / 缺 `hostRenderer` / renderer 抛错 | ReactiveMD 渲染 `local-host-unavailable` 占位；站点同时记一条错误日志（这是站点的 bug，不是文档的 bug） | 一行可见占位 |
| 单篇 override=legacy | 旧渲染器 | 旧渲染器结果 |
| 编译缓存不可用 | 直接编译，记一次 miss | 无感 |

原则：**整篇回退只用于「内容解释不了」**；单个资源失败不能拖垮整篇。

## 7. 验收矩阵

| 面 | 证据 | 通过条件 |
|----|------|----------|
| 存量语料 | `reports/reactive-corpus.md` | 100% 分类；B 类逐类有处置 |
| 渲染主链路 | 单测 + e2e | 预览与阅读同一 hash；五类引用等价 |
| SSR / 无 JS | e2e `javascriptEnabled:false` | 正文、脚注、静态嵌入可见 |
| 主题 / 移动 / 打印 | 人工截图 + e2e 视口 | 暗色跟随；375px 无横向溢出；打印无交互控件 |
| 摘要 / 导出 | 单测 + 人工打开导出件 | 无 `<panel>` / `{{ }}` / 脚注标记泄漏 |
| 外部契约 | API 单测 + 文档守卫 | `format` 字段存在；`content` 仍是源码；bot 文档同步 |
| 性能 | 脚本 | 250k 字符编译 p95、TTFB、路由 JS 体积有基线并在预算内 |
| 安全 | 单测 + 代码审读 | 无 `innerHTML`；HTML flags 全 false；无新 CSP 头 |
| 回滚 | 演练记录 | 单篇与全局各一次，四处一致 |

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

## 9. 待决策（阻塞或影响范围）

1. **软换行**：上游加 `markdownBreaks`（推荐），还是接受 CommonMark 语义并在迁移期
   逐篇修？不做这个决定，存量文章会整体变排版。0.5.2 **尚未提供**这个选项。
2. **外链图片**：继续允许，还是收紧到同源 + 显式 host 白名单？与「跟踪像素」口径相关。
3. **公开文章是否开始被索引**：现在正文是客户端注入、爬虫拿不到；SSR 后会改变这一点。
   `public` 档建议开始索引，`link` / `internal` 维持 noindex（robots 已按白名单）。
4. **嵌套剪贴板**：内联源码 vs 链接 vs 静态快照；本文默认「一层内联，reactive 嵌套改链接」。
5. **依赖来源**：npm 精确版本 `0.5.2`（`next` 渠道）/ git tag / vendor。当前 ReactiveMD
   没有 `dist-library` 产物，部署机需要能跑 `prepack`。
6. **作者工具目录**：上游补公开导出，还是 vendor 源码（见 D5）。这项阻塞 M5。
7. **评论/讨论里的 `[@8位]`**：继续内联「第一段正文」，还是改成链接？本文默认保持不变，
   只保证不把 reactive 源码裸露给评论渲染器。

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
- **锚点被命名空间化**：深链 `#标题` 与作者 `<a id>` 会失效；若要做目录/分享锚点，
  必须先在上游加稳定前缀模式。
- **SSR 编译成本**：`force-dynamic` 下每请求编译会抬 TTFB；必须有缓存与指标。
- **样式全局面**：`print.css` 的 `@page` 会改全站打印；`.md-document` 自带 `<article>`
  需要容器与语义调整。
- **对外契约**：spider 的 `content` 被文档承诺为 Markdown；换语言等于换契约，必须
  加 `format` 并公告，不能悄悄改。
- **回滚不是「留着旧代码」**：没有逐篇标记和可观测性，就不知道线上哪篇在用哪个渲染器，
  回滚只能靠猜。
- **包与运行时**：ESM-only、Node >= 22.12（本站 `engines` 写的是 >= 20）、
  `dist-library` 未构建。0.5.2 在 `next` 渠道（`latest` 仍是 0.4.0），安装时必须写
  精确版本或 tag，不能用 `npm install reactive-md@latest`。部署机与 CI 都要先验证。
