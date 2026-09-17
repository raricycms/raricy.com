# 前端样式规范

> 概述：raricy.com（聪明山）的整套前端样式体系。来源是 `src/styles-scss/` 下的 SCSS，编译成 `src/styles-scss/compiled/flask.css` 后由 Next.js 全局引入。全站不依赖 Bootstrap——所有 Bootstrap 风格工具类都有本地 fallback 实现。

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
├── compiled/     编译产物 flask.css（不要手改）
└── main.scss     入口，控制 import 顺序
```

**构建命令**（见 `package.json`）：

- `npm run build:css` — 一次性编译到 `src/styles-scss/compiled/flask.css`（expanded，无 sourcemap）
- `npm run dev:css` — 监听模式，改 SCSS 自动重编译

编译产物由 [src/app/layout.tsx](../src/app/layout.tsx) 以 `import '@/styles-scss/compiled/flask.css'` 全局引入。

> ⚠️ 改样式改 SCSS 源文件，改完跑 `build:css`（或开着 `dev:css`）。`compiled/flask.css` 是产物，直接手改会在下次编译时被覆盖。

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

- **正文行宽上限 ≠ 页边距**：博客详情（`.blog-detail` 940px）与正文卡
  （`.blog-content-container` 900px）在容器**之内**再收一道，那是阅读行宽，别跟着
  容器一起拉宽 —— 拉到 1108 会让最长的文本页读起来更累，也会比博客首页自己的
  列表列还宽。页边距归 `.container`，行宽归这些内层上限。
- **顶栏**：`.site-navbar` 固定顶部（`position: fixed; top:0`），高 62px，背景 `--color-background-card`，阴影 `--shadow-card-brand`。`body` 有 `padding-top: 62px` 补偿。
- **页脚**：`.site-footer`，背景卡片色 + 顶部分隔，内容容器同 1140px 体系。
- **后台**：`.admin-layout` 左侧 220px 固定侧边栏（移动端折叠成横向标签条）+ 右侧滚动内容区，内容容器最大 1400px。
- **栅格**：首页用 flex + `gap` 或 CSS Grid（`repeat(auto-fit, minmax(...))` / 显式 `repeat(3,1fr)`），**不用浮点栅格**。另有 `layout/_grid.scss` 与 `base/_forms.scss` 提供 Bootstrap 风格行/列工具。
- 页面骨架：`body { display:flex; flex-direction:column; min-height:100vh }` + `main { flex:1 0 auto }`，页脚始终贴底。

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

- 首页 `.feature-card`：卡片色背景 + 1px 边框 + `--shadow-card`，hover 升 `--shadow-card-brand` 并高亮边框。默认态与背景区分靠边框+阴影。
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
- `.form-select`：品牌色胶囊（品牌底 + 品牌字 + 粗体）。
- `.form-check-input`：圆形 checkbox，选中变品牌色。
- 校验态：`.is-invalid` + `.invalid-feedback`（红色）。

### 6.4 弹窗 / Toast / 分页 / 告警

- `.modal`：居中遮罩（`rgba(0,0,0,.5)`），内容 500px 宽、30px 圆角、`--shadow-card-brand`。
- `.toast`：右上角 360px 栈，深色底白字，按类型着色（success/error/info/warning）。
- `.pagination`：居中，`.page-link` 走**切页档**（无底色胶囊；当前页品牌浅底 + 品牌字，
  按下不叠加变化）。`.page-input`（跳页框）单行 → 胶囊。
  原先每页都带 1px 描边、6px 圆角，当前页是品牌实底白字（那是最高级的 hover 态）。
- `.alert`：Bootstrap 风格 4 色 + `body.dark-mode` 适配。

### 6.5 讨论页（`pages/_chat.scss`）

`/chat` 是双栏工作台，页面高度 `calc(100vh - 62px)`、`overflow: hidden`，色板全部走 CSS 变量随明暗主题：

- 会话侧栏 `.chat-sidebar`：固定 280px（`border-right` 分隔），会话项 `.chat-chan`（头像 / 标题 / 预览 / 未读徽标 / 删除），头部 `.chat-sidebar__head` 带折叠钮 —— `.chat-page--collapsed` 时收到 60px 只留图标。
- 消息主区 `.chat-main`：头部标题 + 操作；消息气泡 `.chat-msg`（自己发的加 `.chat-msg--mine`），含作者名 / 时间 / 操作 / 图片 / 引用回复 / 已删占位 `.chat-msg__deleted`。
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

**窄屏（≤768px）三颗必须压在同一行**（`flex-wrap: nowrap` + `flex: 1 1 0` 等宽平分 +
`max-width: 24rem`），字号/内边距/徽标各收一档；`<360px` 退回按内容宽度并允许换行
（再缩字号就开始牺牲可读性了）。这条**不能只看代码**：它是按中文字体度量算出来的临界值，
所以 `tests/e2e/favorite-layout.spec.ts` 用真视口断几何，并登记在 `playwright.config.ts` 的
`RESPONSIVE_SPECS` 里（desktop 那一遍同样要跑）。

收藏夹选择器弹窗（`.favorite-picker__*`）：**名称独占一行，两颗创建按钮并排在下一行**
（`.favorite-picker__new-actions`，`flex: 1 1 0` 等宽）。三者挤一行时「创建公开」会被挤到
第二行，而两颗按钮代表的是**对等的两种性质**（创建后不可改），分行会被读成「公开是次要的」。
`<360px` 退回上下堆叠。`/favorite` 页的创建/导入条复用同一组类。

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
3. 改 SCSS 后跑 `npm run build:css`，提交时**带上编译产物**（`compiled/flask.css`）——线上跑的就是它。
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

## 12. 已知遗留 / 注意事项

- `compiled/flask.css` 是产物，勿手改。
- `abstracts/_theme-map.scss` 的 light map 与 `themeify` mixin 已停用，不要基于它扩展。
- `utilities/_text.scss` 里 `.u-text-muted` / `.text-primary` / `.text-danger` 等工具类
  带 `!important` 的 `color`，会盖掉**任何**组件颜色规则。给带这些类的元素写按钮态
  时要留意。
- 表单控件里另有两处 `!important` 是刻意保留的（`.form-check-label a` 等），改动前先确认。

**2026-09 已修（本节曾列为遗留，勿再按旧描述排查）**：

- 通知未读底令牌的拼写错误 —— 浅色侧 `--color-background-card-unrend` 已改为
  `-unread`，浅色未读底色首次真正生效。
- `--box-bg` / `--text` / `--muted-color` 三个幽灵变量及其引用规则已删除；
  `--color-brand-primary-rgb`、`--color-bg-primary`、`--r-pill`、
  `--color-brand-primary-dark` 也已换成真实令牌。
- `pages/_tool-new.scss` 里那套不生效的 `body.dark-mode` 第二配色已删除；
  `components/_form-controls.scss` 与 `pages/blog/_blog.scss` 里注释掉的旧变量表
  一并清掉（它们是幽灵引用的源头）。
- `.form-control` 的 `!important` 已去掉（它曾压掉自己的聚焦态）。
