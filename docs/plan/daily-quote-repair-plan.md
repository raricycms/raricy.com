# 每日一言修复方案

> 状态：已实施（2026-10-29）；往期回看、累计一次共鸣与旧记录保留均已上线，参与门槛与部分
> 细则此后调整过。当前行为以 `docs/architecture.md` §6.22 与服务实现为准，经过见 Git 历史。
>
> **2026-11 校订（R3-705）**：①「同一句 90 天后再次入选」是**本修复方案当时**的口径，现行
> 候选池对社区稿只选登一次（`daily-quote-service.ts` 的 `firstSelectedDay: null` +
> `editions: { none: {} }`）；②不变量 4「社区稿由付款者付 1 条并全额交给投稿人」现行是
> 三元式 —— `kind === 'community' && canReceive(recipient) ? QUOTE_RESONANCE_FISH : 0`，
> 收款人失格 / 禁言时**双方都不动鱼干**。

## 1. 当前事实与入口

- 页面：今日 `/quotes`、往期一言 `/quotes/history`、一言集 `/quotes/saved`、投稿
  `/quotes/submissions`；旧地址 `/checkin/quotes`、`/favorite/quotes` 由 `legacyRedirect` 永久跳转。
- 接口：`GET /api/daily-quotes/today`、`GET /api/daily-quotes/history?page=1`、
  `POST /api/daily-quotes/[id]/resonance`、`POST /api/daily-quotes/[id]/favorite`、
  `POST /api/daily-quotes/submissions`。
- 参与门槛**对所有入口一致**：core+ 且名下有未软删博客（`hasPublishedBlog`）。不满足时页面
  显示 `QuoteBlogRequired` 引导、接口 403 `BLOG_REQUIRED`；今日内容另外要求当天已签到。
- 往期数据来自 `daily_quote_editions`，按 `day < todayStr()` 倒序，每页 20 期
  （`QUOTE_HISTORY_PAGE_SIZE`），纯读取、不补抽、不创建 edition；分页复用 `SitePager`。

## 3. 历史列表与权限边界

### 3.1 历史列什么

- 只列真实存在且早于今天的选用记录；不公开候选池，不列已通过但未入选、待审与被拒稿件。
- 缺日不补抽；同一句 90 天后再次入选保留两个日期条目，互动状态与共鸣人数按 quoteId 共用。
- 已下架或作者已归档的内容保留日期与不可用占位，不显示原文、出处与身份，不允许新增共鸣。
- 历史查询是纯读取，不调用 `selectEdition` 或 `getTodayQuote`，不会为今天或过去补抽；往期页
  排除今天，不能当绕过签到的今日读取入口。

### 3.2 今日与历史的边界（按当前实现）

| 身份 / 状态 | 往期、一言集 | 今日 |
|---|---|---|
| core+，名下有已发布博客 | 可看、可共鸣、可收藏，不要求当天签到；只能共鸣早于今天的已发布内容 | 需当天已签到 |
| core+，名下没有已发布博客 | 显示 `QuoteBlogRequired` 引导，接口 403 `BLOG_REQUIRED` | 同左 |
| 未登录 / 普通用户 | 登录引导与 core+ 限制，页面与接口各自校验 | 同左 |
| 禁言中的 core+ | 可看；投稿、共鸣与收藏变更由服务端拒绝 | 同左 |

## 4. 共鸣累计一次与旧数据处理

### 4.1 不变量

1. `(quoteId, userId)` 一生最多一次有效共鸣；日期只记录发生时间，不参与权限与去重。
2. 换日、刷新、重启、取消 / 重新收藏、再次入选都不恢复共鸣资格。
3. 已共鸣不提供取消；重复请求幂等返回，不增加人数、不产生鱼干流水。
4. 社区稿件由付款者付 1 条鱼干并全额交给投稿人，经典免费；不能给自己的投稿共鸣。
5. 资格行、明细行与两侧记账在同一事务；余额不足或作者入账失败时全部回滚。
6. 收藏独立：没有共鸣也能收藏，取消收藏不撤销也不重置共鸣。

### 4.2 数据结构

`daily_quote_resonance_once`（`quote_id` + `user_id` 联合主键，`first_resonated_at`）是累计
资格与人数的唯一依据，迁移 `37_daily_quote_resonance_once` 用 `MIN(created_at)` 回填；
`daily_quote_resonances` 保留每次发生的明细，只服务历史审计。旧行、旧流水与余额都不改写。

### 4.3 存量重复的产品呈现

同一人过去三天各共鸣一次时：明细与流水都保留，累计表只有一行，界面按**人数**计 1 而不是 3，
因此部分内容上线后显示的共鸣数可能下降；文案统一为「已共鸣」「每人每句限一次」。

存量重复组合数、涉及付费次数与金额**仍未做只读统计**；是否补偿旧重复投喂要先有统计再定
（登记见 `docs/plan/reactive-md-migration-plan.md` §12 第 6 项）。不删除历史流水。

## 8. 发布边界

- 累计表、代码与回填作为一次切换；不能出现旧版本仍按日写入而累计表不同步的窗口。
- 回退只回退 UI 与非写路径，**保留累计写入保护**；绝不运行旧的按日共鸣代码（会重新放开扣款）。
- 旧余额与流水不依赖本次迁移改写；生产部署与迁移是否执行不由本文记录。

## 9. 验证记录

- 相关测试（服务 / 路由 / 经典目录 / 迁移）：6 个文件、35 项通过（2026-10-29）。
- 迁移 `37_daily_quote_resonance_once` 用真实含跨日重复的 SQLite 夹具验证回填、重复执行与
  联合主键（`tests/unit/daily-quote-resonance-migration.test.ts`）。
- 浏览器：`tests/e2e/daily-quote.spec.ts` 桌面 11 项、手机 11 项通过；typecheck 与 build 通过。
- 全量 vitest 267 文件 / 5,305 用例，剩余 21 条红来自当时工作区的 `host-components.ts` WIP，
  与本次改动无关（`docs/known-red.md` §8 同一例）。
