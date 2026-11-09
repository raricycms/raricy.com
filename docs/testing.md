# 测试基建与 e2e 口径

> 本文只讲**测试基建的口径**：两层 runner 各自怎么隔离、e2e 为什么单库双 project、
> retries 的语义、以及「用例之间的顺序依赖」怎么规避。具体某条失败的排查见
> `docs/known-red.md`；验证纪律（什么时候跑什么）见 `CLAUDE.md`。

## 1. 两层 runner

| 层 | 命令 | 库 | 并行 |
|---|---|---|---|
| vitest（unit / service / route） | `npx vitest run <文件>`、`npm run test:related -- <源码>` | 每进程一个 `tests/.tmp/test-<pid>-<rand>.db` | 进程内并行，进程间互不共享库 |
| Playwright e2e | `npm run e2e`（读现有 `.next`）、`npm run e2e:ci -- <spec>` | 每轮一个 `tests/.tmp/e2e-<pid>-<rand>.db` | `workers: 1`，串行 |

vitest 的库名带 **pid + 随机串**（`tests/setup.ts`）：固定名会让同机并行的两个 vitest
进程互相覆盖，症状是「单跑绿、并行红」。e2e 用 `e2e-` 前缀，与 `test-` 不重叠，两套
runner 同时跑也不会互删临时库。

## 2. e2e：单库 + 双 project

**单库**：Playwright 只有一个 webServer、`workers: 1`、`fullyParallel: false`，全套用例
共用 `global-setup` 建好的那一个测试库（建库 → `db push` → 种子 → 断言库路径在
`tests/.tmp` 下，绝不打到真实库）。因此**用例之间不能假设彼此的顺序**，也不能留下
「只对下一个用例成立」的状态 —— 需要改库的用例自己造数据、自己清理。

**双 project**：

- `desktop` 跑**全部** spec；
- `mobile`（iPhone 13）只跑 `RESPONSIVE_SPECS`（真的按视口分支的 spec）。这份清单的增删
  以 `playwright.config.ts` 为准。

纯外观/几何 e2e 已按仓库验证纪律退出（颜色、间距、版式改由受影响页面和视口检查确认）；
保留在 `RESPONSIVE_SPECS` 里的必须是**行为性**用例（按视口分支的交互、可点击/键盘可达）。

为什么不把通用用例从 mobile 里排除、只让 desktop 跑 —— 两者等价，但那样要写 project 级
`testIgnore`，而它会**同时作用于两个 project**（踩过：一条用例不剩），比报错更危险。
也不按 describe 细分：`testMatch` 只匹配文件路径，`/^x\.spec\.ts:.*某describe/` 会静默
选不中任何用例。

为什么响应式 spec 仍保留 desktop 那一遍：这批用例大量写成「`isMobile` 点抽屉 / 否则点
侧栏」，同一个 test 覆盖两种布局，只在 mobile 跑等于桌面分支无人验证。

**测试服务的业务限额**：发文日限额在代码里固定 20（`src/lib/blog-service.ts`），全量长跑
会让同一个种子号累计超过它、在中途 429。测试服务的 webServer 通过 `BLOG_DAILY_LIMIT`
放宽（见 `playwright.config.ts` 的 env）；生产不要配置这个变量。同理，任何「按轮累计」
的业务限额都走测试服务 env，不改生产默认值。

**水合纪律**：`page.goto` 等到 `load` 不等于 React 已水合。紧接着对受控输入框 `fill` 时，
水合前的值会被首次渲染重置回空（注册表单、评论/讨论输入框都踩过）。需要「goto 后立刻
输入」的用例先等水合：评论/讨论用 `waitCommentSectionReady`（等首次拉取落定），其它
客户端表单用 `waitForHydrated(page, selector)`。

## 3. retries 的语义

`retries: process.env.CI ? 1 : 0`（`playwright.config.ts`）：**只有 CI 重试一次**，本地不重试。

- 重试会**重跑整个 test**（不是从失败那一步继续）。所以 test 必须能独立重跑：
  不能在 test 开头假设「上一次已经登录过 / 已经建过文章」；
- 失败现场靠 `trace: 'retain-on-failure'` 与 `screenshot: 'only-on-failure'` 保留；
- **不要为了「让它绿」加 retries 或放宽断言**：CI 那一次重试是为了吸收网络/时序抖动，
  不是掩盖真失败；同一条在本地连续红两次就是真问题。

## 4. 顺序依赖怎么规避

1. **串行是兜底，不是契约**：`workers: 1` 只保证不并发，不保证顺序稳定（`--grep`、
   重试、单跑都会打破）。用例之间不要靠「先跑 A 再跑 B」。
2. **数据自建**：需要文章 / 评论 / 鱼干的用例在 test 内用种子账号或接口现造，不用
   「上一个 spec 留下的」。
3. **只读断言优先**：能靠种子数据只读断言的，不要写库。
4. **必须写库的用例自己清理**（或落在自己的唯一标识下），避免污染后续用例。
5. **vitest 侧同理**：每进程独立库 + `resetDb`，不依赖文件执行顺序。

## 5. 与构建/类型检查的关系

- e2e **不自动 build**：`npm run e2e` 读的是现有 `.next`，源码或配置改动后先
  `npm run build`（或 `npm run e2e:ci -- <spec>` 走带构建的入口）。
- 类型检查走 `npm run typecheck`（`tsconfig.typecheck.json`），**不要**裸 `npx tsc --noEmit`
  （会读到陈旧的 `.next/types`）。
- `npm run lint` 不存在，不是门禁。
