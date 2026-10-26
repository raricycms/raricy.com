# ReactiveMD 接入本站博客 / 云剪贴板：评估报告

> ⚠️ **本报告针对 v0.3.0，已被 `ReactiveMD 复评 · 2026-10-26.md`（v0.5.3）取代。**
> 结论的**大方向仍然成立**（走沙箱 iframe，不要嵌进主文档），但事实卡、体积、容量、
> HTML 支持与工程成熟度多项已过时 —— 以复评版为准，本报告仅作差异对照留档。

> 评估对象：<https://github.com/yao1145/ReactiveMD>（commit `f479b22`，v0.3.0，MIT）
> 评估范围：本站（raricy.com，Next.js 15 / React 19 / Prisma）博客正文与云剪贴板正文
> 方法：通读两个仓库源码 + 实测构建/编译/SSR + 逐条核对本站守卫与 e2e；本报告所有数字均为本机实测
> 日期：2026-10-22

---

## 0. 结论（先看这段）

**可以接，但不建议「现在、原生、直接接进主文档」。**

- **ReactiveMD 的表达式层是可信的**：显式 AST 解释器，无 `eval`/`Function`/属性访问/宿主全局，
  无 HTML 字符串注入，URL 协议硬拦，图片默认不加载，资源预算齐全，安全测试密度高于项目年龄。
  实测 `globalThis` / `window` / `fetch` / `document.cookie` / `constructor` 全部不可达。
- **真正的风险不在表达式，而在组合**：把一个**两天前发布、单人维护、未上 npm、无 CI** 的第三方
  渲染器放进本站主文档执行，而本站**没有任何 CSP**、会话是 httpOnly cookie、文章读者里有 admin /
  owner。渲染器将来任何一个 bug 都等于同源 XSS。这个风险量与「表达式能不能逃逸」无关。
- **本站侧还有两个硬约束**：正文是 `dangerouslySetInnerHTML` 出来的**静态 HTML，没有任何 React
  挂载点**；正文白名单**不含 iframe**。
- **推荐路线**：分三期。
  1. **P1（建议现在做，5–8 人日）**：` ```reactive-md ` 围栏 + **沙箱 iframe** 渲染。
     零落库、零白名单改动、零 token 语法改动、零 bot 契约改动，安全边界与游戏区同款
     （`route.ts` + `CSP: sandbox allow-scripts; connect-src 'none'` + postMessage）。
  2. **P2（视需求，10–15 人日）**：新增「交互文档」整篇格式（`format` 列），接受
     「ReactiveMD 文档 = 独立格式，不用站内既有能力」的产品取舍。
  3. **P3（不建议）**：整篇替换现有渲染管线。

一句话给朋友：**项目方向对、安全底子好，但先补齐「发布 + CI + client 入口 + 容错」再谈生产接入；
本站这边先按隔离方式接，把风险关在 iframe 里。**

---

## 1. ReactiveMD 是什么（事实卡）

| 项 | 事实 |
|---|---|
| 形态 | Markdown 方言 + React 渲染器：HTML 风格组件（33 个）、`bind` 参数、`{{ 表达式 }}`、LaTeX 绘图 |
| 入口 | `reactive-md`（`compileLocal` / `createLocalRuntime`，**不依赖 React**）、`reactive-md/react`（`LocalReactiveDocument` / `LocalDocumentView`）、`reactive-md/styles.css` |
| 渲染 | 纯 React 元素（`createElement`/JSX），全仓 `dangerouslySetInnerHTML` / `innerHTML` = 0；数学是自研 LaTeX→MathML |
| Markdown | remark-parse + remark-gfm；支持表格/任务列表/删除线/autolink；**拒绝原始 HTML**；脚注、引用式链接**静默丢弃**；标题无锚点；代码无高亮 |
| 表达式 | 显式 AST 解释器；无 eval/Function/全局/属性访问；20 个纯函数 + pi/e；仅 string/number/boolean/null/string[] |
| 预算 | 文档 1,000,000 字符；语法节点 10,000；表达式 4,000 字符 / 2,000 AST / 10,000 步；绘图 16 曲线 / 20,000 采样点 / 2,000,000 步 |
| 体积 | dist 约 **303.7 KB raw / 79.0 KB gzip**（core）+ **108.5 KB / 28.2 KB**（React 渲染器）+ **28.1 KB / 5.9 KB**（CSS）；单入口按需 `await import()` 可切 |
| 性能 | 典型小文档 compile ~10 ms；18 KB / 100 面板 warm 30 ms（**冷启动首次 ~0.5 s**）；800 控件每次交互 ~0.4 s 全篇重渲染 |
| 容量 | 容器上限是 **10,000 语法节点**，不是 1 MB：**段落密集正文约 50–60 KB 就编译失败**（远早于本站博客 250 KB 上限） |
| 工程 | `private: true`、**未发布 npm**、dist 不入库、无 `prepare`、git 依赖装完 import 失败；无 CI / 无 tag / 无 CHANGELOG；7 次提交、单作者、2 天历史、0 star |
| 测试 | 13 文件 165 用例全绿（13.7 s），安全相关 4 个文件 + hardening 2 个；demo 另 15 个 |
| SSR | 加 `'use client'` 后 SSR 可确定渲染（实测 build 通过、静态 HTML 含初始值、jsdom hydrate 0 mismatch）；不加则 Next build 失败（`createContext is not a function`） |
| 许可 | MIT（Copyright 2026 yaozitao）；依赖 remark/unified 均 MIT；vendor 需保留 LICENSE |

---

## 2. 本站现状：接入点与硬约束

### 2.1 两条目标管线（博客 / 云剪贴板）

```
MarkdownRenderer.tsx（客户端）
  → content-ref-processor.ts（源文 `[@…]` 预处理、盖码、三重预算）
  → blog-renderer.ts（protectMath → marked+hljs → restoreMath → DOMPurify）
  → dangerouslySetInnerHTML
  → blog-content-dom.ts（挂载后：复制按钮 / 外链加固 / 图片放大 / 投票小组件 / MathJax）
```

- 正文 HTML **全部在客户端生成**，首屏只有 spinner；页面 `force-dynamic`，无 ISR、无正文缓存。
- `blog-renderer.ts` 是「整篇 Markdown → 安全 HTML 的**唯一实现**」；编辑器的**预览与导出**
  都复用它（`MarkdownEditor.tsx`、`markdown-editor/export.ts`），共 3 个调用点。
- `blog-content-dom.ts` 是唯一的「挂载后」钩子，`interactive` 是正文/预览的唯一分叉。

### 2.2 接入必须过的约束（逐条都写在代码/文档里）

| 约束 | 事实 | 对 ReactiveMD 的含义 |
|---|---|---|
| 无 React 挂载点 | 正文是 sanitized HTML 字符串 | 原生渲染必须自己 `createRoot`（生命周期/清理/重渲染都要管）或换成整篇格式 |
| 白名单无 iframe | `blog-markdown.ts` 刻意不含 iframe/script/style/svg/form | 要嵌 iframe 只能在**净化之后**用 DOM API 自己建（投票/图床/音频同款模式） |
| `ALLOW_DATA_ATTR: false` | 任意 `data-*` 被 DOMPurify **静默剥掉** | 新占位符必须显式加进 `ALLOWED_ATTR`，漏了不报错 |
| 对外视图零请求 | `contentRefs='external'` 一个请求都不发 | 交互块在匿名读者页不能取数（ReactiveMD 本身零请求，天然满足） |
| 三档可见性 + 两档剪贴板 | 博客 `internal/link/public`；剪贴板 `publicity` 布尔、**详情页 core+** | 交互文档给谁看、用哪条读口，必须先定 |
| 会话与 CSRF | httpOnly cookie、`SameSite=Lax`；写请求校验 Origin/Referer | 主文档里的同源脚本 = 拿到完整会话（CSRF 对它无效） |
| 无 CSP | 全站刻意没有 CSP/X-Frame-Options（允许被第三方 iframe 嵌入） | 没有响应头兜底；同源 XSS 只能靠「不引入可执行第三方代码」防 |
| 守护测试 | `blog-markdown` / `blog-renderer` / `blog-ref-render` / `editor` / `editor-hardening` / `anonymous-read-guard` / `blog-auth` / `css-tsx-classes` / `docs-catalog` | 新增语法/接口/样式/文档都会撞红，必须同步 |

### 2.3 已有的「正文内交互」先例

| 先例 | 隔离级别 | 模式 |
|---|---|---|
| 投票小组件 | 0（同源同文档） | 源文只留占位 + `data-vote-id`，挂载后纯 DOM 构造；**用户只能给 id，组件由我们写死** |
| 图床 / 音频 / 表情 / 名片 | 0 | 同上，token 由我们拼 URL，用户写不出外链 |
| 游戏区（`/game/*`） | **真隔离** | **route handler 返回独立 HTML + `CSP: sandbox allow-scripts; connect-src 'none'`** + MessagePort 票据；不经过 root layout |

最后一行是本次接入最值得复用的模式：route handler 不经过 root layout（Navbar/Footer/FrameBuster
都不会进 iframe），CSP sandbox 让文档拿到**不透明来源**——即使渲染器被攻破，也读不到本站 cookie、
碰不到父页 DOM、且 `connect-src 'none'` 连网络请求都发不出去。

---

## 3. 安全评估

### 3.1 可信的部分（ReactiveMD 自身，实测）

- 表达式词法直接拒绝 `.`（属性访问）与 `=`（赋值）；`[]`、`{}`、正则、模板串、`new`、箭头函数、
  `import` 全部编译期报错；引用只从文档 bindings 读且 `hasOwnProperty`。
- `javascript:` / `data:` / `vbscript:` / `blob:` 即使 `urlPolicy` 返回 true 也拒绝；链接默认
  http(s)/mailto/tel，外链加 `rel="noopener noreferrer"`；图片默认**一律不加载**。
- 无用户函数/循环/递归；表达式、绘图、LaTeX、文档、数组、字符串、诊断全部有预算。
- 卸载会清理订阅与定时器；React 渲染天然没有 HTML 注入面。

### 3.2 不可信/需宿主兜底的部分

1. **第三方代码在主文档执行**：本站无 CSP，一旦渲染器出现 DOM/URL 相关漏洞，同源脚本可直接
   读 cookie（httpOnly 防读，但可用会话发请求）、以读者身份写库、针对 admin。沙箱 iframe 是唯一
   能把这条风险压到接近零的方案。
2. **图片网络副作用**：`urlPolicy` 一旦放行，读者浏览器会自动请求图片（文档自己承认同源请求仍带
   Cookie）。本站的既有口径是「正文不许外链图」（跟踪像素 / 访客 IP 泄露），所以 policy 必须只
   白名单 `/api/images/<id>/raw` 一类站内读口，且**不能**放行任意 http(s)。
3. **all-or-nothing 与静默丢内容**：一个未知标签或原始 HTML 会让整篇变成诊断面板；脚注、引用式链接
   直接消失且无诊断。作者会困惑，读者会看到「坏掉的文档」。
4. **容量与 CPU 放大**：10,000 节点上限（≈50–60 KB 密集正文）；1 MB 文档编译 0.4–1.8 s；
   800 控件每次交互 ~0.4 s 全篇重渲染。公开页逐请求编译 = 现成的 DoS 面。
5. **供应链**：单人、2 天、无 CI、无发布通道、无安全响应承诺；不能当有 SLA 的依赖。

### 3.3 判定

- 「不可信作者写的 `{{ 表达式 }}` 会不会逃逸」→ **不会（当前版本、实测）**。
- 「能不能把这块代码放进本站主文档跑」→ **不建议**；除非站长明确接受「第三方渲染器 = 同源脚本」
  这个残余风险。
- 「放进 sandbox iframe 跑呢」→ **可以**：攻击面退化为「iframes 内的自我破坏 + 伪造高度消息」，
  拿不到会话、发不出请求。

---

## 4. 四种接入方案对比

| 方案 | 体验 | 安全 | 改动面 | 主要连带影响 | 粗估 | 建议 |
|---|---|---|---|---|---|---|
| **A. 整篇替换**（博客/剪贴板正文全交给 ReactiveMD） | 原生 | **最差**（同源执行） | 巨大 | 丢掉 MathJax / hljs / `[@…]` / 投票 / 图床 / 音频 / 表情 / 名片 / 标题锚点；`[@…]` 与 `{{ }}` 语义冲突；三个 `renderBlogMarkdown` 调用点、导出、缓存、bot 契约全要改 | 数周 | ❌ 不做 |
| **B. 新「整篇格式」**（`format` 列：markdown / reactive，二选一） | 原生 | 同源执行（同 A 的残余风险） | 中（迁移 + 写接口 + 预览 + 导出 + 摘要 + bot 文档） | 一篇文档只能二选一；ReactiveMD 文档里没有站内既有能力；发布前要服务端 compile 校验；大文档要缓存 | 10–15 d | ⏸ 视 P1 反馈 |
| **C1. 块级原生**（` ```reactive-md ` 围栏 + 主文档 `createRoot`） | 混排最好 | 同源执行 | 中（React root 生命周期、重渲染去重、导出、预览、CSS 隔离） | 与 `innerHtml` memo / `enhanceBlogContent` 生命周期耦合，最易出「重渲染后组件消失」这类静默 bug | 5–8 d | ⚠️ 备选 |
| **C2. 块级沙箱**（` ```reactive-md ` 围栏 + sandbox iframe） | 好（iframe 内自成一体） | **最好**（不透明来源 + `connect-src 'none'`） | 中（route handler + 独立 bundle + postMessage 协议 + 高度/主题） | 需要一条独立构建产物（React + 库 ~60–100 KB gzip）；iframe 内排版与站内不完全一致；导出要决定保留还是剥掉 | 5–8 d | ✅ **推荐** |
| **D. 独立文档页**（不接正文，只在 `/reactive/<id>` 打开） | 一般（要点链接） | 好 | 小 | 需要文档实体与可见性策略；博客里只能放链接/卡片 | 2–4 d | 可做 P0 验证需求 |

> 备注：`blogExcerpt`（首页摘要）**本来就会整段丢掉围栏代码块**，所以 C1/C2 不会把
> `{{ }}` / 标签漏进首页卡片；`blog-renderer` 也会把围栏内容作为代码块正常渲染（预览里看得见源文）。
> 这是 C 系方案顺带拿到的两个便宜。

---

## 5. 推荐路线（三期）

### P0（0.5–1 人日，可选）：先验证产品需求
在 `/tool` 下加一个「交互文档」试用页，或在站点内链到朋友已部署的 demo（`yaozi.raricy.com`），
让 2–3 位 core 作者真写一篇。**先确认「有人要写、读者要用」再付集成成本。**

### P1（5–8 人日）：块级沙箱嵌入（推荐）

**作者写法**：正文里一个围栏代码块，源文即文档：

````markdown
```reactive-md
<panel title="费用估算">
<slider bind="people" label="人数" initial="2" min="1" max="20">
</panel>

每月费用：**{{ people * 100 }} 元**。
```
````

> 注意：围栏内是**字面量**——`[@…]` / 图床 / 音频 / 表情 / 投票在文档里都不展开（与代码块同一条
> 纪律，`content-ref-processor` 的盖码在源文阶段就跳过它）。**交互文档是一座孤岛**：这一条要写进
> 作者指南，否则「我写了 `[@8位]` 却没出卡片」会成为第一批投诉。图片只能走 iframe 内的
> `urlPolicy` 白名单（`/api/images/<id>/raw`）。

**实现要点**：
1. `blog-content-dom.ts` 的挂载后钩子里，找 `pre > code.language-reactive-md`，取出
   `textContent`（source），用 DOM API 建 `<iframe sandbox="allow-scripts">`，`postMessage`
   把 source 与主题传进去（用 `data-rendered` 去重，重复调用安全；重渲染时节点整体重建）。
2. 新建 route handler `src/app/embed/reactive/route.ts`，照 `game/quandi/play/route.ts` 的模式：
   返回独立 HTML（**不经过 root layout**，否则 Navbar/FrameBuster 会进 iframe），
   `CSP: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline';
   style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; frame-src 'none'`，
   并加 `X-Robots-Tag: noindex`、`Referrer-Policy: no-referrer`。
3. 客户端 bundle 单独构建到 `public/static/reactive/embed.js`（`scripts/build-reactive-embed.mjs`
   + `npm run build` 钩子，照 `copy-converter-assets.mjs` 的既有做法）；iframe 文档只用这份
   bundle，不引站内其他 JS。
4. 协议：高度（`ResizeObserver` → `postMessage` → 父页设 iframe 高度）、主题（父页 `data-theme`）、
   `urlPolicy` 只放行 `/api/images/<id>/raw` 与 `/api/audio/<id>/raw`（匿名可读的那部分）。
   `connect-src 'none'` 保证文档自己发不出请求。
5. 预览：`MarkdownEditor` 走同一个 `MarkdownRenderer`，自动生效；`interactive=false` 不需要额外处理
   （ReactiveMD 不发业务写请求）。
6. 导出：`markdown-editor/export.ts` 显式决定——建议把围栏替换成「交互文档（在站内打开）」的
   静态说明块，不留在死 iframe。
7. 测试：新增单测（围栏提取/去重/非法源文降级）+ e2e（匿名读者页 iframe 内无 cookie 可读、
   `connect-src` 生效、高度自适应、预览零写请求、导出不含 iframe）。
8. 文档：`docs/guide/内容引用语法指南.md` 同族新增一节；新文档要登记 `src/lib/docs-catalog.ts`。

**为什么这是最小侵入**：不动数据库、不动 `[@…]` 词表、不动 DOMPurify 白名单、不动 bot 契约、
不动 `blog-renderer.ts`；新增面只有「一个后处理钩子 + 一条 embed 路由 + 一份独立 bundle」。

### P2（10–15 人日，视需）：整篇格式
只有当「作者真的要把 ReactiveMD 当主格式写长文、且要原生排版」时才做。前置条件：
库发 npm + 安全评审通过 + 服务端发布前 compile 校验 + 正文 HTML 缓存 + 大小上限（≤50 KB）+
摘要/搜索/bot 契约/导出全部对齐。**P2 的安全模型与 P1 不同（同源执行），需要站长单独拍板。**

### P3（不建议）：整篇替换

---

## 6. 需要朋友先补齐的清单（按优先级）

| # | 事项 | 为什么 |
|---|---|---|
| 1 | **发布到 npm**（0.3.x 起），或至少提交 `dist-library` + 打 tag | 现在 git 依赖装完 import 失败；本站只能 vendor/fork，升级成本全落在我们身上 |
| 2 | 加 `prepare` 构建脚本 | 从 git/目录安装时能自动产出 dist |
| 3 | 加 **CI**（typecheck + test + build + 一个 Next 集成烟测） | 单人 2 天项目，回归全靠 CI 才能当依赖 |
| 4 | 提供 `'use client'` 入口（如 `reactive-md/next`） | 现在直接进 Server Component 会让 Next build 失败 |
| 5 | **容错**：未知标签/原始 HTML 降级为转义文本或行内诊断，而不是整篇失败；脚注/引用式链接至少给诊断 | all-or-nothing + 静默丢内容，作者体验与读者观感都差 |
| 6 | 节点上限可配或提高（或官方给出「≈50 KB 密集正文」的明确限额） | 10,000 节点与 1 MB 声明差距太大 |
| 7 | 提供**发布前校验**入口（服务端 compile + 诊断）与静态快照渲染（`renderToStaticMarkup`） | 公开站要在保存时拦坏文档，并给无 JS 读者一个静态兜底 |
| 8 | 补 `//host` 链接的 `rel`；把图片/链接策略默认值写成文档 | 小洞，但属于安全默认值 |
| 9 | `SECURITY.md` + 版本变更记录 + 固定版本策略 | 我们要按 commit/tag 锁定，并知道什么时候必须升级 |
| 10 | 可选：抽一个 CodeMirror 6 语法包/编辑组件 | 现在本站编辑器只能把源文当普通 Markdown 显示 |

---

## 7. 风险登记

| 风险 | 触发 | 影响 | 缓解（P1 已覆盖 / P2 需补） |
|---|---|---|---|
| 渲染器 0day = 同源 XSS | P2/C1（主文档执行） | 会话级沦陷（含 admin） | **P1 沙箱 iframe**；P2 需 CSP + 安全评审 |
| 图片/链接策略过宽 | 宿主 `urlPolicy` 写成 `() => true` | 外链跟踪像素 / 内网探测 | 只白名单站内 raw 读口；`connect-src 'none'` |
| 大文档 CPU/内存 | 逐请求 compile 或 800+ 控件 | 页面卡顿 / DoS | 发布前 compile 校验 + 大小上限 + 懒加载 + 缓存 |
| 编译失败整篇不显示 | 作者写了 raw HTML/未知标签 | 读者看到诊断面板 | 发布前校验拦截；失败时降级为「源文代码块 + 提示」 |
| 供应链/维护中断 | 库停止维护 | 升级/修复断档 | 锁 commit + vendor 备份 + 保留 LICENSE |
| 与站内管线重复 | 两套 remark、两套数学 | 体积 + 视觉不一致 | P1 隔离在 iframe 内；P2 需统一主题 |
| 导出/打印失真 | iframe 在静态文件里 | 导出件里一个死框 | 导出时替换为说明块（显式测试） |
| 无障碍/真机兼容 | MathML/自定义控件 | 部分浏览器不可用 | 真机验收（Safari/Firefox），库侧补 a11y |

---

## 8. 需要站长拍板的产品问题

1. 交互文档是「**博客正文的一部分**」（混排）还是「**一种独立的文档格式**」？
2. 读者范围：只给 core+ 成员，还是公开博客的匿名读者也要能交互？
3. 是否接受「第三方渲染器在站内（沙箱内）执行」？P2 的「主文档执行」是否接受？
4. 图片/链接策略：交互文档能否引用图床与外链？还是完全离线？
5. 如果朋友的项目停止维护，本站是否愿意 fork 维护？

---

## 9. 证据索引（关键文件）

**ReactiveMD**：`package.json`（private/exports/files）、`src/local/parser.ts:28,365-368`（remark / 拒 raw HTML）、
`src/local/expression.ts:8-14,36-64,209-214`（无 eval / 白名单 / 预算）、`src/local/limits.ts`、
`src/local/LocalDocumentView.tsx:270-299,424-466,1993-1995`（URL 策略 / 链接加固 / 单订阅整篇重渲染）、
`src/local/math-view.tsx`（自研 MathML）、`docs/local-integration.md`、`demo/IMPLEMENTATION.md`。

**本站**：`src/lib/blog-renderer.ts:1-78`（唯一 HTML 实现）、`src/lib/blog-markdown.ts:27-42`（白名单）、
`src/lib/rich-text.ts:19-42`（五道防线）、`src/app/components/MarkdownRenderer.tsx:119-208`（innerHtml memo / 客户端渲染）、
`src/lib/blog-content-dom.ts:1-120`（唯一挂载后钩子）、`src/lib/content-ref-processor.ts`（盖码/预算/切片）、
`src/app/components/markdown-editor/export.ts`（导出）、`src/lib/blog-excerpt.ts`（围栏整段丢弃）、
`src/app/game/quandi/play/route.ts:19`（CSP sandbox 先例）、`src/app/layout.tsx`（root layout 含 FrameBuster）、
`src/lib/session.ts:63-69`（httpOnly + SameSite=Lax）、`src/middleware.ts`（基于 Origin/Referer 的 CSRF）。

**实测数字**：dist gzip 79.0 + 28.2 KB（JS）、5.9 KB（CSS）；冷启动 compile ~0.5 s、warm 18 KB/100 面板 30 ms；
6,000 段（59 KB）触发 10,000 节点上限；800 控件 227 ms compile / 531 ms 首渲染 / 421 ms 每次更新；
blog 正文上限 250,000 字符、剪贴板上限 50,000 字符（前端 30/250000 与服务端 40/50000 存在既有不一致，
与本评估无关但顺手记一笔）。
