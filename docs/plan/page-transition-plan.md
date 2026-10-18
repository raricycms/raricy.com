# 切页动画方案（P0–P2）

> **状态：仅方案 + P0 概念 demo，产品代码未改。** 校对日期：**2026-10-18**。
> 本文给出 P0–P2 三层的落点、实现方式、风险与验收；P0 的可交互 demo 是同目录的
> `docs/plan/page-transition-p0-demo.html`（单文件，无网络依赖，直接打开即可）。
> 正式落地时，动效数值与适用范围以 `docs/frontend-styles.md` §10「动画」为准，
> 本文只负责方案与边界。

## 1. 背景与结论

目标是让站内切页不再"硬切"，在不改变站点安静、克制气质的前提下补一层顺滑感。
结论：**分三层推进，先做 P0 + P1，P2 作为实验批**。

| 层级 | 内容 | 风险 | 建议 |
|------|------|------|------|
| P0 | 全站切页淡入（只有内容区，顶栏/页脚不动） | 低 | 先做 |
| P1 | 页面内过渡（列表筛选/翻页、弹层、章节、结果面板） | 低–中 | 紧随 P0 |
| P2 | 真正的路由交叉溶解、滚动入场、主题扩散 | 高 | 实验，先小范围试点 |

两个先决判断：

- **不引入 framer-motion 一类运行时动画库。** 本站的动画都可由 CSS / Web Animations /
  浏览器 View Transitions API 完成，引入库只会增加包体与 RSC 边界问题，退出动画在
  App Router 里仍要自己接。
- **整页动画只允许 `opacity`，不允许 `transform` / `filter` / `will-change`。**
  站点里大量 `position: fixed` 元素与 Playwright 几何断言都依赖"内容盒子不被祖先
  位移"，详见 §3.3。

## 2. 架构判断：Next 适合哪一半

Next 15 App Router + React 19 的结构对切页动画是"半适合"：

| 能力 | 现状 | 对切页动画的意义 |
|------|------|------------------|
| 布局常驻 | `src/app/layout.tsx` 里顶栏/页脚不随路由重挂，只有 `<main>` 内容在换 | 只动内容区，便宜且稳 |
| Link 预取 + RSC | Next 15.5 的 `<Link>` 默认预取 | 动画不必等整页加载 |
| `template.tsx` | 支持，但项目里一个都没用 | 零 JS 入场动画的原生入口（备选，见 §4.3） |
| 离场生命周期 | **没有** | 交叉溶解要自己接 View Transitions |
| React `<ViewTransition>` | 项目装的 React 19.2.7 **没有这个导出**；Next 15.5 的 `experimental.viewTransition` 明确依赖 React 的 `unstable_ViewTransition` | 这个开关**开不起来**，不要试 |
| 路由级 pending 状态 | 只有 Link 级的 `useLinkStatus`，没有全局路由事件 | 进度条/等待反馈要另想办法 |
| 已有先例 | 聊天切频道已用 `document.startViewTransition` 做 160ms 交叉淡入（`src/app/chat/ChatApp.tsx` 的 `switchWithFade` 与 `src/styles-scss/pages/_chat.scss` 的 `::view-transition-*`） | 动画语言与 API 都有现成样本 |
| 等待态 | 四十多个 `force-dynamic` 页面里，目前只有 blog / explore 有 Suspense 骨架 | 动画只能遮住"换页那一瞬"，遮不住"等数据" |

因此：**入场型动画几乎零成本；真正的旧页淡出、新页淡入没有官方入口。** 想要后者，
只能自己写一层导航拦截 + View Transitions（P2），范围与风险都明显更大。

## 3. 动效规范

### 3.1 数值

| 场景 | 时长 | 做法 | 备注 |
|------|------|------|------|
| 页面入场 | 160ms | `opacity 0 → 1`，**不位移** | 顶栏/页脚不动，只有内容淡入 |
| 页面内内容切换 | 120–160ms | `opacity` ± 2–4px `translateY` | 只用于列表区、结果面板等小块 |
| 弹层 | 160ms | 遮罩淡入；dialog **只淡入不缩放** | scale 会让 e2e 的几何断言在动画中间抖动 |
| 列表分批 | 30ms/项，最多 5 项 | 仅首屏或筛选后 | 不要每次轮询都播 |
| 缓动 | — | `ease-out`；面板可用 `cubic-bezier(0.16, 1, 0.3, 1)` | 与顶栏展开（`src/styles-scss/layout/_header.scss`）同一套感觉 |

### 3.2 三条硬规矩

1. **`prefers-reduced-motion: reduce` 下一律 0ms。** 站点已有这套纪律（`src/styles-scss/pages/_home.scss`
   的 reduced-motion 块、`src/app/components/HeroLandscape.tsx` 的 `reducedMotion`），新动画照做。
2. **不做横滑推拉、不做 3D、不做弹簧、不超过 300ms。**
3. **动画只做视觉叠加，绝不延缓可点击/可读。**

### 3.3 为什么整页只能动 opacity

站点里有大量 fixed 元素：顶栏（`src/styles-scss/layout/_header.scss`）、博客阅读进度条
（`src/styles-scss/pages/blog/_blog.scss` 的 `.reading-progress`）、故事进度条
（`src/styles-scss/pages/_story.scss` 的 `.story-reader__progress`）、modal
（`src/styles-scss/components/_modal.scss`）、图片放大层（`src/styles-scss/pages/_chat.scss`
的 `.chat-lightbox`）等。

- 祖先一旦有 `transform` / `filter`，fixed 后代就会改以该祖先为包含块，位置当场跑掉；
- Playwright 里一批几何用例在 `goto` 后**立刻**量盒子，整页 transform 会让它们变成
  时序相关（`tests/e2e/page-gutter.spec.ts`、`tests/e2e/favorite-layout.spec.ts` 等）；
- `opacity` 不移动任何盒子，是唯一安全的整页动画属性。它只在这 160ms 内临时创建
  stacking context，见 §4.4。

## 4. P0：全站切页入场

### 4.1 目标观感

顶栏和页脚保持不动，点导航后内容区从页面底色淡入，160ms 内完成；首屏、前进/后退、
满屏工作台 `/chat` 都不播。

### 4.2 方案 A（推荐）：客户端 `PageMain`

把根 layout 的 `<main>` 换成一个客户端组件 `PageMain`，由它渲染 `<main>`。这样：

- 保持 `body > main` 这个直接子选择器不变（`src/styles-scss/base/_root.scss` 依赖它做
  安全区留白），不新增 DOM 层级；
- 用 `usePathname()` 观察路径变化，在同构 `useLayoutEffect` 里给 `<main>` 重播
  `.page-enter` 类：`remove` → 强制 reflow → `add`（或改用 WAAPI `el.animate`）；
- 首屏跳过（`useRef` 记录），避免与首页 hero 自己的 0.9s 入场叠两层；
- 监听 `popstate`，前进/后退跳过动画，保住滚动位置；
- `/chat` 跳过（满屏工作台，自带频道切换过渡，见 `src/app/components/FooterGate.tsx`
  对这条路由的特判）；`/` 可跳过或缩到 120ms；`/admin`、`/audit` 视观感决定是否跳过。

用 `useLayoutEffect` 是为了在浏览器绘制前把类加上，避免"先完整显示、再闪一下淡入"；
SSR 下要用 `typeof window === 'undefined' ? useEffect : useLayoutEffect` 的同构写法，
否则 Next 会在服务端渲染时告警。

CSS 只需一条 keyframes：

```css
@keyframes page-in { from { opacity: 0; } }
.page-enter { animation: page-in var(--motion-page, 160ms) ease-out backwards; }
@media (prefers-reduced-motion: reduce) {
  .page-enter { animation: none; }
}
```

不写 `forwards`：动画结束后 opacity 回到 1，临时 stacking context 随之消失，与
`src/styles-scss/pages/_home.scss` 里 hero 入场"结束后释放 opacity/transform"是同一种做法。

建议文件落点：

- 新增 `src/app/components/PageMain.tsx`（客户端，约 40 行）；
- 新增 `src/styles-scss/base/_page-transition.scss`，在 `src/styles-scss/main.scss` 的
  `base/` 段按序 `@use`；
- 改 `src/app/layout.tsx` 的 `<main>{children}</main>` 一行；
- 动效 token 可放 `src/styles-scss/abstracts/_motion.scss`（时长 / 缓动常量），供 P1 复用。

### 4.3 方案 B（备选）：`template.tsx`

新增 `src/app/template.tsx` + CSS 动画。零客户端 JS，是 Next 的原生入口；代价是每次
导航会重挂载嵌套 layout（admin / audit / game），且**无法按路由跳过**，首屏也会播。
适合先试水，不适合作为长期方案。

### 4.4 已知副作用

`main` 的 opacity < 1 会临时创建 stacking context：如果这 160ms 内正开着页面里的 fixed
弹层，弹层的 `z-index` 会被限制在 `main` 内，可能落到固定顶栏下方。正常导航时弹层不会
开着，可以接受；要彻底解决，就把弹层逐步 portal 到 `body`，或改成"只对正文容器淡入、
弹层挂到 portal"的结构。

### 4.5 P0 验收

- 任意两个站内页面之间软导航：内容淡入 160ms，顶栏/页脚零位移；
- 直接刷新、从外部进入：不播；
- 浏览器前进/后退：不播，滚动位置正确恢复；
- `/chat` 进入/离开：不播（或明显更短），不干扰频道切换；
- `prefers-reduced-motion: reduce`：0ms；
- 无 JS：内容直接可见；
- 页面里打开着的 fixed 元素（阅读进度条、弹层）在动画期间不跑位。

## 5. P1：页面内过渡

P1 的收益往往比 P0 更大：用户日常操作里最多的不是"换页面"，而是筛选、翻页、开弹层。
按实现方式分三类。

### 5.1 三种实现模式

| 模式 | 适用 | 做法 | 成本 |
|------|------|------|------|
| 服务端 key 重挂 | 依赖 URL 查询参数的列表：博客/探索筛选、鱼干流水、通知翻页 | 在 RSC 里给列表壳加 `key={queryString}`，导航后 React 重建 DOM → CSS 动画自动重播 | 零客户端 JS |
| 客户端 key / WAAPI | 组件内状态：工具结果、图表周期、tab | `key={state}` 或 `el.animate()` | 很小 |
| View Transitions | 同步 DOM 替换、需要旧内容淡出的地方：弹层、模态 | `document.startViewTransition`（`src/app/chat/ChatApp.tsx` 已有样板） | 中等 |

### 5.2 落点清单

| 落点 | 触发 | 做法与注意 |
|------|------|------------|
| 博客 / 探索列表 | 筛选、排序、翻页 | 列表区外壳按 searchParams 重挂 + 淡入；hero 与侧栏不动。**别改 `.blog-item` 等被 e2e 钉住的类名** |
| 骨架 → 内容 | Suspense 替换 | 内容挂载时天然触发 CSS 淡入，零额外代码 |
| 通知 | 翻页、标记已读 | 列表已按 `key={result.page}` 重挂（`src/app/notifications/page.tsx`），加淡入即可；已读底色已有 0.3s 全局过渡（`src/styles-scss/base/_reset.scss`） |
| 文档 | 索引 → 文档、同组切换 | 全局入场已覆盖；也可只让正文区淡入，侧栏不动 |
| 故事 | 章节/上下篇切换 | 内容淡入 + 滚动复位；注意 fixed 进度条 |
| 工具 | 切换工具 / 结果面板 / convert 分类 | 结果面板 `key` 重挂 + 120ms 淡入 |
| 鱼干 | 流水筛选、交易周期切换 | 只让内容/图表容器 opacity 淡入；**不要**对 canvas/SVG 做 transform，也不要让 15 秒轮询触发动画 |
| 弹层 | modal / lightbox / 下拉 | 遮罩 opacity 160ms；dialog 只 opacity；lightbox 只动遮罩，别动图片 transform（`src/styles-scss/pages/_chat.scss` 的 `.chat-lightbox__img` 注释已写明缩放走 transform） |
| 讨论 | 频道切换 | 已有 160ms VT，保持；新消息入场可选，只 opacity，避免长列表跳动 |

### 5.3 P1 禁忌

- 不要在轮询/SSE 更新时播动画（鱼干行情、通知铃铛）；
- 不要给表格行、图表元素加 transform 入场（几何断言 + 重排）；
- 不要为了动画把 `display:none` 的弹层改成常驻 DOM 再淡出式关闭——退出动画不值得
  引入一套状态机；先接受"开有动画、关瞬时"。

## 6. P2：实验项

### 6.1 路由交叉溶解

机制：Next 15 的 `<Link onNavigate>` 是**同步**的，`preventDefault()` 会取消默认导航；
可以自己调 `router.push`，并用 `document.startViewTransition` 包住，等 `usePathname`
变化后再 resolve 新快照。与聊天切频道同一思路，只是对象换成路由。

范围：先只包 4–5 条高价值路径（首页功能卡、博客列表卡、文档条目、故事条目），不要
全局拦截。必须处理：同 pathname 只改查询参数时不 VT（否则 promise 不 resolve）、
popstate 不 VT、VT 进行中要禁用 P0 的入场淡入（否则新快照会拍到 opacity 0 的透明页）、
快速连点与超时兜底。

风险：丢失 Link 的 `scroll` / `replace` 语义、多标签页/iframe、流式 Suspense、
浏览器支持差异（Chromium/Safari 较新版本支持，旧版优雅降级）、e2e 时序。**建议等
P0 + P1 稳定并观察一周后再评估。**

### 6.2 首页滚动入场

IntersectionObserver + 30ms stagger（最多 5 张卡），reduced-motion 下关闭。hero 已有
视差和入场，这里补的是下半屏。

### 6.3 主题切换圆形扩散

技术上可行，但站点已有日月旋转和全站色彩过渡，可能过头；先不做。

### 6.4 共享元素 morph

本站博客列表没有封面图、标题也小，没有可 morph 的视觉锚点，**不建议硬做**。

## 7. 明确不做

- 整页横滑/缩放/3D/弹簧动画；
- 页面外壳上的 `transform` / `filter` / `will-change`；
- 数据表格、K 线、统计数字随轮询播动画；
- 全局 `scroll-behavior: smooth` —— 会让 Next 路由切页时的回顶变成慢速滚动；
  `#features` 的锚点偏移已经用 `scroll-margin-top: 78px` 处理了；
- 在 VT 交叉溶解之外再叠一层入场淡入；
- 引入 framer-motion 等运行时动画库。

## 8. 实施顺序与验证

| 阶段 | 内容 | 预估 |
|------|------|------|
| 0 | 定 token，新增 `abstracts/_motion.scss`，补 `docs/frontend-styles.md` §10「动画」 | 半天 |
| 1 | P0：`PageMain` + SCSS + 跳过规则 | 半天–1 天 |
| 2 | P1：挑 4–6 个落点（博客列表、通知、文档、弹层、工具结果、鱼干筛选） | 1–2 天 |
| 3 | 观察一周，再决定 P2 做哪几条 | — |

验证：

- `npx tsc --noEmit`、`npm run lint`、`npm run test`；
- `npm run build && npm run e2e`（注意 `npm run e2e` 不自动 build，读的是旧 `.next`）；
  重点盯 `tests/e2e/page-gutter.spec.ts`、`tests/e2e/favorite-layout.spec.ts`、
  `tests/e2e/comment-layout.spec.ts`、`tests/e2e/clipboard-layout.spec.ts`、
  `tests/e2e/fish-layout.spec.ts`、`tests/e2e/editor-mobile-toolbar.spec.ts`、
  `tests/e2e/home-hero.spec.ts`、`tests/e2e/chat-image.spec.ts`、
  `tests/e2e/save-navigation.spec.ts`；
- 手动：Chrome / Safari / Firefox，reduced-motion，无 JS，iframe 嵌入，慢网，
  前进/后退与滚动位置恢复，暗色主题，超长文章返回；
- 补等待态：给主要动态页补 `loading.tsx` 或骨架。**动画只能让"切换"顺滑，等待本身
  要靠骨架**，这是目前顺滑感上的另一个真实缺口。

## 9. P0 demo

`docs/plan/page-transition-p0-demo.html` 是 P0 的单文件概念 demo，用与本文 §4 相同的
CSS/JS 思路模拟一个小站点：固定顶栏、内容区淡入、首屏不播、前进/后退不播、
reduced-motion 直接切。控制面板可以：

- 开关切页动画、调时长（80–260ms）；
- 强制模拟 `prefers-reduced-motion`；
- 打开"入场时上移 6px"的错误示范，观察 fixed 进度条为什么会跑位；
- 重播当前页。

它**不是**产品代码：真实接入按 §4.2 改 `src/app/layout.tsx`，不要把这个 HTML 放进
`public/` 当站点页面。
