# 前端样式规范

> 概述：raricy.com（聪明山）的整套前端样式体系。来源是 `src/styles-scss/` 下的 SCSS，由 [src/app/layout.tsx](../src/app/layout.tsx) 引入入口文件、交给 Next.js 编译。全站不依赖 Bootstrap——所有 Bootstrap 风格工具类都有本地 fallback 实现。

## 1. 架构与构建

样式全部用 **SCSS** 编写，按 7-1 风格目录组织，入口是 `src/styles-scss/main.scss`：

```
src/styles-scss/
├── abstracts/    变量、断点、mixin、函数、主题 map
├── base/         reset、root（CSS 变量）、排版、表单、Bootstrap fallback
├── components/   按钮、导航、图标、弹窗、卡片、告警、表单控件、toast、分页
├── layout/       容器、栅格、顶栏、页脚、后台侧边栏
├── pages/        各页面样式（首页、博客、讨论、通知、管理后台…）
├── utilities/    间距、显示、flex、文本工具类
└── main.scss     入口，控制 import 顺序
```

**构建**：[src/app/layout.tsx](../src/app/layout.tsx) 直接 `import '@/styles-scss/main.scss'`，
**由 Next 自己编译**（`sassOptions` 见 `next.config.mjs`）：

- `npm run dev` — 改任意 SCSS 立即生效。HMR 带 source map，DevTools 里直接看到 `_*.scss` 的行号
- `npm run build` — `next build` 编译进 `.next/static/css/`

**没有手工编译步骤，也没有入库的编译产物**（`src/styles-scss/compiled/` 已进 `.gitignore`）。
改样式只改 SCSS 源文件，不需要提交任何产物。

> ⚠️ 别把入口改名成 `main.module.scss`：`.module.` 后缀会让 Next 按 **CSS Modules**
> 处理、把全站类名哈希化，样式整体失效。

`npm run css:probe` 仍在，但**只服务离线调试**：产物是 `src/styles-scss/compiled/probe.css`，
`tests/.tmp/` 下那几个手工像素探针 HTML 用 `<link>` 直接引它。要跑探针先 `npm run css:probe`；
日常开发与部署都用不到它。
名字里刻意不带 `build:` —— 它不在构建链上，别让名字把人骗了。

四条守卫（`css-classes` / `css-js-classes` / `css-tsx-classes` / `check:links` §4）读的
CSS 由 [scripts/compiled-css.mjs](../scripts/compiled-css.mjs) **现编**入口 SCSS —— 不读任何
落盘产物，也**不能**改成扫 SCSS 源（`&--has` 这类嵌套在源里没有展开后的字面量，
扫源会假阳性）。

其中 `css-tsx-classes`（`tests/unit/css-tsx-classes.test.ts`）是**无样式类名的权威名单**：
.tsx/.ts 里写了、CSS 里没有的类名，要么补样式，要么在那份 `UNSTYLED` / `CONSUMED`
里登记一行并写清理由（`.clipboard-markdown-content` 这类包装就在那儿）。下面 §12
再提到「某个类刻意没有样式」时，以那份名单为准，别在这里另抄一份。

行尾：`.css` / `.scss` 一律 LF，由根目录 [.gitattributes](../.gitattributes) 声明。

## 2. 设计令牌（CSS 变量）

主题令牌集中在 `src/styles-scss/base/_root.scss`，通过 `<html data-theme="light|dark">` 切换。所有组件样式必须引用这些变量，**禁止在组件里写死主题色**（有意的硬编码除外）。

### 2.1 主色板（浅色 `data-theme="light"`）

| 变量 | 值 | 用途 |
|------|-----|------|
| `--color-brand-primary` | `#2563EB` | 品牌主色：链接、主按钮、激活态 |
| `--color-brand-secondary` | `rgba(37,99,235,0.1)` | 品牌浅底：胶囊底、hover 背景 |
| `--color-background-page` | `#F8FAFC` | 页面背景 |
| `--color-background-card` | `#fff` | 卡片 / 顶栏 / 底栏背景 |
| `--color-background-content` | `#eff2f5` | 输入框、代码块、内容底色 |
| `--color-background-card-unread` | `#fffdf0` | 通知未读卡片底 |
| `--color-background-subtle` | `#f3f4f6` | 弱背景（hover、徽章） |
| `--color-background-highlight` | `#eef2ff` | 高亮背景 |
| `--color-border` | `#E2E8F0` | 常规边框 |
| `--color-border-unread` | `#f1c40f` | 未读高亮边框 |
| `--color-border-highlight` | `#007bff` | 聚焦 / hover 边框 |
| `--color-text-primary` | `#0f172a` | 主文本 |
| `--color-text-secondary` | `#64748B` | 次要文本、meta |
| `--color-text-tertiary` | `#dde4ee` | 禁用态底 / 分割线 |
| `--color-warning-primary` | `#ea3b3b` | 危险色（点赞、删除） |
| `--color-warning-secondary` | `rgba(255,47,47,0.1)` | 危险浅底 |
| `--color-success-primary` | `#10b981` | 成功色（投喂、签到） |
| `--color-success-secondary` | `rgba(16,185,129,0.1)` | 成功浅底 |
| `--color-info-secondary` | `rgba(59,130,246,0.08)` | 信息浅底 |
| `--color-star-primary` | `#f1c40f` | 收藏夹：黄色五角星（**唯一的黄色语义色**；`--color-warning-*` 其实是红）。**只在「已收藏」与 hover 时用**，未收藏不亮 —— 见 §6.7 |
| `--color-star-secondary` | `rgba(241,196,15,0.12)` | 收藏夹按钮的选中态浅底 |
| `--color-accent-blue` / `-soft` | `#3b82f6` | **分类强调色**：把同页几项彼此分开的色相，非语义色（见 §2.6） |
| `--color-accent-amber` / `-soft` | `#f59e0b` | 同上 |
| `--color-accent-cyan` / `-soft` | `#06b6d4` | 同上 |
| `--color-accent-violet` / `-soft` | `#8b5cf6` | 同上 |

> ⚠️ **`--color-text-tertiary` 不是「第三级文字」**：它的值（浅色 `#dde4ee`、暗色
> `#2b3036`）是**背景/分割线**档，拿来写 `color` 几乎是隐形的。弱化文字一律用
> `--color-text-secondary`（`--fd-ink-3` 映射的也是它，可作旁证）。
> 名字里带 `text-` 所以极易误用 —— 补样式时从旧文件搬 `--ink-3` 要落在
> `--color-text-secondary` 上（旧 `--ink-3` 是 `#86868B` 那样的可读灰）。

### 2.2 主色板（深色 `data-theme="dark"`）

| 变量 | 值 |
|------|-----|
| `--color-brand-primary` | `#23A5FF`（更亮的蓝，保证对比度） |
| `--color-brand-secondary` | `rgba(35,165,255,0.1)` |
| `--color-background-page` | `#131517` |
| `--color-background-card` | `#181A1D` |
| `--color-background-content` | `#21252A` |
| `--color-background-card-unread` | `#08102D` | 通知未读卡片底（`.notification-card.unread`） |
| `--color-background-subtle` | `#1e2024` |
| `--color-background-highlight` | `#1a2040` |
| `--color-border` | `#334155` |
| `--color-border-unread` | `#033ae3` |
| `--color-border-highlight` | `#23A5FF` |
| `--color-text-primary` | `#f1f5f9` |
| `--color-text-secondary` | `#94A3B8` |
| `--color-text-tertiary` | `#2b3036` |
| `--color-warning-primary` | `#FF3535` |
| `--color-warning-secondary` | `rgba(255,53,53,0.1)` |
| `--color-success-primary` | `#10b981` |
| `--color-success-secondary` | `rgba(16,185,129,0.12)` |
| `--color-info-secondary` | `rgba(59,130,246,0.12)` |
| `--color-star-primary` | `#ffd93d`（比浅色侧提亮一档，否则压在深底上发闷） |
| `--color-star-secondary` | `rgba(255,217,61,0.14)` |

### 2.3 阴影

| 变量 | 浅色 | 深色 |
|------|------|------|
| `--shadow-xs` | `0 2px 10px rgba(0,0,0,.05)` | `rgba(0,0,0,.2)` |
| `--shadow-sm` | `0 2px 10px rgba(0,0,0,.1)` | `rgba(0,0,0,.25)` |
| `--shadow-card` | `0 4px 20px rgba(0,0,0,.08)` | `rgba(0,0,0,.3)` |
| `--shadow-card-hover` | `0 8px 30px rgba(0,0,0,.12)` | `rgba(0,0,0,.4)` |
| `--shadow-card-brand` | `0 2px 25px rgba(37,99,235,.15)` | `0 2px 20px rgba(35,165,255,.1)` |
| `--shadow-focus-brand` | `0 0 25px rgba(37,99,235,.28)` | `0 0 20px rgba(35,165,255,.32)` |

卡片 hover 统一升到 `--shadow-card-brand`（品牌色光晕），同时边框切 `--color-border-highlight`。

`--shadow-focus-brand` 是**聚焦态**专用的光晕：与 `--shadow-card-brand` 同色同模糊半径，
但偏移为 `0`（四周均匀），不透明度高一档 —— 常驻阴影是「托住」元素，聚焦态得自己站得出来。
**不要拿它当常驻阴影用。**

它是**全站字段唯一的聚焦反馈**（见 §4.2）：单行输入框、textarea、`<select>`、
金额外壳（`focus-within`）、评论/讨论输入面板（`focus-within`）都用它。
聚焦一律**只加光晕、不换底色**，也绝不用 `border` 表达 —— 边框会改变元素高度，
失焦瞬间会让下方内容位移（注册页 e2e 的勾选失败踩过这个坑，见 §6.3）。

### 2.4 SCSS 侧令牌

`src/styles-scss/abstracts/_variables.scss`：

- 圆角：`$radius-max: 999px`（胶囊）、`$radius-card: 30px`（卡片）、
  `$radius-field: 20px`（多行字段）、`$radius-large: 10px`、`$radius-small: 5px`
  —— 取哪个由**内容形态**决定，判据见 §4
- 间距：`$space-1: 4px` … `$space-8: 32px`（4px 递进）
- 容器：`$container-max: 1140px`

> `abstracts/_theme-map.scss` 里只有一个 light 主题的 map，配套的 `themeify` / `themed` mixin 已被注释停用。**实际主题切换完全靠 CSS 变量 + `[data-theme]`**，不要用旧的 theme-map 方案。

### 2.5 Fluent（fd-）别名令牌

OAuth 授权 / 图片 / 小鱼干等较新页面与工具类用 `fd-` 前缀令牌（沿用新页面注释里的 "Fluent Design" 命名），定义在 `base/_root.scss`，**全部以 `var()` 别名指向 2.1 / 2.2 的 `--color-*` 体系**，随 `[data-theme]` 自动切换；深色主题只覆写个别值（如 `--fd-accent-soft`）。新增页面可复用，不必自己再造一套：

- 文字：`--fd-ink` / `--fd-ink-2` / `--fd-ink-3`（主 / 次 / 弱文本）
- 品牌：`--fd-accent`（=`--color-brand-primary`）、`--fd-accent-tint`（浅色高亮底）、`--fd-accent-soft`
- 状态：`--fd-danger` / `--fd-danger-soft`、`--fd-success` / `--fd-success-soft`
- 字号：`--fd-text-base`（0.95rem）/ `--fd-text-sm`（0.85rem）/ `--fd-text-xs`（0.75rem）
- 间距：`--fd-space-1`（4px）… `--fd-space-8`（32px），4px 递进
- 工具类：`utilities/_text.scss` 的 `.u-text-sm` 等引用 fd 字号令牌

### 2.6 分类强调色（`--color-accent-*`）

**「语义色」与「分类色」是两回事**，分开是因为混用会让人误读：

- **语义色**（`--color-warning-*` 红 = 危险/删除、`--color-success-*` 绿 = 成功、
  `--color-brand-*` 蓝 = 主行动）表达**状态** —— 看到红就知道出事了。
- **分类色**（`--color-accent-*`）只表达「这是第 N 项，和第 M 项不是一回事」。

用到分类色的地方：首页四张功能卡的图标、管理概览的统计卡、运势卡的五档、
精选与分类标记、审计状态。这些场景里的红**不是**「危险」、绿**不是**「成功」，
所以不能拿语义色去顶 —— 那会让「总用户数」那张卡看起来像报错。

四对令牌，与其它色系同构（`-soft` 作淡底），深色主题各提亮一档：
`--color-accent-blue` / `-amber` / `-cyan` / `-violet`。

> ⚠️ 黄色的 `--color-star-*` **不属于这一组**：它是「收藏夹五角星」的专用语义色，
> 用途边界明确（见 §6.7）。需要第 5 个色相时用 `--color-accent-amber`。

## 3. 排版

- 未引入 web font，使用系统字体栈（`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …` / `system-ui`）。
- `body`：`-webkit-font-smoothing: antialiased`，主色 `var(--color-text-primary)`。
- 链接默认**无下划线**（`reset` + `typography` 里 `a { text-decoration: none }`），hover 也不加，靠变色/加粗区分。
- 标题字重以 `600 / 700` 为主；页级大标题常见 `font-size: 2rem–3.5rem` + `font-weight: 700`。
- 正文阅读内容（博客正文）`font-size: 1.15rem; line-height: 2;`，段落 `text-align: justify`。
- 全局 `transition: color 0.3s ease, background-color 0.3s ease`（`base/_reset.scss`），
  保证主题切换平滑。⚠️ 这条是**全局 `*` 规则且只有这一处定义**：别为了给某个元素加
  过渡而扩成 `transform` —— 那会让全站的 transform 都带上动画，`chat-image.spec.ts`
  读 `matrix(1.5,…)` 那类断言会变成时序相关。给单个组件写自己的 `transition` 即可。

## 4. 圆角与形状语言

「**胶囊 + 大圆角**」是视觉基调：

选哪个圆角由**内容形态**决定，不是按页面随手挑：

| 形态 | 圆角 | 落点 |
|------|------|------|
| 单行元素 | `999px` 胶囊 | 按钮、**单行输入框**、徽章、导航项、切页、页码 |
| 卡片 | `30px`（`$radius-card`） | 博客条目、通知卡、登录/注册容器、博客正文容器、弹窗内容 |
| 多行字段 | `20px`（`$radius-field`） | textarea、多行输入面板 |
| 次级面板 / 小组件 | `10px` / `6–8px` | 分页外壳、代码块、内联标记 |
| 图标徽章 | 圆形 `50%` 或胶囊 `999px` | 红点、角标 |
| 头像 | **固定 `8%`** | 见 §4.1，不用圆形头像 |

**输入框的圆角判据是硬规则**，见 §4.2。

### 4.1 头像圆角规范（全站统一 8%）

> 2026-09 统一：此前各页面头像圆角漂移在 `4px–10px` / `5%–25%` 之间，观感不一；现全站收敛为同一比例。

**头像一律 `border-radius: 8%`**（≈ 尺寸 × 1/12.5），用百分比而非固定 px——随头像尺寸自动缩放，不同尺寸下圆角观感一致：

| 头像尺寸 | 20px | 24px | 28px | 32px | 34px | 120px |
|----------|------|------|------|------|------|-------|
| 实际圆角 | 1.6px | 1.9px | 2.2px | 2.6px | 2.7px | 9.6px |

要点：

- **不用圆形头像**（历史上曾有 `border-radius: 50%` 的写法，按「方形小圆角」取向移除——残留注释见 `pages/blog/_menu.scss`）。
- 内联样式同样写 `border-radius: '8%'`，不要写死 px（例：FeedButton 弹窗名单）。
- **全站头像走共用组件 `<Avatar>`**（`src/app/components/Avatar.tsx` + `components/_avatar.scss`，
  2026-09 收敛）。`8%` 这条现在由组件持有，各站点类里残留的 8% 是**冗余，别顺手删**
  ——组件一旦被绕过，那些点会静默退回方角。尺寸仍由各站点原来的类决定，`.avatar`
  盒子**不设 width/height**（设了会把 `imgClassName` 那几处撑变形）。
  头像框贴图是盒子里的绝对定位 `<img class="avatar__frame">`，随盒子尺寸自适应，
  所以 20px 与 120px 是同一个写法。
- 现有落点清单（改样式或加新头像时对照，勿再漂移）：

| 位置 | 选择器 / 出处 | 尺寸 |
|------|--------------|------|
| 顶栏用户头像 | `.site-user-avatar`（layout/_header.scss） | 32px |
| 个人主页大图 | `.profile-hero__avatar`（pages/_profile.scss） | 120px |
| 讨论 · 频道列表 / 折叠图标 | `.chat-chan__avatar` / `.chat-chan__icon`（pages/_chat.scss） | 34px |
| 讨论 · 会话标题栏 | `.chat-main__peer-avatar`（pages/_chat.scss） | 32px |
| 讨论 · 消息作者 | `.chat-msg__avatar`（pages/_chat.scss） | 34px |
| 新会话弹窗列表 | `.chat-new-item__avatar`（pages/_chat.scss） | 32px |
| 签到排行榜（含占位） | `.checkin-leaderboard__avatar` / `-placeholder`（pages/_checkin.scss） | 32px |
| 后台用户卡片 | `.user-card__avatar`（pages/admin/_users.scss） | 28px |
| 博客列表 / 详情作者 | `.blog-author img`（pages/blog/_menu.scss，博客列表与详情页共用） | 20px |
| 博客评论作者 | `.comment-author-avatar`（pages/blog/_blog.scss） | 24px |
| Feed 弹窗名单（点赞 / 动态） | FeedButton.tsx 内联 style（两处） | 32px |
| 讨论 / 评论正文里的用户名片 | `.rich-user-ref__avatar`（components/_markdown-body.scss） | 1.4em（随正文字号，两条管线基准字号不同） |

> 名片那一行是全站唯一**手搭 DOM** 的头像落点（正文管线是字符串进字符串出，塞不进
> `<Avatar>`，见 `tests/unit/avatar-sites-guard.test.ts` 的 DOM 档台账）。它也就享受不到
> 组件那层保护 —— 圆角仍由 `.avatar` 盒子的 8% 给，但**通用 `.类 img` 规则会漏进来**，
> 见 §11.1 的最后一条。

### 4.2 输入框的圆角判据（硬规则）

> 2026-09 统一：此前全站输入框的圆角漂在 `15px / 10px / 8px / 6px / 5px / 4px /
> 0.375rem` 之间，一半带描边一半不带，底色在「卡片白 / 页面灰 / 内容灰」之间随机，
> 聚焦反馈有四种写法（描边变色 / 硬环 / 写死的 Bootstrap 蓝 / 什么都没有）。

**当且仅当「内部元素仅为一行文字」时，圆角恰好是胶囊形**：

| 元素 | 圆角 |
|------|------|
| `<input>`、`<select>`、单行搜索框、金额外壳 | `999px` |
| `<textarea>`、多行输入面板、脚本/正文编辑器 | `20px`（`$radius-field`） |

配套的三条：

1. **外观统一**：无边框 + `--color-background-page` 底 + 聚焦 `--shadow-focus-brand`
   + `::placeholder` 用 `--color-text-secondary`。基准是博客首页的搜索框。
2. **内嵌按钮**：输入框内部若嵌了按钮，按钮圆角与输入框一致，`top/right/bottom: 4px`
   贴边（`.search-field` + `.search-btn`），两条弧线贴合。只有这种搜索框需要
   右侧留白，故 `padding-right: 80px` 挂在 `.search-field .search-input` 上，
   **不挂在共用类上** —— 否则没按钮的那几处会凭空多出 80px 空隙。
3. **不要另抄一份**：`.search-input` 是跨页共用类（博客 / 剪贴板 / 工具 / 投票），
   `.form-control` 是表单通用类。**改它们就是改全站**，别在页面样式里重声明。

> ⚠️ 聚焦态永远不要用 `border` 表达：常态是 `border: none`，聚焦改成边框会让字段
> 随焦点撑高、失焦瞬间塌缩，整张表单下方内容位移，点按中的 checkbox/按钮会被「挪走」。
> 用 `box-shadow`（不参与布局）。

## 5. 布局

- **容器**：`.container` 是正文的唯一容器，左右 **16px** padding、`margin: auto`，
  宽度走统一阶梯（`abstracts/_mixins.scss` 的 `site-width-ladder`）：
  **≥992px → 960px，≥1200px → 1140px**。顶栏 `.site-container`、页脚容器与
  `.content-wrapper`（历史名，9 个页面在用）引用**同一个 mixin**，四者左边缘对齐。

  > ⚠️ 加宽度前先看这条：`.container` 曾经**只在 ≥1200px 才生效**，992–1199px 区间
  > 正文是全幅的而顶栏已收到 960px —— 宽屏笔记本上正文比顶栏宽出一大截，
  > 是「各页边距看起来不一样」的主因。加任何新容器都走这个 mixin，别再写一套
  > `@media (min-width: 1200px) { max-width: 1140px }`（仓库里曾有四份拷贝）。

- **抬头带（hero）也要吃檐沟**：整幅铺满视口的抬头带里，内容必须再套一层
  `.container`（`.blogs-hero` / `.story-hero` 就是这么分层的）—— **别把宽度阶梯加到
  色带自己身上**，那会连色带一起收窄，页面顶部凭空短一截。
  底色透明的抬头带是例外：`.read-hero` 没有底色，直接把 `container-padding` +
  `site-width-ladder` 吃在自己身上即可。
  `/admin` 那一档的檐沟是 **20px**（= `.admin-container` 的值），抬头与它下面的内容列
  左边缘对齐。签到页 `.checkin-page` 只有檐沟、**没有**列宽上限（卡片仍按视口铺开），
  那是现有排版，别顺手「统一」成居中列。

  > ⚠️ 漏了这一层**不报错、不警告**，构建与单测都拦不住 —— 窄屏下标题与简介就那样
  > 贴着屏幕两条边。`tests/e2e/page-gutter.spec.ts` 按真视口量左边缘，盯着故事区
  > （含阅读页与互动小说页）/ 后台 / 文章编辑器 / 签到页各处的抬头与首屏内容。
  > 它断言的是**定值**（16，`/admin` 20）而不是「≥16」—— 20px 这种**多缩 4px** 的
  > 漂移同样是它要收的东西，`≥` 会放过去。

- **正文行宽上限 ≠ 页边距**：博客详情（`.blog-detail` 940px）与正文卡
  （`.blog-content-container` 900px）在容器**之内**再收一道，那是阅读行宽，别跟着
  容器一起拉宽 —— 拉到 1108 会让最长的文本页读起来更累，也会比博客首页自己的
  列表列还宽。页边距归 `.container`，行宽归这些内层上限。
  故事阅读页 / 互动小说页同理：`.story-reader` 820px、`.story-cattca` 720px 是行宽，
  檐沟各自 `@include m.container-padding`（它们**不是** `.container` 元素，别把
  宽度阶梯也加上去 —— 行宽上限已经比阶梯窄了）。
- **顶栏**：`.site-navbar` 固定顶部（`position: fixed; top:0`），高 62px，背景 `--color-background-card`，阴影 `--shadow-card-brand`。`body` 有 `padding-top: 62px` 补偿。
- **页脚**：`.site-footer`，背景卡片色 + 顶部分隔，内容容器同 1140px 体系。
- **后台**：`.admin-layout` 左侧 220px 固定侧边栏（移动端折叠成横向标签条）+ 右侧滚动内容区，内容容器最大 1400px。
- **栅格**：首页用 flex + `gap` 或 CSS Grid（`repeat(auto-fit, minmax(...))` / 显式 `repeat(3,1fr)`），**不用浮点栅格**。另有 `layout/_grid.scss` 与 `base/_forms.scss` 提供 Bootstrap 风格行/列工具。
- 页面骨架：`body { display:flex; flex-direction:column; height:100dvh; min-height:100dvh }` + `main { flex:1 0 auto }`，页脚始终贴底。

  > ⚠️ **量视口高度一律写 `dvh`，不要只写 `vh`**（保住老浏览器就先写一行 `vh`、
  > 下一行再写 `dvh`）。手机上 `vh` 量的是**地址栏收起时**的大视口，比眼前看得见的高度
  > 多出约一条地址栏；文档因此比可见区高 → 页面平白能上下滑，而一滑地址栏就收起、
  > 可见区随即变高，文档下沿之外露出**通栏一条底色**。
  > 讨论区是唯一「整屏工作台」（`body` 与 `.chat-page` 必须严丝合缝，见 §6.5），
  > 它对这个最敏感；其余页面只是白多出几十像素的滚动余量。

## 6. 组件风格要点

### 6.1 按钮（`components/_button.scss`）

> 2026-09 统一：此前同一套「品牌浅底 → hover 实底白字 → 按下压暗」的配方被抄了
> 至少五遍（`.upload-button`、`.search-btn`、`.button-primary(-small/-warning)`、
> `.blog-sort-btn`、十来个页面私有主按钮），改一处漏三处。现在只有三个 mixin。

**全站按钮只有三档**，定义在 `abstracts/_mixins.scss`：

| 档位 | mixin | 空闲 | hover | 按下 |
|------|-------|------|-------|------|
| **最高级** | `btn-primary` | 品牌浅底 + 品牌字 | 实底品牌色 + 白字 | `filter: brightness(.5)` |
| **次级** | `btn-secondary` | 无底色 + `--color-text-secondary` | = 最高级的**空闲**态 | = 最高级的 **hover** 态 |
| **切页 / 分类** | `btn-tab` | = 次级空闲态 | = 最高级空闲态 | **无变化** |

- 最高级的基准是博客首页的「创建」按钮（`.upload-button`）。统一的是**表面 + 交互**，
  不是尺寸 —— 各按钮保留自己的字号与内距。
- 次级三态递进（越靠近越显眼），所以它不会一上来就和主按钮争。
- `.button-*` 那一族只差尺寸与档位：`.button-primary`（16px / 10px 16px）、
  `.button-primary-small`（12px / 5px 10px）、`.button-secondary`（**次级档，
  尺寸同 `.button-primary`**）。同一排按钮要么共用一个尺寸，要么刻意一大一小 ——
  博客编辑页那排踩过：`.button-primary`（保存修改）边上挂着两颗
  `.button-primary-small`（取消 / 返回阅读页），三颗三种大小，读起来像三条互不相干的按钮。
  那两颗现走 `.button-secondary`，尺寸与「保存修改」逐像素一致，表面归次级档、
  不跟主按钮抢视线。
- 切页档：「当前所在页」常驻最高级空闲态，且**按下不叠加变化** —— 已经在的页面
  再点一下不该闪成实底。当前项挂 `.is-active`（`.active` 作为历史写法一并认，
  **新代码用 `.is-active`**）。落点：顶栏 `.site-link`、博客分类栏 `.category-link` /
  `.sub-category-link`、页码 `.page-link`、管理页的选中/未选中成对按钮、
  工具箱 `.filter-pill`、鱼干流水 `.filter-btn`。
- **任何一档都不做垂直位移**。hover/按下只改颜色；卡片 hover 也只提阴影
  （对齐 `.blog-item`），不 `translateY`。入场动画（`fadeInUp` / toast / 汉堡变形）
  与居中用的 transform 不受此限。
- Bootstrap 风格 fallback 族（`.btn` / `.btn-secondary` / `.btn-outline-*` /
  `.btn-danger` / `.btn-success` / `.btn-warning` / `.btn-info`）**全部改走令牌与这三个
  mixin**：`.btn-warning` 由琥珀改为站内唯一的警示色（黄那支是收藏夹专用，不外借），
  `.btn-info` 站内无语义、按层级归次级档。原先那些 `#0d6efd` / `#6c757d` / `#dc3545`
  写死值连同整块 `[data-theme="dark"]` 补丁一并删除（色值随令牌走，不需要补丁）。

> ⚠️ **唯一的有边框按钮是 `.btn--ghost`**，这是「无边框」总则的刻意例外：投票详情页
> 底部那几颗（「返回上页」等）在暗色下没有边框就只剩一行字。`tests/e2e/dark-theme.spec.ts`
> 断言的正是「暗色下这个按钮的边框必须非透明」—— 去掉边框会让用例失败，且确实是
> 可读性倒退。另一处保留的 `border-left` 是顶栏下拉的**箭头三角形**
> （`.site-user-dropdown-toggle::after`），那是 CSS 画的图形，不是设计元素。

> 写按钮样式前先看一眼有没有更具体的选择器会盖掉它，例如
> `pages/_tool-new.scss` 的 `.tool-new-card__footer .btn` 是 0-2-0，会压过全局 `.btn`
> 与 `.btn-primary` —— 那种地方必须自己 `@include` 同一套 mixin。

### 6.2 卡片

- 首页 `.feature-card`（「探索」区四张功能卡）：**空闲不托阴影也不描边**，只有
  卡片色背景 + 30px 圆角；**hover 才亮起光晕**。四张卡是页面主体内容、不是浮层，
  空闲就给阴影会让四块各自「浮」起来把首页切碎 —— 改成「指到哪儿哪儿才浮起来」。
  禁用态（专注模式）连 hover 也不给反馈。

  光晕是**卡片自己的颜色**，不是品牌蓝。每张卡只在 `.card-*` 上定义一次
  `--card-accent`（色相）与 `--card-glow`（同色系的 `-soft` 淡色），
  **图标、hover 光晕、卡内按钮三者都读这两个变量** ——

  | 卡 | `--card-accent` | 图标 mask |
  |----|-----------------|-----------|
  | `.card-story` | `--color-accent-blue` | `book.svg` |
  | `.card-blog` | `--color-accent-amber` | `journal-text.svg` |
  | `.card-tool` | `--color-accent-cyan` | `tools.svg` |
  | `.card-chat` | `--color-success-primary` | `chat-dots_new.svg` |

  > 改卡片颜色只需改 `.card-*` 那一行。⚠️ 别再让图标、光晕、按钮各自取色 ——
  > 那会做出「图标是琥珀的、光晕是蓝的、按钮还是品牌蓝」这种半拉子状态。
  > 卡内按钮因此由 `--card-accent` 驱动（`.feature-card .home-btn`，0-2-0 压过
  > `.home-btn--outline-*` 的 0-1-0），它自己那支 `--outline-*` 变体只在卡片之外
  > 单独使用时才生效。
- 卡内按钮的 hover 是**在同一支淡底上再叠一层同色**（12% → 约 23%）：
  `box-shadow: inset 0 0 0 999px var(--card-glow)`。两个刻意之处 ——
  ① 用 `inset box-shadow` 叠而**不是**换 `background`：`box-shadow` 参与过渡，
  换 `background-image` 的渐变是离散跳变，会硬闪一下；② 不走「转实底 + 白字」
  （那是最高级按钮的 hover 配方）：四张卡的色相里只有蓝压得住白字，琥珀 `#f59e0b`、
  青 `#06b6d4`、绿 `#10b981` 配白字的对比度都不到 2.6:1。同一套 hover 配方要在
  四张卡上都成立，所以统一「加深淡底」而不是「转实底」。
- 管理后台 `.admin-stat-card`：用**卡片淡底 + 数字同色**区分类型（blue/green/amber/
  purple/red）。原先靠左侧 4px 彩色竖条，已按「无左侧边框」总则去掉；色值也从写死的
  hex 换成了令牌（站内没有紫色语义令牌，purple 与 blue 合并到品牌色系）。

### 6.3 表单控件（`components/_form-controls.scss`）

- `.form-control`：**无边框** + `--color-background-page` 底 + 聚焦 `--shadow-focus-brand`；
  圆角按元素分 —— `input.form-control` / `select.form-control` 胶囊，
  `textarea.form-control` 20px。判据见 §4.2。
- `.form-control-sm`：紧凑变体（管理页在用）。
- ⚠️ 这里原有两处 `!important`（`color` 与 `background-color`）。它们会压掉组件自己的
  `:focus` 背景切换 —— **作者重要性高于作者普通声明，与特异性无关** ——
  所以「聚焦时换成卡片底色」这条一直**是死代码**。现已去掉：与搜索框一致，
  聚焦只加光晕、不换底。今后也不要在这里加 `!important`，它会静默吃掉所有聚焦态与
  变体色。
- `.form-select` / `select.form-control`：与 `.form-control` **同一套外观**（无边框、
  `--color-background-page` 底、胶囊圆角、聚焦光晕）。**不再是「品牌底 + 品牌字 + 粗体」**
  ——那是「最高级按钮」的样子，`<select>` 属于字段而不是按钮。
- **展开后的列表（原生弹出层）要自己上色**：`option` / `optgroup` 显式给
  `--color-background-card` 底 + `--color-text-primary` 字。条目的字色本来就从 `<select>`
  继承（暗色下是近白），而**底色由浏览器/系统决定**；两者不一致时展开就是白底白字，
  看起来像「没适配夜间模式」，且不报错。`color-scheme` 只管浏览器画那一层的**明暗基准**
  （见 §8），不足以保证底色与字色配对，所以这两条不能删。高亮行仍由浏览器自己画。
- `.form-check-input`：圆形 checkbox，选中变品牌色。
- 校验态：`.is-invalid` + `.invalid-feedback`（红色）。
- **文件选择器**（`components/_file-picker.scss`，`.filepick` 一族）：这套类**在 `.tsx` 里
  一个都搜不到** —— 那 DOM 是 `public/static/js/core/base.js` 的 `enhanceFileInputs`
  运行时注入的（把页面上写着的原生 `<input type="file">` 包进 `.filepick`，再补一颗
  「选择文件」label、一个文件名 span、一个清除钮）。改样式别去 tsx 里找调用点。
  两条不能删的：
  ① **原生 input 必须视觉隐藏**（`.filepick input[type="file"]` 的 sr-only）。
     不隐藏就会有**两套控件同屏**：浏览器自带的「选择文件 / 未选择文件」和注入的
     label + span。隐藏也不能改用 `hidden` 属性或 `display:none` —— base.js 正是靠
     `hasAttribute('hidden') || style.display === 'none'` 判断「这个已被自定义 UI 接管，
     别再包一层」（图床拖拽区、讨论输入区走这条早退）。
  ② 内嵌按钮走 `btn-primary` mixin（对齐 `.search-btn` 的「字段内主操作」档位），
     几何照 §4.2 第 2 条：圆角与字段一致、四边贴边 4px。**别在这里另抄一份按钮样式。**
  两个守卫盯着：样式侧是 `tests/unit/css-js-classes.test.ts`（JS 注入的类名必须有定义），
  行为侧是 `tests/unit/base-js-filepick.test.ts`（含「客户端路由跳转后插入的 input 也要
  被增强」—— Next 的 `<Link>` 不重载文档，只在 init 时跑一次是不够的）。

### 6.4 弹窗 / Toast / 分页 / 告警

- `.modal`：居中遮罩（`rgba(0,0,0,.5)`），内容 500px 宽、30px 圆角、`--shadow-card-brand`。
- `.toast`：右上角 360px 栈，深色底白字，按类型着色（success/error/info/warning）。
- `.pagination`：居中，`.page-link` 走**切页档**（无底色胶囊；当前页品牌浅底 + 品牌字，
  按下不叠加变化）。`.page-input`（跳页框）单行 → 胶囊。
  原先每页都带 1px 描边、6px 圆角，当前页是品牌实底白字（那是最高级的 hover 态）。
- `.alert`：Bootstrap 风格 4 色 + `body.dark-mode` 适配。

### 6.5 讨论页（`pages/_chat.scss`）

`/chat` 是双栏工作台，页面高度 `calc(100dvh - 62px)`（`vh` 兜底）、`overflow: hidden`，色板全部走 CSS 变量随明暗主题：

- 会话侧栏 `.chat-sidebar`：固定 280px，会话项 `.chat-chan`（头像 / 标题 / 预览 / 未读徽标 / 删除），头部 `.chat-sidebar__head` 带折叠钮 —— `.chat-page--collapsed` 时收到 60px 只留图标。
  - **选中项只有「整行品牌淡底」这一种表达**（`.chat-chan.is-active`）。它原先还带一条
    `box-shadow: inset 3px 0 0 品牌色` —— 那是伪装的 `border-left: 3px`，全站清左侧竖条时
    漏掉了（按 `border-left` 搜是搜不到的）。折叠态则改用头像外一圈 3px 品牌描边
    （60px 轨道里整行淡底会被头像占满、读不出来）。
  - 同理，`@` 到我那条消息（`.chat-msg__content--mention`）用的是**品牌淡底 + 同色描边**，
    不再是竖条（它原先左右各有一条镜像竖条，方向跟着气泡走 —— 一起删掉了，只删一边会不对称）。
- 消息主区 `.chat-main`：头部标题 + 操作；消息气泡 `.chat-msg`（自己发的加 `.chat-msg--mine`），含作者名 / 时间 / 操作 / 图片 / 引用回复 / 已删占位 `.chat-msg__deleted`。
  - 同人连续发言：**只有这一串的第一条**画时间 / 作者名 / 头像，后续几条加
    `.chat-msg--grouped` 省略它们，两条气泡**挨在一起**（间距 3px，视觉上并成一簇）。
    判据（距这一串的第一条 ≤5 分钟，即 `CHAT_GROUP_WINDOW_MS`；换人 / 跨自然日 /
    拍一拍都断开）在 `src/app/chat/ChatMessageItem.tsx` 的 `markGroupedMessages` ——
    **别在渲染层另算一套**。
  - **能挨在一起的前提：后继消息的表头行整行退出了文档流**（`.chat-msg--grouped
    .chat-msg__meta { position: absolute }`），挂到气泡**外侧**（别人的在右、自己的
    在左，都对齐顶边）。它在流里时要占 17px 行高 + 4px 间距，光靠负外边距最多把两条
    气泡的距离从 27px 收到 21px，怎么调都贴不上；而浮在气泡**上**会盖住正文
    （气泡是 fit-content 宽度，「回复 删除」能占掉短气泡的一半）。同理，那 8px 让位
    用的是 `padding` 而不是 `margin` —— 浮层的 box 边缘必须贴着气泡边缘，否则指针
    从气泡移向按钮的途中会落进一段空隙，`:hover` 中断、按钮够不着。
  - 三处隐藏方式**刻意不同**，改动前先看清各自为什么：头像 `opacity: 0`（它是
    「拍一拍 / @ta / 主页」的入口，藏了也**要能点**，悬停淡入；触屏没有 hover，故
    `@media (hover: none)` 下常显）；作者名与时间 `display: none`（不可交互；
    整行已不在文档流里，「保住行高免得顶下去」这层顾虑随之消失，而**留着它们反而
    会占宽** —— `visibility: hidden` 的元素仍参与排版，会把浮层凭空撑宽六七十 px，
    把 `overflow-y: auto` 的列表撑出横向滚动条。私聊的已读回执与它们在**同一行**，
    所以跟着一起挂到气泡外侧，照常显示）。
- 输入条 `.chat-composer`：附件条（回复 / 引用博客 / 待发图片）+ 面板（工具条 `.chat-composer__icon-btn` → 输入框 `.chat-composer__input` → 底条：提示 `.chat-composer__hint` + 发送 `.chat-composer__send`）。样式与评论区**共用** `components/_composer.scss` 的 `rich-composer($p)` mixin，组件也是同一个 `RichComposer`（`className` 注入 BEM 前缀，见 §11.1）。
- 发起私聊弹窗 `.chat-new-modal`：搜索框 `.chat-new-search` + 结果项 `.chat-new-item`（头像 / 昵称 / 角色 / 自己标记）。
- 响应式：`≤900px` 时侧栏变抽屉，`.chat-page--drawer-open` 展开。

### 6.6 博客列表排序工具栏（`pages/blog/_menu.scss`）

`/blog` 列表顶部的「发布时间 / 更新时间」切换（组件 `src/app/blog/BlogSort.tsx`）：

- `.blog-sort`：容器，列表区顶部右对齐一行（`justify-content: flex-end`），**空结果态也渲染**（要挂载客户端恢复 effect）。
- 它现在是一个**胶囊滑块**（`.segmented`，见 §6.8）—— 切换时滑块有 0.25s 的移动反馈。
  按钮尺寸写在 `.blog-sort .segmented__btn`，几何与动画来自 `components/_segmented.scss`。
- 可访问性：容器 `role="group"` + `aria-label`，按钮 `type="button"` + `aria-pressed`。
  ⚠️ **不要改成 `role="tab"`**：`tests/e2e/blog.spec.ts` 用
  `getByRole('button', { name: '更新时间' })` 定位，`tab` 角色会覆盖按钮角色，
  那条用例会直接失配。

> ⚠️ 桌面端（≥992px）`.blog-sort` 是**绝对定位**参与一条「停放带」：hero 的底 padding
> 10 + `.blog-layout` 的 margin-top 60 拼出停放空间，滑块 `top: -52px` 落在其中。
> 它**顶部锚定**，变高只会向下长进首篇博客上方那 24px 余量里。**不要为了「重新居中」
> 把 `top` 往上调** —— 那会撞进 hero 色块（`_menu.scss` 的注释记的正是这个坑）。

### 6.7 文章详情页读者交互区（`pages/blog/_blog.scss` + `pages/_favorite.scss`）

`.read-controls` 两行：第一行 **点赞 / 投喂 / 收藏**，第二行 返回上页 / 管理文章。
三颗状态色都走「**未激活跟随 `currentColor`，激活才上色**」的同一套手法，别让任何一颗常亮：

- `.like-btn` → `.liked` 红（`--color-warning-*`）；`.fish-btn` → `.fish-btn--fed` 绿（`--color-success-*`）；
  `.favorite-btn` → `.favorited` 黄（`--color-star-*`）。
- ⚠️ 星标曾经**恒亮**（给 `.icon-star-fill` 直接写死 `background-color`），后果是三颗里
  只有它一直有颜色，「已收藏」反而看不出来。**不要**再给 `.icon-star-fill` 加 `background-color` ——
  `.icon` 的机制就是 `background-color: currentColor`，颜色只由按钮的 `color` 决定（§7）。
- 收藏按钮**没有计数徽标**（点赞/投喂有）：站内不显示一篇文章的被收藏数。

**窄屏（≤768px）三颗收成三个 44px 圆钮**，压在同一行、不许换行
（`flex-wrap: nowrap` + `flex: 0 0 44px` + `max-width: 24rem`；横向交给
`justify-content: space-evenly` —— 定宽之后不能再平分轨道宽度，**正圆要求宽 = 高**）：

- **文字标签隐藏**（`> span:not([class])` —— 计数徽标也是 `span`，但它带类名，正好被排除）。
  一排字换成一列之后，320px 档也宽松得很，原先 `<360px` 那条「退回按内容宽度 + 允许换行」
  的兜底连同它的前提（文字宽度 339px 塞不下）一并删了。
- **计数落在圆钮外面、正下方居中**：44px 见方的圆钮里再挤一行数字，圆就不成圆了。
  所以 `.like-count-badge` / `.fish-count-badge` 走 `position: absolute` +
  `top: calc(100% + 4px)` + `left: 50%`/`translateX(-50%)` —— DOM 不动
  （仍是按钮的孩子，点数字照样触发按钮），也不占布局位置，因此**按钮自己还是 44px**。
  那 4px 是数字离圆底的一口气（贴 `top: 100%` 时数字上沿紧挨圆边，像溢出来的）；
  字号 `0.85rem`（与桌面端徽标同号，不再是窄屏专属的 `0.7rem`）。
  行上必须留 `padding-bottom: 20px` 接住「4px 间隙 + 数字行高」，
  否则那行数字会压到下一行「返回上页 / 管理文章」。图标放大一档（1rem → 1.25rem）。
- ⚠️ **高度由 `.read-controls__row` 的 `min-height: 44px` 钉死，两个断点共用**，
  窄屏再补一个 `height: 44px` 把正圆坐实。桌面端它由内容撑出（点赞/投喂 ≈44.3px、
  收藏 41.0px —— 徽标比文字行高）；两边各写各的高度就会在断点前后跳一下（用户报的就是它）。
  窄屏那条里**不要再写 `padding` / `font-size` 的整体缩放**，那正是原来会变矮的原因。
- 这条**不能只看代码**：`tests/e2e/favorite-layout.spec.ts` 用真视口断几何，并登记在
  `playwright.config.ts` 的 `RESPONSIVE_SPECS` 里（desktop 那一遍同样要跑）。
  其中「窄屏高度 = 桌面高度」那条要在**同一个用例里换视口量两次**，且必须
  **先 `setViewportSize` 再 `goto`** —— 三颗都带 `transition: all .3s ease`，
  先加载再改视口会量到过渡起点的值（桌面端的），于是这个 bug 永远量不出来。

收藏夹选择器弹窗（`.favorite-picker__*`）：**名称独占一行，两颗创建按钮并排在下一行**
（`.favorite-picker__new-actions`，`flex: 1 1 0` 等宽）。三者挤一行时「创建公开」会被挤到
第二行，而两颗按钮代表的是**对等的两种性质**（创建后不可改），分行会被读成「公开是次要的」。
`<360px` 退回上下堆叠。`/favorite` 页的创建/导入条复用同一组类。

正文里的收藏夹卡片（`.favorite-embed`，HTML 由 `src/lib/favorite-refs.ts` 的
`buildFavoriteCardHtml` 直接产出）**与投票嵌入卡 `.vote-embed-widget` 同一副面孔**：
`--color-background-card` 底 + 1px `--color-border` 描边。它先后用过「左侧金色竖条」与
「`--color-star-secondary` 星色淡底」两种身份提示：前者违反 §11 第 8 条（无左侧边框），
后者让**正文里整块发黄** —— 星色是「已收藏」的状态色（§2.1 写明它只在该处与 hover 时用），
拿它当一整段正文的背景，读起来像那段内容被整个标记了。嵌入块靠**形状**（圆角 + 描边 +
内距）与正文分开，不靠色相。

#### 评论区的两条几何契约

楼中楼的缩进是「DOM 嵌套 + 同一条 `.comment-list` 规则重复生效」叠出来的：React 侧
**完全不知道深度**（`CommentItem` 不收 depth，服务端也没有层数上限），所以纵向与横向各有一条
必须成立的契约，由 `tests/e2e/comment-layout.spec.ts` 的**两条**用例分别钉住
（3 层：什么都不许溢出；20 层：只有顶层列表可以溢出且必须能滚）。

- **纵向 —— 末尾空白不许随层数累加。** 有楼中楼的评论 `padding-bottom: 0`、嵌套列表
  `margin-bottom: 0`（`.comment-item:has(> .comment-list)` / `.comment-item > .comment-list`）。
  否则每一层要付两次账：父级内距 18 + 内层列表下距 15 —— 父级的 padding 挡住外边距折叠、
  子级的下外边距又算进父级的 auto 高度，两者是**相加**而非取大者：每深一层多 33px，
  3 层实测末尾空出 **66px**（与「根评论 → 根评论」的 0 相比就是用户报的那一大段空）。
  归零后任何层数都只剩最深那一层自己的 18px。
  ⚠️ 这是本仓**第一条实际生效的 `:has()`**（§12 里那条 `@supports not (selector(:has(*)))`
  是没了对手的孤儿）；**刻意不写降级规则** —— 不支持时退回的正是改动前的间距，只是没修好
  而已，没有比现状更好的「降级样式」可写。
- **横向 —— 深层评论不许被挤成一个字宽。** `.comment-item { min-width: 240px }` **必须固定
  px**（写 `min(240px, 100%)` 会随可用宽度一起缩 = 等于没设），缩进每层 15px、窄屏 8px
  （窄屏压缩见下面的媒体查询）。可用宽度 = 容器宽 − 缩进 × (层数−1)：不设地板的话 390px
  手机上第 44 层只剩 14px（一行一个字）；设了之后窄屏第 16 层踩到地板，再深就交给滚动。
  240 的依据：评论里**不能换行**的最宽一行是 `.actions` 的 flex 行（§6.1，没写 `flex-wrap`
  ⇒ 点赞胶囊 ≈54 + 间距 10 + 回复 ≈46 + 间距 10 + 删除 ≈46 ≈ 166px，计数三位数时 ≈186px），
  且必须低于最窄的容器（320px 屏 → 288px），否则根评论自己就会顶出横条。
- **溢出只许由 `.comment-section > .comment-list` 接住**（`overflow-x: auto`）。中间层必须
  保持 `visible`，否则**每层各画一条横条**；`.blog-detail` 与 `documentElement` 都不许出现
  横向滚动条。⚠️ 那条 `overflow-x` 必须带 `.comment-section >` 限定 —— 嵌套列表复用的是
  同一个 `.comment-list` 类名。
- ⚠️ **横条画在整片评论区的底部**：列表多高它就在多低处，鼠标用户要滚到列表底下才够得着
  （触屏 / 触控板 / shift 滚轮在列表内任意位置可用）。这是「整片只给一条横条」的固有代价，
  不是 bug —— 想改成随手可及就得把列表关进固定高度的内滚容器，那是另一套版式。

### 6.8 胶囊滑块（`components/_segmented.scss`）

一条会滑动的胶囊轨道：容器 `.segmented` + 滑块 `.segmented__thumb` + 按钮
`.segmented__btn`。位移由 CSS 算，组件只传两个变量（React 的 `style` 即可）：

```tsx
<div className="segmented" style={{ '--seg-i': idx, '--seg-n': count } as CSSProperties}>
  <span className="segmented__thumb" aria-hidden="true" />
  <button className="segmented__btn is-active" aria-pressed>…</button>
  …
</div>
```

> 用 `:has()` 也能做，但那样还得再写一遍 `@supports not` 的降级样式。传变量既没有
> 兼容问题，也让「第 i 格 × 一格宽」这段几何只有一处。

#### 什么时候用 —— **只有「2 选 1 的互斥视图切换」**

判据一句话：**这块滑块代表同一个视图的两种呈现。** 目前全站只有两处：

| 落点 | 组件 | ARIA |
|------|------|------|
| 博客列表「发布时间 / 更新时间」 | `src/app/blog/BlogSort.tsx` | `role="group"` + `aria-pressed` |
| 个人主页「文章 / 评论」 | `src/app/u/[id]/ProfileTabs.tsx` | `role="tablist"` / `role="tab"` + `aria-selected` |

视觉共用，**语义各按各的** —— 前者是一组互斥开关，后者在切换面板。

#### 什么时候**不要**用

⚠️ 这不是通用分段控件。**别顺手往这些地方套**：

- **工具箱的分类筛选** —— N 选 1，选项数量不定，滑块宽度会被摊薄成一条细缝。
  它是「切页档」的 `.filter-pill`。
- **`.action-button` 那类互斥按钮** —— 语义是「执行一个动作」，不是「换一种看法」。
- **设置页的开关** —— 那是 `input[type=checkbox]` 做的 switch，不是分段选择。
- **鱼干流水的收支筛选** —— 同第一条，用切页档。

滥用会让「滑块 = 换个角度看同一份内容」这层意思失效，而它正是这个控件唯一的价值。
但凡**选项可能变多**，或者**点下去会提交/执行什么**，就该用按钮而不是滑块。

#### 几何约束

- 按钮**必须等宽**（`flex: 1 1 0`）—— 滑块按「第 i 格 × 一格宽」定位，不等宽就错位。
  个人主页两个页签的文字自带计数（「文章 (3)」「评论 (5)」）本来宽度不同，
  等宽后各占一半，是刻意的。
- **未选中项在任何状态下都是灰字**（`--color-text-secondary`），**没有 hover 换色** ——
  这不是漏写：① 触屏上浏览器会把最后一次点按的 `:hover` 留在元素上，hover 改色会让
  「刚点过的那一项」一直亮着品牌蓝，像同时选中了两个；② 滑块本身已经在回答「选中哪个」，
  指针划过再变蓝等于把这层意思分给了两个状态。次级 → 最高级空闲态那套递进留给按钮档。
- `prefers-reduced-motion: reduce` 下关掉过渡。

## 7. 图标方案

**不用图标字体 / icon 库**，采用「SVG + CSS mask」：`components/_icons.scss` 定义 `.icon` 基类，用 `mask-image` 引用 `public/static/img/icons/*.svg`，颜色跟随 `currentColor`（即继承 `color`），天然适配亮/暗主题。

- 常用类：`.icon-bell`、`.icon-gear`、`.icon-person`、`.icon-house`、`.icon-fish`、`.icon-theme-toggle`、`.icon-book/controller/journal-text/tools`（首页四大入口）等。
- 首页卡片的 `feature-icon` / `__icon` 用同一手法，给不同卡片指定不同 `color` 形成彩色图标（无需多色 SVG）。
- 新增图标：放一个单色 SVG 到 `public/static/img/icons/`，在 SCSS 里加一条 mask 规则即可。
- **例外：自带配色的多色图标不走 mask。** mask 是单色模板（只取形状，颜色一律来自
  `currentColor`），所以**填充色与描边色必须分开**的图标套不进这条约定 —— 例如「白填充 +
  深描边」才立得住的主体，mask 会把这一层信息抹平。这类素材直接放
  `public/static/img/` 下，用 `<img>` 引用，配色烤在 SVG 里。
  第三方素材还要在同目录留一份 `LICENSE.txt`（先例：
  `public/static/vditor/dist/js/mathjax/LICENSE`）。

## 8. 主题切换机制

- 主题状态存 `localStorage['theme']`，取 `light` / `dark`，未设置时跟随 `prefers-color-scheme`。
- `src/app/layout.tsx` 内联一段防闪烁脚本，在 CSS 加载前就根据 localStorage/系统偏好设好 `<html data-theme>`。
- 交互切换在 `public/static/js/core/base.js`：`switchTheme()` 设置 `data-theme` 属性并写 localStorage，主题按钮点击切换 + 图标旋转动画。
- **深色适配**：所有组件用 CSS 变量即可自动适配，新代码一律走 `[data-theme="dark"]`
  或纯变量。`body.dark-mode` 那套旧写法已全部清除（含 `pages/_tool-new.scss` 里一套
  永不生效的第二配色与 `pages/blog/_blog.scss` 注释掉的旧令牌表）—— 全站只认
  `<html data-theme>`，没有任何代码会给 `body` 加 `.dark-mode`。
- **`color-scheme`**：两个主题块里各写一行（`base/_root.scss`）。它是「原生控件
  跟着页面明暗走」的开关 —— 缺了它，暗色主题下 Chrome 照样按浅色画滚动条、
  `<select>` 下拉、日期选择器与 canvas 底色。**它管的不是样式，是浏览器自己画的那一层。**
- ⚠️ **但 `color-scheme` 不是「原生控件一定好看」的保证，别拿它当唯一手段。**
  `<select>` 展开后的列表就是反例：条目字色继承页面（暗色下近白），底色却由
  浏览器/系统拍板 —— 不保证跟着页面的 `color-scheme` 走，于是白底白字。
  凡是「字色我们能定、底色我们不能定」的原生层，都要像 §6.3 那样把两层一起钉死，
  不能只留一行 `color-scheme`。
- **滚动条**：`base/_root.scss` 里一组全局 `::-webkit-scrollbar`（10px 轨道、
  `--color-text-secondary` 的 thumb、hover 变品牌蓝、2px 透明描边 + `background-clip:
  padding-box` 让视觉上是 6px 细条而手感仍是 10px）。**刻意不写 `scrollbar-color` /
  `scrollbar-width`** —— 按规范它们一旦生效就会让 `::-webkit-scrollbar` 整族失效
  （Chrome 121+ 已支持），圆角与 hover 都没了；不写的代价是 Firefox 只得 `color-scheme`
  那层的原生暗色条，而它已经满足「跟着主题走」。

## 9. 响应式断点

`abstracts/_breakpoints.scss`：

| 断点 | 值 | 用途 |
|------|-----|------|
| `$bp-sm` | 576px | 小屏 |
| `$bp-md` | 768px | 平板 / 移动折叠、栅格两列 |
| `$bp-lg` | 992px | 容器收窄、栅格多列 |
| `$bp-xl` | 1200px | 容器 1140px、栅格满列 |

写法：`@include bp.up($bp-lg)`（min-width）/ `@include bp.down($bp-md)`（max-width）。页面内也常见直接裸写 `@media (min-width: ...)`。移动端优先折叠导航（808px）、栅格降列、标题与字号降级。

## 10. 动画

- 过渡统一 `transition: all 0.2s–0.3s ease`。
- `@keyframes pulse`（红点/签到绿点通知闪烁，2s 无限）。
- `@keyframes fadeInUp`（首页卡片入场）。
- hover 微交互：卡片升阴影、图标 `scale(1.1)`、按钮反转前景背景。
  **按钮不做垂直位移**（见 §6.1）；入场动画与居中用的 `translateY` 不受限。

## 11. 新页面 / 新功能样式约定

1. 主题色一律用 `_root.scss` 的 CSS 变量，别写死色值。
2. 圆角 / 间距 / 阴影复用 2.4 节的令牌，别自造一套。
3. 改 SCSS 直接改源文件就行，**没有产物要提交** —— dev 走 HMR，build 由 Next 编译。
4. 图标优先复用 `public/static/img/icons/` 现成 SVG + mask 方案，别引 icon 库。
5. 组件优先复用现有 `.button-*`、`.card`、`.form-control` 等类名，少写一次性样式。
   **按钮与输入框一律引 mixin / 既有类，不要另抄一份**：按钮是
   `@include m.btn-primary`（或 `btn-secondary` / `btn-tab`，见 §6.1），
   字段是 `.form-control`（或 `input.form-control` / `textarea.form-control` 的圆角，
   见 §4.2）。这两样是全站最容易 drift 的地方 —— 抄一份的代价不是重复代码，
   是「同一个按钮在两页长得不一样」，而这类不一致没人会当成 bug 报上来。
6. 响应式：从 `up(992px)` 多列 → `up(768px)` 两列 → 单列，字号同步降级。
7. 深色主题检查：切到 `data-theme="dark"` 看一眼对比度（品牌色已选更亮的 `#23A5FF`）。
8. **不留「左侧边框」做装饰**：容器已经是大圆角，边上再压一条 3–4px 竖条，弧线会被
   切掉一截 —— 那是两套形状语言的混搭。表达「这是哪一类/已选中」用**淡底 + 同色字**。
   两个例外：正文渲染出的 `blockquote`（内容语义，Markdown 通行约定）、
   CSS 画的箭头三角形。同理，卡片 hover 只提阴影，不做垂直位移。
   ⚠️ **这类竖条不一定写成 `border-left`** —— 讨论区侧栏的选中项与 `@` 我到的消息
   那两处都是 `box-shadow: inset 3px 0 0 品牌色`（伪装的左边框）。清的时候要按
   「`box-shadow` 里带 `inset` 且 x 偏移为正」搜，只搜 `border-left` 一定漏。
   还有一处必须连镜像一起删（`@` 提及那条右对齐时竖条翻到右边，只删一半会左右不对称）。
9. **不留幽灵变量**：写 `var(--x)` 前确认 `base/_root.scss` 里真的有 `x`。变量不存在时
   整条声明在计算值阶段失效（退回 `unset`），**不报错** —— 历史上有过
   `--color-brand-primary-rgb`（聚焦环整个不存在）、`--color-bg-primary`（角标边框没了）、
   `--r-pill`（403 页按钮一直是直角）、`--box-bg` / `--text` / `--muted-color`
   三兄弟（规则整条失效）以及一个拼错的 `--color-background-card-unrend`
   （浅色未读底色从未生效）—— 全是静默的，只有肉眼能发现。

### 11.1 跨场景复用的样式写成带前缀的 mixin

同一套视觉用在两处（且两处的 BEM 前缀不同）时，**不要复制一份**，写成参数化 mixin，
两边各 `@include` 一次：

| 组件 | mixin | 用处 |
|------|-------|------|
| 富文本输入区 | `components/_composer.scss` → `rich-composer($p)` | 讨论 `chat-composer` / 评论 `comment-composer` |
| Markdown 正文块级元素 | `components/_markdown-body.scss` → `rich-markdown($cls)` | 讨论 `chat-msg__md` / 评论 `comment-content__md` |

复制一份的代价不是重复代码，是**必然 drift** —— 用户会看到「列表在讨论里长这样、在评论里
长那样」，而这类不一致没有人会当成 bug 报上来。React 侧同理：`RichComposer` 的 BEM 前缀
由 `className` 注入（见组件文件头）。

⚠️ 改这类共享样式后，两处**都要**在页面上看一眼 —— 单测与构建都拦不住「另一边被改花了」。

⚠️ 选择器权重陷阱：删掉旧样式时要确认新规则不会被更具体的老选择器盖掉。真实踩过：
`.comment-form textarea`（0-1-1）权重高于 `.comment-composer__input`（0-1-0），不删旧规则
就会把面板内的透明输入框重新涂成卡片底色，从外面看是一个突兀的色块。

⚠️ **正文里的通用 `.类 img` 会漏进每一个内联元素**（2026-09 踩第三次）：那条规则是给
「正文流里的图床图」写的（整行独占、描边、圆角 8px、不透明底色、`cursor: zoom-in`），
可它是**后代**选择器 —— 正文里所有内联引用（表情包 / 黄脸 / 用户名片）都在射程内，而每
一处自己的规则通常只声明尺寸，**其余几条会原样漏进来**。三个受害者里名片最惨：框贴图
的画布中心是透明的，漏进来的不透明底色把它**连头像一起盖住**，页面上只是个灰方块。
所以：**新增任何一种内联引用，都要为它逐条清零**（`margin` / `border` / `border-radius`
/ `background` / `cursor`），并在那一处写清为什么。表情那两档是现成的样板。

## 12. 已知遗留 / 注意事项

- `abstracts/_theme-map.scss` 的 light map 与 `themeify` mixin 已停用，不要基于它扩展。
- `utilities/_text.scss` 里 `.u-text-muted` / `.text-primary` / `.text-danger` 等工具类
  带 `!important` 的 `color`，会盖掉**任何**组件颜色规则。给带这些类的元素写按钮态
  时要留意。
- 表单控件里另有两处 `!important` 是刻意保留的（`.form-check-label a` 等），改动前先确认。

**刻意保留的写死色**（不是遗留，别「顺手」改掉）：

- 首页 `.hero-section` 的深色渐变（`#1f2937 → #111827` + 白字）—— 明暗两套主题下
  刻意保持一致的主视觉，改用令牌会让它在浅色主题下变浅底、与白字打架。
- 403 页的彩虹色相循环（`pages/_error.scss` 的 `.rainbow-error__bg`）—— 同理，
  它不是主题表面。
- 设置页开关的圆钮 `background: #fff`（`pages/_settings.scss` 的
  `.settings-toggle__slider::before`）—— 它**在两个主题下都必须是白的**（开关就长这样），
  换 `--color-background-card` 会让暗色主题的钮跟着变深、压在 `--color-border` 的轨道上
  反而消失。可读性由那圈 `0 1px 3px` 阴影兜住。
- 画报（`src/lib/poster.ts`）与 identicon（`src/lib/identicon.ts`）里的配色 —— 输出的是
  **图片**，不参与 `data-theme`。代价是它们各有一份色板副本，改品牌色时不会跟着变。
- 各处**实底按钮/角标上的 `color: #fff`** —— 那是「实底 + 白字」配方的一部分，
  两套主题下都成立（约 40 处，逐一核过）。

**同类陷阱（已登记，还没踩）**：

**同名嵌套（组件根复用了页面级容器类）** —— 与 `.blog-detail` 同一个形状。
判据：该组件被渲染在任何**已经带同名类**的父节点里时，就会双份内缩 / 双份外边距。
下列四条目前的状态各不相同，改之前先按判据自己走一遍 DOM：

- `src/app/clipboard/upload/UploadForm.tsx` 的根节点 = `clipboard-page` + `clipboard-title`，
  而 `clipboard/upload/page.tsx` 与 `clipboard/[id]/edit/page.tsx` **也**各自套了一层
  `clipboard-page` → 双份 `padding: 24px 16px` + 双重宽度阶梯。upload 页更严重：
  页面与组件各渲染一个 `<h1 class="clipboard-title">上传云剪贴板</h1>`，**同一页两个
  内容相同的主标题**（a11y / SEO 硬伤；edit 页因 `isEdit` 分支不同文案而不重复）。
  修法：组件根去掉这两个类，由两个页面各自提供外壳。
- `src/app/admin/oauth/ApplicationRow.tsx` 的根节点 = `management-card`，而
  `admin/oauth/page.tsx` 把它渲染在 `<section className="management-card">` **里面** →
  卡中卡：双 30px padding、双描边、双底色。`pages/_oauth.scss` 的
  `.management-card + .management-card { margin-top: 0 }` 只是把兄弟行之间的
  `margin-top: 20px` 压掉，压不住卡壳本身。
- `src/app/components/AdminArticlesManager.tsx` 的根节点 = `admin-container`（页面级容器：
  `max-width: 1400px; margin: 32px auto; padding: 0 20px`）。**当前没爆**，纯属
  `admin/blogs/page.tsx` 自己没写容器、由组件提供。一旦它被放进任何一个已有
  `admin-container` 的 admin 页（另外 6 个都写了）立刻复现。这也与 §5 那条「页边距归容器、
  行宽归内层上限」相悖 —— 容器该上提到 `admin/blogs/page.tsx`。
- `src/app/fish/PayError.tsx` 的根节点 = `content-wrapper` + `page-title`（整页外壳）。
  **当前不冲突**：它只出现在 `fish/pay` 与 `fish/collect` 的参数非法 early-return 分支，
  与正常分支的 `content-wrapper` 不会同时渲染。但 `pages/_notifications.scss` 的注释
  专门警告过 `.content-wrapper` 的后代选择器会随类名漂移，属同一类债。

**同名不同义（两处定义指的是两回事）**：

- `pages/admin/_articles.scss` 的 `.current-category`（后台文章表格里的**分类徽章**：
  `padding` / `radius 20px` / 配 `.is-categorized` 换色）与 `pages/blog/_menu.scss` 的
  同名类（博客分类栏的**「当前分类」标签**，只写 `margin-top: 12px`）都是根级 0-1-0，
  互不知情。唯一消费方是 `AdminArticlesManager.tsx`（徽章那份），于是徽章白拿
  `margin-top: 12px`。另见上面 `.current-category .badge` 那条死规则。
- `.copy-btn`（`pages/blog/_blog.scss` 根级全局 vs `pages/_story.scss` 在
  `.story-reader__content` 下整套重写）：注入点是 `components/MarkdownRenderer.tsx`
  拼的内联 HTML 字符串，所以**任何**用了 MarkdownRenderer 的页面都会命中 blog 那份。
  story 页目前靠 0-2-0 压 0-1-0 才没走样 —— 改 `_blog.scss` 里那条的权重就会穿透。
- `.filter-btn`（`pages/_fish.scss` vs `pages/_notifications.scss`）：**后者一个属性都没
  生效**（`main.scss` 里 notifications 先于 fish 加载，fish 全胜），而通知页压根没有
  筛选栏 —— 唯一消费方是 `fish/transactions`。改 `_notifications.scss` 那份是静默无效的。
- `.notification-card`（`pages/_notifications.scss` 的 `.content-wrapper .notification-card`
  vs `pages/admin/_notifications.scss` 的裸 `.notification-card`）：**同名不同义** ——
  前者是通知中心的一条通知（30px 圆角、无边框、12px 下距），后者是 `/admin/broadcast`
  的整块面板（32px 内距、1px 描边、10px 圆角），**唯一消费方是 `admin/broadcast/page.tsx`**。
  通知中心那份靠 0-2-0 压住了它的内距 / 圆角 / 底色，**唯独 `margin-top: 30px` 没人接**
  ——卡片之间于是隔 30px 而不是 12px（相邻外边距折叠取大者，那条 `margin-bottom` 根本不
  参与）。通知中心用 `margin-top: 0` 抵消，**不是冗余，别删**。「按博客卡片风格重做」
  （`276848d`）时把原有的这一行弄丢了；手机端的密度同样被它拦着，一并核过。

- `pages/blog/_menu.scss` 的 `.current-category .badge` 是**死规则**：唯一渲染
  `.current-category` 的 `src/app/components/AdminArticlesManager.tsx` 里没有 `.badge`
  子元素。一旦有人把它加回去，浅色主题下就是白字压半透明白底。
- `pages/_checkin.scss` 的 `@keyframes btnPulse` 光环写死浅色主题品牌蓝
  `rgba(37,99,235,…)`，暗色下与按钮本体（`#23A5FF`）不同色 —— 只在 1s 的脉冲里可见，
  且站内没有「品牌色 + 指定透明度」的令牌可用，暂留。

**2026-09-18 已修（第五轮：样式写了、但没写到能命中的地方）**：

> 判据：**类名在 .tsx 里用了，编译产物里没有定义**。与第四轮的区别是这个筛选不看
> 旧 `rebuild.css` 有没有 —— 这几处**从来没在任何一个文件里有过定义**，
> 所以「旧文件里有过的才补」那轮把它们全漏在了名单外。
>
> 起因是第四轮之后重新扫了一遍（这次连 `.tsx` 里带 `${}` 的模板串一起解析）。
> 扫出的缺口分两种，第二种更隐蔽：**规则写了，但选择器谁也命中不了**。
>
> 这一轮起由 `tests/unit/css-tsx-classes.test.ts` 盯着（见 §1）。

- **收银台 `/fish/pay` 的四个类写在 JSX 里、CSS 从来没有过**：`.pay-quick` /
  `.pay-quick__btn`（快捷金额那排）落回浏览器默认按钮 —— 灰底、方角、Arial 13px，
  且三颗按钮彼此零间隙；`.pay-amount__input` 少了金额档，同一个 `PayForm` 换个 variant
  金额就从 24px 粗体掉成 14.4px 常规体；`.pay-amount__error` 与正文同色，读不出是报错。
  修法是**补上它们的 `market-*` 孪生类**（`market-quick` / `market-quick__btn` /
  `market-amount__input` / `market-field__hint--error`）—— `_fish-pay.scss` 头部
  本来就写着「卡片/字段/按钮全部复用 `_fish-market.scss` 的类」，这几个类名漏了而已。
  只有 `.pay-quick__hint` 在市场上没有对应物，写在 `_fish-pay.scss`。

- **剪贴板编辑器：`.clipboard-form__editor` / `__fallback` 的嵌套层级写错**
  （`_clipboard.scss` 里落进了 `&__group` 内部）→ 编译成 `.clipboard-form__group__editor`
  这个 **DOM 里不存在的选择器**。规则一直在，只是没人能命中它：`#clipboard-editor`
  于是吃 Vditor 自带的 `1px 描边 + 3px 圆角`，既没有页面底色也没有聚焦光晕
  （违反 §4.2 的三条）。b81a201 把外观从行内 style 挪进 SCSS 时就是这么错的。
  ⚠️ 修的时候带上 `#clipboard-editor`：`.vditor` 与它同为 0-1-0，而
  `vditor/dist/index.css` 是**页面段的独立 chunk**（主 SCSS 挂在 layout 段、先加载），
  等权重下后到的赢 —— 不带 id 会被盖掉。

- **`.chat-search-item__time` 漏了 `white-space: nowrap`**：`fmtTime` 输出
  「09-18 19:00」中间那个空格是折行点，作者名一长，flex 就把它压到 min-content
  并在空格处断成两行（同一次提交里 `__head` / `__author` / `__text` 都写了，漏了这一条）。

- **两个死类名删掉了**：`.article-checkbox`（`AdminArticlesManager`）与
  `.toggle-featured`（`AdminBlogActions`）—— 它们一直以「JS 钩子类」的名义被引用在
  守卫的注释里，作为「.tsx 类名不查」的理由，但**全仓没有任何 JS 消费它们**
  （复选框与按钮都是 React 状态驱动的）。这不是「刻意无样式」，是死代码。

**2026-09-18 已修（第四轮：SCSS 拆分漏搬的那一整块）**：

> 判据：**类名在代码里还在用、编译产物里没有定义、而旧 `rebuild.css` 里有定义**。
> 这类故障构建不失败、tsc 管不着、肉眼也未必立刻发现（很多只是间距/圆角差一点），
> 直到有人看见「某个按钮没有样式」才暴露。
>
> 起因：收藏夹的「选择文件」按钮顶着浏览器默认样式。根因是 `02f6ab5`（SCSS 拆分）
> 把 `app/static/css/rebuild.css`（1892 行，末尾有一整段注释为「补齐审计发现的
> 『用了但没定义』的类」的补丁层）拆进 `src/styles-scss/` 时，**那一整块没有跟着
> 搬过去**，随后旧文件被删除。扫描确认：仍在引用的 1105 个类名里 145 个没有定义，
> 其中 82 个旧文件里有过。已分批补齐 —— 文件选择器、工具页（hex 查看器 / 进度条 /
> 面板 / 算法徽章）、工具类（间距 / 显示 / 弹性 / 栅格 / 文字）、后台残余
> （`.card` / `.table` / `.badge-*` / `.page-item` / `.form-row` / `.wrap` …）。

- **`enhanceFileInputs` 只在整页加载时跑过一次**，而 Next 的 `<Link>` 跳转不重载文档
  —— 工具页与「我的收藏夹」的入口都在工具箱，所以**从常规入口进去时那颗 file input
  是 init 之后才挂上的，自定义包装根本没生成**。现由 base.js 的 MutationObserver
  补做（只在新增节点是/含 file input 时才调度，rAF 去重）。找这类时序问题的判据：
  整页刷新正常、点链接进去不正常 → 十有八九是「只跑了一次」。
- **刻意不补的两个**（写在这里免得下次扫描又当成缺口）：
  - `.children` —— 旧规则 `margin-left: 24px + padding-left: 16px` 会与 `.comment-list`
    已承担的缩进叠加，让每层楼向右溢出 15px（§12 上面那条横向滚动条）。
    `.comment-item` 的细线则恢复了（纯纵向，不影响溢出）。
    ⚠️ 那条 `.comment-item .children .comment-item:first-child` **不能删、也不能顺手
    「整理」成 `> .comment-list >`**：`children` 这个类名令牌在编译产物里**只**由它提供，
    而 `tests/unit/css-tsx-classes.test.ts` 要求 tsx 里出现的每个类名都有定义 ——
    改掉它那道守卫会当场红（`CommentSection.tsx` 的 `<ul className="children comment-list">`）。
  - `.modal-dialog-centered` —— 现在的 `.modal.is-open` 已是 flex 居中、`.modal-dialog`
    还有 `margin: auto`；补上它反而把对话框变成 flex 容器、压过现有居中。
- **「用了但没有样式」里有一批是正确的**（纯语义包装 / 占位修饰类 / 命名钩子）——
  完整名单连同逐条理由在 `tests/unit/css-tsx-classes.test.ts` 的 `UNSTYLED` / `CONSUMED`，
  **这里不重抄**：`.chat-msg__reply-text`（属性全部继承自父级 button）、
  `.fish-card__body`、`.fish-card__link-label`、`.home-grid-item`、
  `.clipboard-markdown-content`、`.rc-medal`、`.nf__btn--ghost` 与两个
  `*__btn--secondary`（空规则占位）。下次扫描报出这些不必再查一遍。
- **`.form-hint` / `.file-hint` 看着像 `.form-text` 的重复，其实不是**：它们所在的
  元素挂的是 `.text-muted`（只给颜色），删掉就只剩一行没有字号/行高/上边距的裸字。
  判断「某类是不是纯遗留」要连**同一个元素上还挂了什么**一起看，不能只比规则内容。
- **两个新守卫**：`tests/unit/css-js-classes.test.ts`（JS 注入的类名必须有定义 ——
  `.filepick` 那套 DOM 在 `.tsx` 里一个都搜不到，图标那条检查扫不到它）与
  `tests/unit/base-js-filepick.test.ts`（含「客户端路由跳转后插入的 input 也要被增强」）。

**2026-09-18 已修（第三轮：同名的类拆开）**：

> 判据：**同一个类名出现在两处、而两处指的不是一回事**（同名嵌套最典型）。这类 bug
> 不报错也不变色，只是让组件白拿一份页面级容器样式 —— 内缩、外边距、滚动容器全跟着走。

- **`.blog-detail` 同名嵌套（本节此前登记为遗留）**：`src/app/components/CommentSection.tsx`
  的根节点原来是 `className="blog-detail"`，与 `src/app/blog/[id]/page.tsx` 的正文外层
  `<article>` 同名 → 评论区白拿 `max-width: 940px` / `margin: 50px auto` / `padding: 0 16px` /
  `overflow-x: auto`。后果有二：评论块左右比正文卡各宽 4px（窄屏反而窄 16px），
  以及**自带一个滚动容器**（`tests/e2e/comment-layout.spec.ts` 里那条横向滚动条正是画在
  它身上的）。现改用**与正文同列的 `.blog-content-container-container`**（`MarkdownRenderer`
  的根节点用的也是它）：左右边缘与正文卡完全对齐，桌面/窄屏两个断点都对，且檐沟只有一份
  定义（桌面 20px / 窄屏 0），不会 drift。**别在评论根节点上另写 padding。**
  顺带丢掉原属于 `.blog-detail` 的 50px 上外边距 —— 评论区与操作区的间距回到
  `.read-controls` 自己的 40px（窄屏 30px）。该类名从此**只属于页面正文外层**。
  评论区自己需要滚动容器时**写 `.comment-section > .comment-list`**（2026-09-19 起，
  刻意留的那一条，见 §6.7），**别再给 `.blog-content-container-container` 或评论根节点
  写 `overflow-x`** —— 那正是这一轮拆掉的东西。
- 其余同名嵌套已登记待办，见下方「同类陷阱」。

**2026-09-18 已修（第二轮：滚动条 / 左侧竖条收尾 / 幽灵引用）**：

- **滚动条**：全站此前既没有滚动条样式、也没有 `color-scheme`，暗色主题下浏览器
  照画浅色滚动条（讨论区主区与侧栏、博客评论区都看得见）。见 §8。
- **最后一条装饰性左侧竖条**已删：`pages/_chat.scss` 的 `.chat-msg__content--mention`
  及其右侧镜像（`box-shadow: inset ±3px 0 0`）。同一文件的 `.chat-chan.is-active`
  也是这一轮删的（它是漏网的伪 `border-left`）。
- **评论区的横向滚动条**：`.comment-list` 同时写了 `width: 100%` + `padding-left: 15px` +
  `margin-left: 15px` —— border-box 下 padding 算进 100%、margin 不算，于是每层楼中楼
  向右溢出 15px，冒到最近的滚动容器上画出横向条。**缩进只保留 `padding-left`**。
  另加 `tests/e2e/comment-layout.spec.ts` 钉住（登记在 `RESPONSIVE_SPECS`）。
  > ⚠️ **2026-09-19 起顶层列表又成了滚动容器 —— 是刻意的，不是上面这条回归。**
  > 深层楼中楼被 `.comment-item` 的 min-width 撑宽后，溢出**只**允许由
  > `.comment-section > .comment-list` 接住（那里有 `overflow-x: auto`），于是整片评论区
  > 只有一条横条，而页面与 `.blog-detail` 仍然不滚。上面「缩进只保留 `padding-left`」的
  > 判据**不变**：每层再叠一个同值 `margin-left` 会让溢出提前发生、且发生在**每一层**上。
  > 完整口径（含 240px 的来历与 `:has()` 那条）见 §6.7「评论区的两条几何契约」。
- **幽灵引用**：`pages/blog/_blog.scss` 的 `.read-hero { background: var(--background-color) }`
  （`--background-color` 从未定义 → 标题带一直是透明的，死声明已删）、
  `src/app/components/AdminCategoryEditor.tsx` 的 `var(--ink-3)` → `--fd-ink-3`。
- **写死色**：`pages/_audit-logs.scss` 的 `#198754` → `--color-success-primary`；
  `pages/_tool-new.scss` 的 `.tag-primary` 两支 `rgba(59,130,246,…)` →
  `--color-accent-blue-soft`；`public/static/js/core/base.js` 里 `<meta name="theme-color">`
  的浅色值 `#FBFBFD` → `#F8FAFC`（与 `--color-background-page` 对齐）。

**2026-09 上旬已修（本节曾列为遗留，勿再按旧描述排查）**：

- 通知未读底令牌的拼写错误 —— 浅色侧 `--color-background-card-unrend` 已改为
  `-unread`，浅色未读底色首次真正生效。
- `--box-bg` / `--text` / `--muted-color` 三个幽灵变量及其引用规则已删除；
  `--color-brand-primary-rgb`、`--color-bg-primary`、`--r-pill`、
  `--color-brand-primary-dark` 也已换成真实令牌。
- `pages/_tool-new.scss` 里那套不生效的 `body.dark-mode` 第二配色已删除；
  `components/_form-controls.scss` 与 `pages/blog/_blog.scss` 里注释掉的旧变量表
  一并清掉（它们是幽灵引用的源头）。
- `.form-control` 的 `!important` 已去掉（它曾压掉自己的聚焦态）。
