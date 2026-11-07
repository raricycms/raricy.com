# 文档核对后的维护待办

> 状态：**未完成 / 待决策**。校对日期：2026-10-12。
> 本文从现行规范与遗留清单中集中登记维护事项；只核对代码和历史，不在本轮实施修复。
> 编辑器功能与验收见 `docs/plan/editor-plan.md` §7.2；格式转换器见
> `docs/plan/format-converter-roadmap.md` §16。

## 1. 前端样式整理

全站设计标准见 `docs/frontend-styles.md`，容器与复用规则见其 §4.1/§8.2。
本节于 2026-10-21 随规范重写核对，登记已有问题、复用风险与待适配项；
规范更新不代表这些实现已经完成修复。

| 事项 | 当前状态 | 处理范围与验收 |
|------|----------|----------------|
| 剪贴板表单的页面外壳 | 已修：外壳只在页面（`clipboard/upload`、`clipboard/[id]`、`/[id]/edit`、列表页 `ClipboardMenu`），`UploadForm.tsx` 不再带 `clipboard-page` 与主标题 | 再改时保持「页面一层容器、页面一个主标题」，组件不持页面外壳 |
| 后台文章管理容器 | 结构性待办：当前由 `AdminArticlesManager.tsx` 提供 `admin-container`，尚未双重嵌套 | 将整页容器责任上提至 `admin/blogs/page.tsx`；当前几何不变，组件复用时不再带页面外壳 |
| 收款错误组件的外壳责任 | 可选整理：`PayError.tsx` 带整页 `content-wrapper`，当前 early-return 分支不冲突 | 有复用需求再分离外壳与内容；先核对 `/fish/pay` 与 `/fish/collect` 错误分支，遵守收银台 DOM 契约 |
| `.current-category` 死规则 | 待清理：当前没有渲染消费方，博客样式仍保留 `.current-category .badge` | 删除前核对模板和脚本；避免重新启用半透明白底白字的过时配方 |
| 正文 `.copy-btn` 的样式归属 | 已失效：旧 DOM 后处理的注入点已删除，当前没有渲染消费方；博客根级与故事局部的 `.copy-btn` 规则都是死规则 | 删除死规则前核对模板与脚本；当前代码块复制按钮由统一渲染引擎的 `md-code-block-copy` 提供，不要再按 `.copy-btn` 找注入点 |
| 签到奖励脉冲的主题色 | 待适配：`btnPulse` 写死浅色品牌蓝，深色下与按钮本体不同色 | 在所属组件明确可用的主题配方，保留按下反馈并覆盖减少动态效果；不引入全局未定义变量 |
| 全站交互状态的动效覆盖 | 待补：不少悬停 / 按下 / 展开 / 加载状态仍是瞬时切换；`/explore` 旧栏目侧栏用 `max-height` + `transition: all .3s`，顶栏部分图标容器也用 `transition: all` | 按组件补 150–250ms 反馈与 480 / 220ms 形变；禁止用 `transition: all` 和 `max-height` 猜高度；优先目录、顶栏、表单、列表、弹窗 |
| 顶栏脉冲的减少动态效果 | 已修：`_header.scss` 的 `prefers-reduced-motion: reduce` 分支已把 `.site-link__dot` / `.notification-badge` / `.checkin-badge` 的 `animation` 置为 `none` | 再动这三个「呼吸点」时保持整族列在 reduce 名单里；保留红点与数字本身，不改变功能 |

> 2026-10 通知页重做时已顺手清掉 `.filter-btn` 那份从未生效的通知侧副本；
> 权威定义只剩 `pages/_fish.scss`，消费方是 `/fish/transactions` 与 `fish/trade/TradeNav.tsx`。
> `.notification-card` 的同名冲突也一并消解：通知中心的规则现在收在
> `.notifications-page` 下，不再依赖 `.content-wrapper` 的后代选择器，也不再需要
> `margin-top: 0` 抵消后台广播页（`pages/admin/_notifications.scss` 已删除）。
> OAuth 应用行已使用 `.admin-app-row`，外壳归父级 `.admin-panel`，不再列为嵌套卡片待办。

## 2. 翻译跳转入口（已退役）

**已退役（2026-11，`1eb6513e`）**：`src/app/tool/translate/page.tsx` 已删除 —— 它只是把
访问者跳转到写死的 `http://116.62.179.232:9198`，且没有工具箱入口。产品决定：直接退役，
不再保留该路由，也不为它补站内入口。

原取舍（「写死 IP + 端口是刻意支持无法解析 DNS 的用户」）随之失效。若将来确需翻译能力，
按新功能重新评估独立入口与替代路径，不把已删除的路由当成注释清理或恢复对象。

## 3. 面向站长的可见性完整轨迹

**未实施**：`blog_visibility_logs` 与 `listBlogVisibilityLogs()` 已存在，目前只有**文章详情页
的「设置可见性」弹窗**显示最近一条（`src/app/blog/[id]/page.tsx` 取数、`FeedButton` 渲染），
后台 `/admin/blogs` 列表没有这条信息。完整历史视图仍缺 CLI 或管理端入口，现状见
`docs/architecture.md` §6.11。

实现前确定入口、站长档位、排序与分页；复用既有只读查询，展示操作者、前后档位与
变更时间。创建不记变更账、软删语义与改档位同事务记账的约束维持原口径，不另建账源。
