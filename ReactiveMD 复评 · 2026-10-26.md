# ReactiveMD 复评（v0.5.3）：接入本站博客 / 云剪贴板

> 评估对象：<https://github.com/yao1145/ReactiveMD> —— tag `v0.5.3`，commit `750f057`，npm `reactive-md@0.5.3`，MIT
> 上一版报告：`ReactiveMD 接入评估 · 2026-10-22.md`（针对 v0.3.0 / `f479b22`）
> 评估范围：本站（raricy.com，Next.js 15.5.27 / React 19 / Prisma / SQLite）博客正文与云剪贴板正文
> 方法：重新克隆 0.5.3、`npm ci` + `npm run build` + 全量单测、在本机真起 Next 15 探针工程验证 RSC/SSR 边界、
> 逐行读 `src/local/html.ts` 净化器、实测编译/容量/体积；本报告数字全部为本机实测
> 日期：2026-10-26

---

## 0. 结论（先看这段）

**结论从「可以接，但只能关在 iframe 里」升级为「可以接，而且可以正式接」——但仍**不建议**把 0.5.3 直接嵌进主文档。**

0.3.0 那一版列的**阻断项已基本清零**：

| 0.3.0 的阻断项 | 0.5.3 现状 |
|---|---|
| `private: true`、未上 npm、git 依赖装完 import 即失败 | **已发布 npm**：0.3.0→0.5.3 共 8 个版本；`private` 已移除；`prepack` 已加 |
| 无 CI / 无 tag / 无 CHANGELOG | **GitHub Actions 双 job**（Node 22.12+24 全量门禁 + Chromium 浏览器门禁）；8 个 tag；中英双份 CHANGELOG + SECURITY + THIRD_PARTY_NOTICES + CONTRIBUTING |
| 无 client 入口，Next 直接引用即 build 崩（`createContext is not a function`） | **仍然如此**（本机实测复现，见 §3.2）——但这是**惯例问题而非缺陷**，加一层 `'use client'` 即可，且它现在自带 `mount()`/custom element 两条非 React 路径 |
| 容量上限 10,000 语法节点，段落密集约 50–60 KB 就失败 | **仍在，但可配**（`limits.maxSyntaxNodes`）；且实测**纯 Markdown 27 KB / 600 小节通过**，上限远没有上版说的那么紧（见 §3.4 修正） |
| 所有交互失效整篇白屏（all-or-nothing） | **已改为分区容错**：局部表达式错误就地显示，其余内容继续更新 |
| 浏览器里一次性 ~68 KB gzip，且无懒加载路径 | **有独立 IIFE 单文件产物**（1.12 MB / 330 KB gzip）可完全甩进 iframe；React 侧仍 ~286 KB gzip（见 §3.3） |

**真正的变化是三件事，且都朝本站有利：**

1. **`reactive-md/editor` 独立成包**（108.6 KB / 29 KB gzip）——创作端可以在本站里给 core+ 用，而不必把
   渲染器塞进正文页。
2. **`dist-standalone` 的 IIFE 单文件 + `mount()` + `<reactive-md-doc>` 自定义元素**，配合
   `hydrate`、`staticFirst`，让「沙箱 iframe 里跑一份完整运行时」从「自己拼」变成「官方支持的用法」。
3. **HTML 路径的隔离是硬编码的**：`allow-same-origin` 在 `sanitizeSandbox()` 里**被无条件剔除**，
   作者永远拿不到宿主同源。这消灭了上版最大的未知项（「开了 HTML 会不会变成同源 XSS」）。

**仍然不建议「直接嵌进主文档」的三个理由（都没变）：**

- 本站**没有任何 CSP**，正文容器里同源执行第三方代码 = 一个库 bug 就是账号接管（读者里有 admin/owner）。
- 正文是 `dangerouslySetInnerHTML` 出来的静态 HTML，**没有 React 挂载点**，白名单**不含 iframe**。
- 一个人、五天、73 个提交 —— 工程成熟度和「能不能长期维护」不成正比。

**推荐路线（较上版简化）：**

1. **P1（仍推荐先做，但成本从 5–8 人日降到 3–5 人日）**：` ```reactive-md ` 围栏 + **沙箱 iframe**，
   用 0.5.3 的**官方 standalone 产物**而不是自己拼三份文件。安全边界与游戏区同款。
2. **P2（新增、且现在才成立）**：**创作端接入** —— 把 `reactive-md/editor` 放进 core+ 的编辑页，
   配合 `reactive-md/authoring`（纯函数、零 React、12 KB gzip）做补全/重命名/格式化。**这一档不增加任何正文安全面**。
3. **P3（仍不建议）**：整篇替换现有渲染管线。

一句话给朋友：**这一版可以拿去谈了。请把 `latest` 指到稳定版、补一份「在 Next.js 里怎么用」的最小例子，其余都在往对的方向走。**

---

## 1. 事实卡（v0.5.3）

| 项 | 事实 |
|---|---|
| 版本/渠道 | `reactive-md@0.5.3`；npm `dist-tags`：`latest = 0.4.0`、`next = 0.5.3`（**注意：`latest` 落后一个次版本**） |
| 发布节奏 | 首版 2026-10-22 → 0.5.3 2026-10-26。8 个 tag / 73 个提交 / 单作者 `yaozitao` |
| 入库规模 | **437 个跟踪文件**（0.3.0 时 78）；`dist` 仍不入库（由 `prepack` 构建） |
| 入口 | `.`、`./react`、`./react/unstyled`、`./editor`、`./authoring`、`./styles.css`、`./screen.css`、`./print.css`、`./editor/styles.css` |
| 渲染 | 仍是纯 React 元素渲染。`dangerouslySetInnerHTML` **全仓 0 处**；HTML 模式走 `parse5` + 自研净化器 + `srcdoc` |
| HTML 能力 | 三档宿主开关 `enableCss` / `enableJavaScript` / `enableExtendedHtml`，**默认全关**。任一开启 ⇒ 整篇转入原生 HTML 路径（停止解析 Markdown/ReactiveMD），在 `sandbox` iframe 里渲染 |
| 默认 P0 HTML | `<div>/<span>/<details>/<code>/<pre>` 等 P0 标签在**默认路径**就支持（走 React 元素，不建绑定）；`onclick`/`style`/`script`/`iframe` 一律降级为字面源码并报警告 |
| 表达式 | 仍是显式 AST 解释器，无 `eval`/`Function`/全局/属性访问；拒绝 `.` 与 `=` |
| 预算 | 文档 1,000,000 字符；**语法节点 10,000（可按次编译上调）**；字符串 100,000；数组 10,000；绘图 16 曲线 / 20,000 点 / 2,000,000 步；宿主组件 32 个 |
| 体积（实测） | core `36.4 KB` + `runtime 15.0` + `authoring 21.0` KB raw；**React 渲染器 386.1 KB / 108.2 KB gzip**；**compiler 702.6 KB / 177.6 KB gzip**；CSS 75.3 KB / 12.4 KB；editor 108.6 KB / 29.1 KB；**standalone IIFE 1,119.4 KB / 330.0 KB gzip** |
| 测试 | **82 文件 / 1022 用例全绿**（44 s；本机默认 5 s 超时下 2 条会超时，`--testTimeout=60000` 全过 —— 是机器慢，不是回归） |
| SSR | 本机实测 `<LocalReactiveDocument>` **`renderToString` 直接成功**（976 字节静态 HTML，含 `id` 锚点与初始值） |
| Next 边界 | **RSC 直接引用仍然 build 失败**（`TypeError: (0, ir.createContext) is not a function`）；`'use client'` 包装后正常，产物 `247 kB` / First Load `349 kB` |
| 许可 | MIT；`THIRD_PARTY_NOTICES.md` 93 KB 自动生成，CI 里 `npm run notices && git diff --exit-code` 守着 |

---

## 2. 与 v0.3.0 的关键差异（按对本站的影响排序）

### 2.1 安全模型：从「没有 HTML」到「HTML 有，但硬隔离」

这是最需要重写结论的一条。

- **0.3.0**：`local.html` 直接报错，原始 HTML 根本不进渲染 —— 所以「无注入面」是**结构性**保证。
- **0.5.3**：HTML 进来了，但分成两层：
  - **默认路径（P0）**：仍是 React 元素。`safeHtmlProps()` 只放行 `title`/`lang`/`dir`/`aria-*`/`data-*`，
    **`class`/`style`/URL/事件钩子一律不进 DOM**（`LocalDocumentView.tsx:918`、`:927-957`）。
    `style` 属性、`onclick`、`<script>`、`<iframe>` 实测全部降级为 `fallback` 字面源码。
  - **原生 HTML 路径（需宿主开开关）**：`parse5` 解析 → 白名单净化 → `srcDoc` 注入 iframe，
    且 `localHtmlSandbox()` 只会产出 `allow-scripts` / `allow-forms`，**`allow-same-origin`
    在 `sanitizeSandbox()` 里被显式 `return false` 剔除**（`html.ts:265-281`）。
    连嵌套 `<iframe srcdoc>` 也有 `MAX_HTML_SRCDOC_DEPTH = 4` 的递归净化。

**对本站的含义**：即使将来要开 `enableCss`/`enableJavaScript`，作者代码也跑在不带 `allow-same-origin`
的 iframe 里 —— **拿不到本站的 cookie、localStorage、同源 DOM**。上版「开 HTML 会不会变成同源 XSS」
这个未知项可以划掉。

⚠️ **但不要因此就开 `enableJavaScript`**。理由与库无关：本站**没有 CSP**，而开了 JS 的作者文档
在 iframe 内部仍然可以 `fetch` 同源地址（iframe 的 origin 是 opaque，`connect-src` 得靠**我们自己的
route handler 发 CSP 头**来关掉）。也就是说：**隔离的上半场由库保证，下半场必须由本站的 CSP 头保证**，
两边都得做。P1 建议**只开 P0**，不开三个开关中的任何一个。

### 2.2 分发与工程成熟度：从「不可用」到「正常开源项目」

- 已上 npm 且有完整元数据（`repository`/`homepage`/`bugs`/`engines`/`exports`/`bin`/`sideEffects`）。
- GitHub Actions 两个 job：Node 22.12 + 24 矩阵跑 `verify:release:node`，Chromium 跑 `verify:release:browser`；
  还会把 benchmark 与 release-verification 作为 artifact 上传。
- `prepack` 保证发包前一定构建 + 重算第三方声明；CI 里用 `git diff --exit-code` 卡住声明漂移。
- 8 个 tag 一一对应 8 个 npm 版本。
- 文档 22 份 × 中英双语（含 `compatibility`、`performance`、`html-compatibility`、`theme-protocol`、
  `source-versioning`），并附「可复制的最小集成例子」`examples/integration/`。

⚠️ **仍需注意**：`latest` 指到 `0.4.0` 而不是 `0.5.3`。本站接入必须**写死版本**（`0.5.3`），
不要用 `^0.5.0`、更不要用 `latest`。

### 2.3 容错：从「整篇白屏」到「分区降级」

0.3.0 里任何一个表达式错误 = 整篇只剩诊断面板。0.5.3 明确改为：编译失败时显示诊断；
**运行期局部计算错误只在对应内容附近显示，其余内容继续更新**。
对博客这种「读者不该看到白屏」的场景，这是必需项。

### 2.4 创作端：这次才第一次「可以接」

- `reactive-md/editor`：受控 React 组件，含高亮、格式化/插入工具栏、补全、绑定导航、重命名、撤销、
  行号、滚动同步、Edit/Split/Preview 三视图、底部字数与键盘提示。**不含 CSS 导入**（另有
  `./editor/styles.css`），因此可被 tree-shake、也可 SSR。
- `reactive-md/authoring`：**纯函数、零 React**，`analyzeLocalSource` / `completeLocalSource` /
  `renameLocalBinding` / `formatLocalSource`，且**接受与预览相同的 `LocalCompileOptions`**
  —— 意味着「编辑时看到的能力」和「渲染时用的能力」可以是同一份配置，不会漂。

---

## 3. 实测数据

### 3.1 构建与测试

```
npm ci                      → 169 packages，19 s
npm run build               → 成功（lib 428 ms + editor 160 ms + standalone 444 ms + 59 份 d.ts）
npm test（默认超时）        → 80 passed / 2 failed（均为 5 s 超时）
npm test（--testTimeout=60s）→ 82 files / 1022 tests 全绿，44.6 s
```

**判定：无真实失败。** 未构建时那 17 个失败全部是「`dist-library` 不存在」，构建后只剩 2 条超时，
放宽后通过 —— 是 Vite 7/8 + 82 个 worker 在本机冷启动的开销，不是代码问题。

### 3.2 Next.js 集成边界（本机真机验证）

在干净的 Next 15.5.7 + React 19.3 工程里：

| 写法 | 结果 |
|---|---|
| `import { LocalReactiveDocument } from 'reactive-md/react'` 直接放进 Server Component | **build 失败**：`TypeError: (0, ir.createContext) is not a function`（`Failed to collect page data for /rsc`） |
| 加一层自己的 `'use client'` 包装组件 | **build 成功**，`/wrapped` = `247 kB`，First Load JS `349 kB` |
| `renderToString(<LocalReactiveDocument source=… />)` | **成功**，输出含 `id="local-heading-…"`、`data-render-mode="interactive"` 与初始值 |
| 产物里是否有 `'use client'` 指令 | **0 处**（`dist-library/*.js` 全无） |

**结论**：与 0.3.0 完全一致 —— **本站必须自己写 `'use client'` 包装层**。这一条不是缺陷
（很多 React 库都这么设计，库本身要同时服务 Node 端编译与浏览器端渲染），但必须在接入文档里写明，
否则下一个人一定会踩。

### 3.3 体积（本机 gzip 实测）

| 产物 | raw | gzip |
|---|---|---|
| `compiler-*.js` | 702.6 KB | **177.6 KB** |
| `react-*.js` | 386.1 KB | **108.2 KB** |
| `runtime-*.js` | 15.0 KB | 4.5 KB |
| `reactive-md.js`（core 入口） | 36.4 KB | 11.2 KB |
| `reactive-md-authoring.js` | 39.4 KB | 12.0 KB |
| `reactive-md.css` | 75.3 KB | 12.4 KB |
| `reactive-md-print.css` | 8.6 KB | 2.4 KB |
| `reactive-md-editor.js` | 108.6 KB | 29.1 KB |
| `reactive-md-editor.css` | 41.4 KB | 6.8 KB |
| **`dist-standalone` IIFE** | 1,119.4 KB | **330.0 KB** |

**关键变化**：0.3.0 时「core + React 渲染器」约 79 + 28 = **107 KB gzip**；现在编译器被独立成
`compiler` chunk（177.6 KB gzip），所以**在浏览器里走 React 路径的实际代价约 286 KB gzip**
（compiler + react），比上版翻了一倍多。

⚠️ **反向收益**：现在有 **standalone IIFE（330 KB gzip）**。如果采用「沙箱 iframe」方案，
这 330 KB 是**在 iframe 内、且只在读者真打开交互文档时才加载**，完全不进博客页主包 ——
比把 286 KB 塞进正文页更好。这也是 P1 推荐 standalone 而非 React 路径的量化理由。

### 3.4 容量（修正上版的悲观结论）

上版说「段落密集正文约 50–60 KB 就编译失败」。这次重新实测（每次独立进程，避免抖动）：

| 场景 | 大小 | 结果 |
|---|---|---|
| 纯 Markdown 正文（600 小节 + 粗体/链接） | 26.9 KB | **通过**，compile 190 ms |
| 真实博客体量（40 小节 + 1 个交互块） | 2.9 KB | 通过，compile 61 ms |
| 1,200 个 `<panel>` | 146.8 KB | 通过 |
| 1,300 个 `<panel>` | 159.4 KB | **失败** `local.budget`（line 4881） |

**修正**：10,000 语法节点的实际容量取决于**组件密度**。纯 Markdown 能到 ~27 KB+ 没问题；
上版「50–60 KB 就挂」的描述偏严，真实瓶颈是**交互组件数量**（~1,200 个 panel 上限）。
对博客场景：**一篇 27 KB 的普通文章完全没问题，一个页面上放几十个交互块也没问题**。
另外 `limits.maxSyntaxNodes` 现在**可以按次编译上调**（实测 25 个用例覆盖「上调不影响后续调用」）。

### 3.5 性能

| 场景 | 实测 |
|---|---|
| 50 个 panel（5.9 KB） | compile 71.6 ms |
| 200 个 panel（24.0 KB） | compile 137.1 ms |
| 800 个 panel（97.2 KB） | compile 368.3 ms |
| 1,200 个 panel（146.8 KB） | compile 486.6 ms |
| 每次交互提交（1,200 参数） | 1.26 ms/op |

**提醒**：编译是**同步**的，且 100 KB 级别要 0.4–0.5 s。放在正文页会**阻塞主线程**。
这是 P1 用 iframe 的第二个理由（iframe 内阻塞不影响主页面）；如果坚持走 React 路径，
必须把它放进 `Worker`（库里有 `src/local/worker.ts`，但 `'unsafe-inline'` 的 CSP 下
blob worker 会被拦，需要额外开 `worker-src blob:`）。

---

## 4. 四条接入路线（复评后）

| 方案 | 做法 | 成本 | 安全边界 | 评价 |
|---|---|---|---|---|
| **A. React 直接进正文** | `'use client'` 包装 + `LocalReactiveDocument` | 1–2 人日 | ❌ 同源执行；无 CSP；286 KB gzip 进主包；同步编译阻塞主线程 | **仍然否决**（同比上版） |
| **B. ` ```reactive-md ` 围栏 + 沙箱 iframe**（推荐） | 围栏内容 → `route.ts` 返回 standalone IIFE 文档 → `sandbox="allow-scripts"` + CSP | **3–5 人日**（原估 5–8，因有官方 standalone 产物而下降） | ✅ opaque origin；`connect-src 'none'`；与 `/game/quandi/play` 同款 | **推荐 P1** |
| **C. 独立「交互文档」格式** | 新增 `format` 列 + 独立编辑页 + 详情页 | 10–15 人日 | ✅ 可复用 B 的沙箱 | 视产品需求；B 跑通后再评估 |
| **D. 只有创作端**（新增） | `reactive-md/editor` + `authoring` 进 core+ 编辑页，产出仍是 B 的围栏 | 2–3 人日 | ✅ 不碰正文渲染 | **可与 B 并行，且零风险** |

### 4.1 为什么 B 现在明显更好做了

0.3.0 时需要自己拼「core + react + css」三份产物进 iframe；0.5.3 直接给：

- **`dist-standalone/reactive-md-standalone.js`**：IIFE，自带 React 19，`file://` 都能跑；
- **`mount(element, { source, … })`** 与 **`<reactive-md-doc>`** 两个显式入口；
- **`<script type="application/reactive-md+json" data-reactive-md-auto>`** payload 形式，自动挂载一次；
- **`hydrate` / `staticFirst`**：先静态内容、后增强为控件；
- payload 解析器对 target 用 `getElementById` + `^[A-Za-z][A-Za-z0-9_-]*$`（**不接受选择器**），
  图片只收 `data:image/(png|jpeg|gif|webp);base64` 且总预算 40 MiB；`MAX_IMAGES = 64`。

### 4.2 B 的落地要点（不变量清单）

1. **不落库**：围栏原文就在 `Blog.content` / 剪贴板正文里，零 schema 变更。
2. **白名单不动**：围栏在 `marked` 里就是 `<code class="language-reactive-md">`；**在净化之后**
   由 `blog-content-dom.ts` 的 `enhanceBlogContent()` 用 DOM API 换成 iframe
   （白名单不含 iframe，所以只能在净化后插入 —— 与图床图、表情包同一手法）。
3. **外部视图保持零请求**：`contentRefs === 'external'` 时**不插 iframe**，只渲染一个「交互文档」
   占位（点开才进 `route.ts`）。否则本站在对外视图「零客户端请求」的既有承诺会破。
4. **excerpt 天然干净**：`src/lib/blog-excerpt.ts` 的 `stripFencedCode()` 会整段剥掉围栏，
   首页卡片不会漏出源码。**这一条已核实**，无需改动。
5. **CSP 必须由我们发**：`route.ts` 参照 `src/app/game/quandi/play/route.ts`，但把
   `script-src 'self' 'unsafe-inline'` 收窄成 `script-src 'unsafe-inline'`（我们是内联 bundle），
   并保留 `default-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。
6. **route handler 绕过 root layout**：所以没有 Navbar/Footer/`FrameBuster` —— 与游戏页同理。
7. **只开 P0**：`compileOptions` 三个开关**全部保持 false**。这样即使未来库有净化器漏洞，
   受影响面也只是 P0 标签，而不是任意 CSS/JS。

### 4.3 仍然存在的能力取舍（必须让站长知道）

- **围栏内是「孤岛」**：`` `[@…]` `` 引用、站内图片/音频/表情、投票组件**都不会展开**。
  这是「围栏 = 字面量」的必然结果，不是 bug。
- **`/blog` 的导出/分享**：现有 `stripInteractiveShells()` 会移除 `.copy-btn`；接入后需要确认
  导出的 HTML 里 iframe 是被移除还是保留占位（建议**移除占位**，导出为纯静态说明）。
- **gzip 体积**：330 KB 只在该篇博客真被展开交互时才拉取；首屏不付这个钱。

---

## 5. 建议给朋友的前置清单（较上版大幅缩短）

按「不改也能接，但改了更好」排序：

1. **把 `latest` 指向稳定版本**（现在 `latest = 0.4.0`，`next = 0.5.3`）。否则所有 `npm install reactive-md`
   的人拿到的都是旧版。
2. **在 README 顶部加一节「Next.js App Router」**：三行示例 + 一句「本包不含 `'use client'`，请自行包装」。
   这是最高频的踩坑点，本机已复现。
3. **给 `dist-standalone` 一份「宿主 CSP 推荐值」**。文档里说了「受 CSP 限制」，但没给出可直接抄的头。
   本站是按 `/game/quandi/play` 的模板推的，别人也得推一遍。
4. **补一句 `maxSyntaxNodes` 的实用建议**：现在是「可配」，但没说「配到多少会明显卡」。
   实测 1,200 panel / 150 KB 是可用边界。
5. **（可选）把 compiler 拆成可懒加载**：177.6 KB gzip 的 compiler 如果能在「进入文档区域时再加载」，
   React 路径的体积表现会好很多。
6. **（可选）`examples/integration/` 里加一个 Next 例子**：现在有 `index.mjs` / `main.jsx` / `react-editor.tsx`，
   但没有 Next。

---

## 6. 风险登记（更新）

| # | 风险 | 0.3.0 判定 | 0.5.3 判定 | 变化 |
|---|---|---|---|---|
| R1 | 未发布/无 CI/无法长期依赖 | 高 | **低** | ✅ 已解决 |
| R2 | 无 CSP 下同源执行第三方代码 | 高 | **中**（P1 沙箱后降到低） | ✅ 有隔离方案 |
| R3 | 开 HTML 后同源 XSS | （不存在） | **低**（`allow-same-origin` 硬剔除） | ✅ 新增但已隔离 |
| R4 | 正文无 React 挂载点 | 高 | 高 | ➖ 不变（本站结构） |
| R5 | 正文白名单不含 iframe | 中 | 中 | ➖ 不变（净化后插 DOM） |
| R6 | 语法节点上限导致长文失败 | 中 | **低**（可配；纯 MD 27 KB 通过） | ✅ 缓解 |
| R7 | 包体积（286 KB gzip）进主包 | 中 | 中（standalone 路径下归零） | ✅ 有替代路径 |
| R8 | 同步编译阻塞主线程 | 中 | 中（沙箱后不影响主页） | ✅ 有替代路径 |
| R9 | 单人维护 / 5 天 73 提交 | 高 | **中高** | ⚠️ 仍是最实在的风险 |
| R10 | all-or-nothing 白屏 | 中 | **低**（已分区容错） | ✅ 已解决 |
| R11 | `latest` 滞后于 `next` | （N/A） | 中 | ⚠️ 需写死版本 |

**R9 是唯一没有改善、也不大可能靠代码改善的一条。** 建议在 P1 落地时同步做一件事：
把「接缝」保持在一处（一个 `ReactiveDocFrame` 组件 + 一个 `route.ts`），
这样万一将来要换库或自己 fork，改动面是 2 个文件而不是散落各处。

---

## 7. 待站长拍板

1. **先做 B（正文围栏）还是先做 D（创作端）？** 我建议 **D 先做**（2–3 人日、零风险、
   立刻能让 core+ 写出带交互的文档），用 D 产出的内容喂 B，B 上线时就有现成内容。
2. **对外视图怎么处理**：交互文档在 `link`/`public` 档下是「渲染成静态占位」还是「也允许 iframe」
   （后者会破「外部读者零客户端请求」的既有承诺）。
3. **要不要开 `enableCss`**：开了排版自由度高很多，但仍建议 P1 阶段只开 P0。
4. **谁维护接缝**：R9 是真实风险，需要有一个人认领「库升级后跑一遍」的职责。

---

## 8. 证据索引

| 结论 | 证据 |
|---|---|
| 已发布 npm、`latest` 滞后 | `curl https://registry.npmjs.org/reactive-md` → 200，`dist-tags.latest = 0.4.0`、`next = 0.5.3` |
| CI 存在 | `.github/workflows/ci.yml`（node-version 矩阵 22.12/24 + Chromium job） |
| 8 个 tag | `git tag` → v0.3.0…v0.5.3 |
| 1022 用例全绿 | `npx vitest run --testTimeout=60000` → `82 passed / 1022 passed` |
| RSC 直接引用失败 | Next 15.5.7 探针 build → `TypeError: (0, ir.createContext) is not a function` |
| `'use client'` 后成功 | 同探针 build → `/wrapped 247 kB / First Load 349 kB` |
| SSR 成功 | `renderToString` → 976 字节，含 `local-heading-…` 与初始值 |
| 产物无 `'use client'` | `Select-String dist-library/*.js "use client"` → 0 命中 |
| `allow-same-origin` 硬剔除 | `src/local/html.ts:265-281` `sanitizeSandbox()` |
| HTML iframe sandbox 取值 | `src/local/html.ts:257-263` `localHtmlSandbox()` → 仅 `allow-scripts`/`allow-forms` |
| P0 属性白名单 | `src/local/LocalDocumentView.tsx:918` `SAFE_HTML_ATTRIBUTE = /^(?:aria\|data)-…/` |
| 无 `dangerouslySetInnerHTML` | 全 `src/` grep → 0 处（唯一相关是 `srcDoc={result.markup}`，`LocalDocumentView.tsx:4498`） |
| URL 协议硬拦在前 | `src/local/LocalDocumentView.tsx` `safeUrl()`：`javascript:`/`vbscript:`/`data:`(非图片) 先拒，再问宿主管策略 |
| 链接外部加固 | `LocalDocumentView.tsx:1318-1319` `target="_blank"` + `rel="noopener noreferrer"`（仅 `https?:`） |
| 无存储访问 | `src/` grep `localStorage\|sessionStorage\|document.cookie\|indexedDB` → 0 处 |
| standalone API | `src/standalone/index.tsx` → `mount`/`mountAll`/`<reactive-md-doc>`/`parseMountPayload` |
| payload 约束 | `src/standalone/payload.ts` → target 正则、`MAX_IMAGES = 64`、40 MiB 预算、仅 raster data URL |
| 节点上限可配 | `src/local/limits.ts` 注释 + `tests/local-compile-options.test.ts`（25 用例） |
| 容量实测 | 1,200 panel 通过 / 1,300 失败 `local.budget`；纯 MD 26.9 KB 通过 |
| 体积实测 | `npm run build` 输出（见 §3.3 表） |
| 本站围栏会被摘掉 | `src/lib/blog-excerpt.ts:44` `stripFencedCode()` |
| 本站净化后钩子 | `src/lib/blog-content-dom.ts:119` `enhanceBlogContent()` |
| 游戏区 CSP 模板 | `src/app/game/quandi/play/route.ts` `Content-Security-Policy` |
| 本站 Next/React | `package.json` → `next ^15.5.27`、`react ^19.0.0` |

---

## 9. 与 2026-10-22 报告的差异对照（速查）

| 主题 | 10-22 报告 | 本报告 |
|---|---|---|
| 总判定 | 可以接，但只能关在 iframe | **可以正式接；仍不建议嵌进主文档** |
| P1 成本 | 5–8 人日 | **3–5 人日**（有官方 standalone 产物） |
| 新增档位 | — | **D：创作端接入（2–3 人日，零风险）** |
| 浏览器体积 | 107 KB gzip | **286 KB gzip**（React 路径）/ **330 KB gzip**（standalone，隔离在 iframe） |
| 容量 | 「50–60 KB 就失败」 | **修正**：纯 MD 27 KB 通过；瓶颈是组件数（~1,200） |
| HTML | 不支持 | **支持，但 `allow-same-origin` 硬剔除** |
| 白屏 | all-or-nothing | **已分区容错** |
| 测试 | 165 用例 | **1022 用例** |
| 工程 | private / 无 CI / 无 tag | **npm 已发布 / CI 双 job / 8 tag** |
| 最实在的风险 | 工程成熟度 | **仍是工程成熟度（R9）** |
