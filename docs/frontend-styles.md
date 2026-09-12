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
├── pages/        各页面样式（首页、博客、聊天、游戏、通知、管理后台…）
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

主题令牌集中在 `src/styles-scss/base/_root.scss`，通过 `<html data-theme="light|dark">` 切换。所有组件样式必须引用这些变量，**禁止在组件里写死主题色**（游戏棋盘等有意的硬编码除外）。

### 2.1 主色板（浅色 `data-theme="light"`）

| 变量 | 值 | 用途 |
|------|-----|------|
| `--color-brand-primary` | `#2563EB` | 品牌主色：链接、主按钮、激活态 |
| `--color-brand-secondary` | `rgba(37,99,235,0.1)` | 品牌浅底：胶囊底、hover 背景 |
| `--color-background-page` | `#F8FAFC` | 页面背景 |
| `--color-background-card` | `#fff` | 卡片 / 顶栏 / 底栏背景 |
| `--color-background-content` | `#eff2f5` | 输入框、代码块、内容底色 |
| `--color-background-card-unrend` | `#fffdf0` | 通知未读卡片底（浅色侧；仅定义未见引用，见 §12 遗留） |
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

### 2.2 主色板（深色 `data-theme="dark"`）

| 变量 | 值 |
|------|-----|
| `--color-brand-primary` | `#23A5FF`（更亮的蓝，保证对比度） |
| `--color-brand-secondary` | `rgba(35,165,255,0.1)` |
| `--color-background-page` | `#131517` |
| `--color-background-card` | `#181A1D` |
| `--color-background-content` | `#21252A` |
| `--color-background-card-unread` | `#08102D` | 通知未读卡片底（`.notification-card.unread`，深色专用） |
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

### 2.3 阴影

| 变量 | 浅色 | 深色 |
|------|------|------|
| `--shadow-xs` | `0 2px 10px rgba(0,0,0,.05)` | `rgba(0,0,0,.2)` |
| `--shadow-sm` | `0 2px 10px rgba(0,0,0,.1)` | `rgba(0,0,0,.25)` |
| `--shadow-card` | `0 4px 20px rgba(0,0,0,.08)` | `rgba(0,0,0,.3)` |
| `--shadow-card-hover` | `0 8px 30px rgba(0,0,0,.12)` | `rgba(0,0,0,.4)` |
| `--shadow-card-brand` | `0 2px 25px rgba(37,99,235,.15)` | `0 2px 20px rgba(35,165,255,.1)` |

卡片 hover 统一升到 `--shadow-card-brand`（品牌色光晕），同时边框切 `--color-border-highlight`。

### 2.4 SCSS 侧令牌

`src/styles-scss/abstracts/_variables.scss`：

- 圆角：`$radius-max: 999px`（胶囊）、`$radius-large: 10px`、`$radius-small: 5px`
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
- 全局 `transition: color 0.3s ease, background-color 0.3s ease`（`layout/_header.scss` 顶部），保证主题切换平滑。

## 4. 圆角与形状语言

「**胶囊 + 大圆角**」是视觉基调：

- 按钮 / 链接 / 表单选择器 / 徽章 / 导航项 → `border-radius: 999px`（胶囊）
- 卡片 → `30px`（首页 feature-card、登录/注册容器、博客正文容器、弹窗内容）
- 普通面板 / 分页 / 输入框 → `10px`（`$radius-large`）或 `6–8px`
- 图标徽章 → 按场景取圆形（`50%`）或胶囊（`999px`）
- 头像 → 方形小圆角，统一 `border-radius: 8%`（规范与全站清单见 §4.1；不用圆形头像）

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
| 聊天 · 频道列表 / 折叠图标 | `.chat-chan__avatar` / `.chat-chan__icon`（pages/_chat.scss） | 34px |
| 聊天 · 会话标题栏 | `.chat-main__peer-avatar`（pages/_chat.scss） | 32px |
| 聊天 · 消息作者 | `.chat-msg__avatar`（pages/_chat.scss） | 34px |
| 新会话弹窗列表 | `.chat-new-item__avatar`（pages/_chat.scss） | 32px |
| 签到排行榜（含占位） | `.checkin-leaderboard__avatar` / `-placeholder`（pages/_checkin.scss） | 32px |
| 后台用户卡片 | `.user-card__avatar`（pages/admin/_users.scss） | 28px |
| 博客列表 / 详情作者 | `.blog-author img`（pages/blog/_menu.scss，博客列表与详情页共用） | 20px |
| 博客评论作者 | `.comment-author-avatar`（pages/blog/_blog.scss） | 24px |
| Feed 弹窗名单（点赞 / 动态） | FeedButton.tsx 内联 style（两处） | 32px |

## 5. 布局

- **容器**：最大 `1140px`，左右 15–16px padding，`margin: auto`。断点 992px/1200px 下用 `max-width` 收敛。
- **顶栏**：`.site-navbar` 固定顶部（`position: fixed; top:0`），高 62px，背景 `--color-background-card`，阴影 `--shadow-card-brand`。`body` 有 `padding-top: 62px` 补偿。
- **页脚**：`.site-footer`，背景卡片色 + 顶部分隔，内容容器同 1140px 体系。
- **后台**：`.admin-layout` 左侧 220px 固定侧边栏（移动端折叠成横向标签条）+ 右侧滚动内容区，内容容器最大 1400px。
- **栅格**：首页/游戏用 flex + `gap` 或 CSS Grid（`repeat(auto-fit, minmax(...))` / 显式 `repeat(3,1fr)`），**不用浮点栅格**。另有 `base/_grid.scss` 与 `base/_forms.scss` 提供 Bootstrap 风格行/列工具。
- 页面骨架：`body { display:flex; flex-direction:column; min-height:100vh }` + `main { flex:1 0 auto }`，页脚始终贴底。

## 6. 组件风格要点

### 6.1 按钮（`components/_button.scss`）

- 项目自有胶囊按钮族：`.button-primary(-small)`、`.button-warning(-small)`。
  - 常态：`--color-brand-secondary` 底 + `--color-brand-primary` 字 + **粗体** + 胶囊圆角。
  - hover：底色反转为 `--color-brand-primary`、字变白；active：`filter: brightness(0.6)`。
- Bootstrap 风格 fallback 族：`.btn` / `.btn-primary` / `.btn-outline-*` / `.btn-sm` / `.btn-danger` 等，含 `[data-theme="dark"]` 适配。
- 通用原则：胶囊圆角、粗体、hover 反转前景背景。

### 6.2 卡片

- 首页 `.feature-card` / 游戏 `.game-card`：卡片色背景 + 1px 边框 + `--shadow-card`，hover 升 `--shadow-card-brand` 并高亮边框。默认态与背景区分靠边框+阴影。
- 管理后台 `.admin-stat-card`：左侧 4px 彩色竖条区分类型（blue/green/amber/purple/red）。

### 6.3 表单控件（`components/_form-controls.scss`）

- `.form-control`：无边框、`--color-background-content` 底、15px 圆角；focus 时背景变卡片色 + 5px 品牌浅色「内边」。
- `.form-select`：品牌色胶囊（品牌底 + 品牌字 + 粗体）。
- `.form-check-input`：圆形 checkbox，选中变品牌色。
- 校验态：`.is-invalid` + `.invalid-feedback`（红色）。

### 6.4 弹窗 / Toast / 分页 / 告警

- `.modal`：居中遮罩（`rgba(0,0,0,.5)`），内容 500px 宽、30px 圆角、`--shadow-card-brand`。
- `.toast`：右上角 360px 栈，深色底白字，按类型着色（success/error/info/warning）。
- `.pagination`：居中，`.page-link` 卡片底 + 边框；激活页品牌色实底白字。
- `.alert`：Bootstrap 风格 4 色 + `body.dark-mode` 适配。

### 6.5 聊天页（`pages/_chat.scss`）

`/chat` 是双栏工作台，页面高度 `calc(100vh - 62px)`、`overflow: hidden`，色板全部走 CSS 变量随明暗主题：

- 会话侧栏 `.chat-sidebar`：固定 280px（`border-right` 分隔），会话项 `.chat-chan`（头像 / 标题 / 预览 / 未读徽标 / 删除），头部 `.chat-sidebar__head` 带折叠钮 —— `.chat-page--collapsed` 时收到 60px 只留图标。
- 消息主区 `.chat-main`：头部标题 + 操作；消息气泡 `.chat-msg`（自己发的加 `.chat-msg--mine`），含作者名 / 时间 / 操作 / 图片 / 引用回复 / 已删占位 `.chat-msg__deleted`。
- 输入条 `.chat-composer`：附件条（回复 / 引用博客 / 待发图片）+ 面板（工具条 `.chat-composer__icon-btn` → 输入框 `.chat-composer__input` → 底条：提示 `.chat-composer__hint` + 发送 `.chat-composer__send`）。样式与评论区**共用** `components/_composer.scss` 的 `rich-composer($p)` mixin，组件也是同一个 `RichComposer`（`className` 注入 BEM 前缀，见 §11.1）。
- 发起私聊弹窗 `.chat-new-modal`：搜索框 `.chat-new-search` + 结果项 `.chat-new-item`（头像 / 昵称 / 角色 / 自己标记）。
- 响应式：`≤900px` 时侧栏变抽屉，`.chat-page--drawer-open` 展开。

### 6.6 博客列表排序工具栏（`pages/blog/_menu.scss`）

`/blog` 列表顶部的「发布时间 / 更新时间」切换（组件 `src/app/blog/BlogSort.tsx`）：

- `.blog-sort`：容器，列表区顶部右对齐一行（`justify-content: flex-end`），**空结果态也渲染**（要挂载客户端恢复 effect）。
- `.blog-sort-btn`：胶囊按钮（`border-radius: 999px`），默认 `--color-text-secondary` 字、`--color-background-content` 底；hover 转品牌字；`.active` 态品牌浅色底（`--color-brand-secondary`）+ 品牌字（`--color-brand-primary`）+ 加粗 —— 与侧栏选中态同一套令牌。
- 可访问性：容器 `role="group"`，按钮 `type="button"` + `aria-pressed`。

## 7. 图标方案

**不用图标字体 / icon 库**，采用「SVG + CSS mask」：`components/_icons.scss` 定义 `.icon` 基类，用 `mask-image` 引用 `public/static/img/icons/*.svg`，颜色跟随 `currentColor`（即继承 `color`），天然适配亮/暗主题。

- 常用类：`.icon-bell`、`.icon-gear`、`.icon-person`、`.icon-house`、`.icon-fish`、`.icon-theme-toggle`、`.icon-book/controller/journal-text/tools`（首页四大入口）等。
- 首页/游戏卡片的 `feature-icon` / `__icon` 用同一手法，给不同卡片指定不同 `color` 形成彩色图标（无需多色 SVG）。
- 新增图标：放一个单色 SVG 到 `public/static/img/icons/`，在 SCSS 里加一条 mask 规则即可。

## 8. 主题切换机制

- 主题状态存 `localStorage['theme']`，取 `light` / `dark`，未设置时跟随 `prefers-color-scheme`。
- `src/app/layout.tsx` 内联一段防闪烁脚本，在 CSS 加载前就根据 localStorage/系统偏好设好 `<html data-theme>`。
- 交互切换在 `public/static/js/core/base.js`：`switchTheme()` 设置 `data-theme` 属性并写 localStorage，主题按钮点击切换 + 图标旋转动画。
- **深色适配**：所有组件用 CSS 变量即可自动适配。历史遗留的 `body.dark-mode` 选择器（modal / alert 等）只在少数字段残留，新代码一律走 `[data-theme="dark"]` 或纯变量。

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
- hover 微交互：卡片升阴影、图标 `scale(1.1)`、按钮反转前景背景、微位移（已注释的 transform 保留）。

## 11. 新页面 / 新功能样式约定

1. 主题色一律用 `_root.scss` 的 CSS 变量，别写死色值。
2. 圆角 / 间距 / 阴影复用 2.4 节的令牌，别自造一套。
3. 改 SCSS 后跑 `npm run build:css`，提交时**带上编译产物**（`compiled/flask.css`）——线上跑的就是它。
4. 图标优先复用 `public/static/img/icons/` 现成 SVG + mask 方案，别引 icon 库。
5. 组件优先复用现有 `.button-*`、`.card`、`.form-control` 等类名，少写一次性样式。
6. 响应式：从 `up(992px)` 多列 → `up(768px)` 两列 → 单列，字号同步降级。
7. 深色主题检查：切到 `data-theme="dark"` 看一眼对比度（品牌色已选更亮的 `#23A5FF`）。

### 11.1 跨场景复用的样式写成带前缀的 mixin

同一套视觉用在两处（且两处的 BEM 前缀不同）时，**不要复制一份**，写成参数化 mixin，
两边各 `@include` 一次：

| 组件 | mixin | 用处 |
|------|-------|------|
| 富文本输入区 | `components/_composer.scss` → `rich-composer($p)` | 聊天 `chat-composer` / 评论 `comment-composer` |
| Markdown 正文块级元素 | `components/_markdown-body.scss` → `rich-markdown($cls)` | 聊天 `chat-msg__md` / 评论 `comment-content__md` |

复制一份的代价不是重复代码，是**必然 drift** —— 用户会看到「列表在聊天里长这样、在评论里
长那样」，而这类不一致没有人会当成 bug 报上来。React 侧同理：`RichComposer` 的 BEM 前缀
由 `className` 注入（见组件文件头）。

⚠️ 改这类共享样式后，两处**都要**在页面上看一眼 —— 单测与构建都拦不住「另一边被改花了」。

⚠️ 选择器权重陷阱：删掉旧样式时要确认新规则不会被更具体的老选择器盖掉。真实踩过：
`.comment-form textarea`（0-1-1）权重高于 `.comment-composer__input`（0-1-0），不删旧规则
就会把面板内的透明输入框重新涂成卡片底色，从外面看是一个突兀的色块。

## 12. 已知遗留 / 注意事项

- `compiled/flask.css` 是产物，勿手改。
- 通知未读底变量名不对称：通知页 `.notification-card.unread` 引用的是**深色侧** `--color-background-card-unread`；浅色侧只定义了拼写不同的 `--color-background-card-unrend`（`#fffdf0`）且无任何引用——疑似笔误遗留，浅色未读态实际只显示左边黄条（`--color-border-unread`）。新增代码不要再踩这两个名字。
- 个别文件残留 `--box-bg` / `--text` / `--muted-color` 等旧变量名（来自迁移前的站点 CSS），它们没有在 `:root` 定义，会落到 fallback。新代码用新的 `--color-*` 体系。
- `body.dark-mode`（旧 Flask 时代的深色写法）与新 `[data-theme]` 并存，只在个别 Bootstrap fallback 组件里用到，属历史债务，不推广。
- `abstracts/_theme-map.scss` 的 light map 与 `themeify` mixin 已停用，不要基于它扩展。
- 游戏棋盘类样式（`pages/game/*`）为玩法所需，允许硬编码色值，与主题无关。
