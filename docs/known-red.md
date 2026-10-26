# 已知长期红 / 必然失败的命令

> **这一页是台账，不是待办。** 它存在的唯一目的：让「意料之外的红」有一个**不用重新调研**
> 的判据来源。碰到红先查这里，对上了就引用对应那一行；对不上才值得花时间查。
>
> 最后校准：**2026-10-27**（`main` @ `58549116`，本机全量 `npx vitest run` 实测
> 266 文件 / 5,286 用例 / **169 s**）。每条都写明**怎么认出来**，别只看标题。

## 怎么用这一页

1. 跑出红 → 在下面找到同样的**文件 + 错误文案**。
2. 对上了 → 在回复里引用这一行（"这条是 `docs/known-red.md` 第 2 节记的既有红，原因是 …"），
   **不要**再去读源码、不要再单独跑一遍确认。
3. 对不上 → 那才可能是你刚弄坏的，值得查。

⚠️ **通用前提：先确认没有第二个进程**。`tests/.tmp/template.db` 是各测试文件共享的模板库，
两个 vitest 同时跑会互相毁掉对方（实测过 686 个 `The table main.users does not exist`）。
所以下面所有「既有红」的判据都附带一句：**你必须是在独占仓库的情况下跑出来的**。
另外本仓库常被两个 agent 共用同一工作区（Codex 也会在这里跑），
`git log` / `git stash list` 里出现你没做过的东西就是信号。

---

## 1. 已经删掉的命令：`npm run lint`

**状态**：脚本已于 2026-10-27 删除。**不会再红，因为它不存在。**

- **它曾经 100% 失败**：`next lint` 在 Next 15.5 已被弃用；更根本的是
  `node_modules/eslint` 与 `node_modules/eslint-config-next` **从未进过 lockfile**
  （`package-lock.json` 里 eslint 条目数 = 0），仓库里也没有任何 `.eslintrc*` /
  `eslint.config.*`。所以它必然会弹交互式菜单：

  ```
  ? How would you like to configure ESLint? ❯ Strict / Base / Cancel
  ```

  然后是 `⨯ `next lint` is deprecated and will be removed in Next.js 16`，exit 1。
- **历史代价**：10 次调用 / 9 个会话，**全部失败**，每次都是"弹菜单 → 卡住 / 取消 → 再试一次"。
- **判据**：如果你在别的分支 / 旧提交上看到 `next lint` 输出，那就是这个已删的脚本。
  **不要把它当门禁修** —— 要 lint 就得先把 `eslint` + `eslint-config-next` 装进
  `devDependencies` 并落一份配置，那是一次独立改动。
- 替代：类型检查走 `npm run typecheck`（见 `CLAUDE.md`「验证纪律」）。

## 2. 需要 `prisma generate` 才能过的红

**状态**：不是测试坏，是**生成物陈旧**。**不是既有红，是可以自己修好的。**

- **怎么认**：满屏 `Module '"@prisma/client"' has no exported member 'xxx'`，
  或 `PrismaClient` 上找不到模型。
- **原因**：`npm ci` 会把 `node_modules/.prisma/client` 一起清掉，而 `postinstall`
  **不跑** `prisma generate`。
- **修法**：`npx prisma generate`，**不用改任何代码、不用重跑别的**。
- 另一条同源：改了 `schema.prisma` 的 `@default` 之后也必须重新 generate ——
  默认值是烘进 client 的。症状会**指向断言而不是根因**（2026-09 实测：
  把 `Blog.visibility` 默认值从 `'private'` 改成 `'internal'` 后，15 条用例报
  `expected 'private' to be 'internal'`，看着像"迁移没生效"，实际是 client 陈旧）。

## 3. `.next/types` 陈旧导致的幻影类型错误

**状态**：**不是既有红，是构建产物陈旧**。已从根上修掉（`npm run build` 现在会先删它）。

- **怎么认**：`npx tsc --noEmit` 报 `Cannot find module '.../page.js'` /
  `File '.../.next/types/app/xxx/layout.ts' not found`，而那个路由**在源码里存在**
  （或者早已删掉）。实测踩过 4 条指向**已删除的 `photowall` 路由**的幻影错误。
- **原因**：根 `tsconfig.json` 的 `include` 里有 `.next/types/**/*.ts`，而它是构建产物、
  不随源码删改即时更新。
- **现在的做法**：
  - 只想确认自己改的代码对不对 → `npm run typecheck`（读 `tsconfig.typecheck.json`，
    **不碰 `.next/types`**）。
  - 要完整构建 → `npm run build`（`scripts/build.mjs` 会先删 `.next/types`）。
- **别再**：手动 `rm -rf .next` 再 build（整个 `.next` 常被别的进程占着，Windows 上会以
  `Directory not empty` 半途失败，而失败信息看着像权限问题）。

## 4. `EPERM: operation not permitted, rename '…node_modules\.prisma\client…'`

**状态**：**不是测试坏，是进程抢占。** 实测出现 9 次。

- **怎么认**：构建或 `prisma generate` 报 `EPERM ... rename`，指向 `.prisma/client`。
- **原因**：Prisma 在重新生成时会 rename 客户端目录，而**还有 `next start` / `next dev`
  在跑**（它攥着里面的文件）。
- **最常见的触发方式**：`Get-Process node | Stop-Process -Force` / `taskkill /F /IM node.exe`
  把一堆进程强杀在半途。实测这样干过 **76 次 / 29 个会话**。
- **修法**：精确杀端口占用者，别群杀——

  ```powershell
  Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess |
    ForEach-Object { Stop-Process -Id $_ }
  ```

## 5. `webServer was not able to start`（e2e）

**状态**：**不是测试坏，是端口/进程/构建产物问题。** 实测出现 8 次。

- **怎么认**：Playwright 一条用例都没跑就报这个，后面跟 `port 3100 is already used` 或
  启动超时。
- **三个原因，按概率**：
  1. 上一轮的 `next start` 没退干净（尤其群杀之后留下僵尸）。
     查：`Get-NetTCPConnection -LocalPort 3100,3102,3103`。
  2. `.next` 里没有构建产物，或产物是旧的 —— `npm run e2e` **不会**帮你 build。
     要 build 就先 `npm run build`，或直接用 `npm run e2e:ci`。
  3. 并发跑了两个 playwright（`tests/.tmp/e2e-*` 与端口都会撞）。
- **修法**：先 `Get-NetTCPConnection` 找占用者精确杀掉，再 `npm run build`，再跑。

## 6. `Test timed out in 5000ms`

**状态**：**默认超时太短**，不是死锁。已把 `testTimeout` / `hookTimeout` 调到 30 s。

- **怎么认**：报 `Test timed out in 5000ms`，但那条用例单独跑是过的。
- **原因**：默认 5 s 对**建库 + 种子**类用例不够。实测有一条配额用例要 **2357 ms**，
  在 `maxWorkers: 4` 下被别的文件抢 CPU 就翻过 5 s。
- **现状**：`vitest.config.ts` 已设 `testTimeout: 30_000` / `hookTimeout: 30_000`。
  同一批文件加 `--testTimeout=30000` 后 94/94 全绿。
- **如果你还看到 5000ms**：说明你在跑一个**没读到本仓 `vitest.config.ts`** 的调用
  （例如带了自己的 `--config`，或从别的目录跑）。

## 7. `The table main.users does not exist` / `no such table:`

**状态**：**并发污染**，不是既有红。实测最大的假红来源（257 次 + 46 个表族）。

- **怎么认**：成片地、跨很多文件地报缺表；同一个文件单独跑就全绿。
- **原因**：`tests/global-setup.ts` 建模板库 `tests/.tmp/template.db`，各文件
  `ensureSchema()` 去 `copyFile` 它。**两个 vitest 同时跑时**，后启动的会重建模板，
  先启动的正好拷到半成品。
- **已修**（2026-10-27）：模板改成「schema 哈希没变就跳过重建 + 构建到临时名再原子
  `rename`」，`copyTemplate()` 还会重试。同一个实验从 **686 个 DB 错误 / 14 文件红**
  降到 **0 错误 / 172 全绿**。
- **但纪律不变**：**别并发跑两套测试**。看到这一条先确认没有第二个 vitest，
  也不要去改代码。

## 8. 他人未完成的 WIP 会让全量出现一片红

**状态**：**不是你的红，也不是既有红**，是工作区里有别人（或另一个 agent）没写完的改动。

- **判据**：`git status` 里有你**没改过**的文件是 modified。本仓常见：另一个 agent
  在改 `src/lib/reactive/`、或往 `tests/e2e/` 加探针 spec。
- **2026-10-27 实测一例**：`src/lib/reactive/host-components.ts` 里有人加了
  `AUTHOR_HTML_OPTIONS`（`enableExtendedHtml: true`）并 spread 进
  `reactiveCompileOptions()`。它让 **7 个测试文件 / 21 条用例**转红，错误全是
  「编译产物是空的」（`expected [] to have a length of 1`、`expected '' to be '标题 …'`、
  `expected { ok: true } to deeply equal { ok: false }`）。把那两行临时摘掉后
  **106/106 全绿** —— 证明与其它改动无关。
- **怎么处理**：**别去修他的代码，也别把它当成既有红记死**。要么等它完成，
  要么在干净的 `git worktree` 上验证自己的改动。回复里说清"这 21 条红来自工作区里
  未提交的 `<路径>`，不是我的改动"，比逐个调研省一个数量级的时间。

## 9. `docs-xref` / `docs-catalog` 报某个 `.md` 不存在或没登记

**状态**：**这是你引入的**，不是既有红。守卫工作正常。

- **`docs-xref`**：`CLAUDE.md` 或别的文档里用反引号引用了 `docs/<名字>.md`，但文件不存在。
  报错形如：``这些文档引用了不存在的文件：CLAUDE.md:267 → docs/&lt;名字&gt;.md``。
- **`docs-catalog`**：`docs/` 下多了一份 `.md` 却没登记进 `src/lib/docs-catalog.ts`
  （漏登记 = 它在站上不出现且**不报错**，所以守卫是双向对账的）。
  **新增/改名/删除文档必须同步那张表**，且表里的 `title` 要与文档 H1 一致。
- **修法**：引用了就建文件（或去掉引用）；加了文件就登记。

## 10. 真正没有既有红（2026-10-27 校准结论）

把第 8 节那批 WIP 影响排除、且独占仓库跑的情况下，**全量 266 文件 / 5,286 用例全绿**。
也就是说：

- **没有「反正它就是红的」这种文件**。`css-tsx-classes.test.ts` 曾经是唯一一条慢性红
  （`.tsx` 里用了没定义的类名），已于 2026-10-27 补齐白名单修好。
- 所以**别再写「那 1 条是既有失败」然后跳过**。历史上有 9 次这样的表述
  （例："全量 vitest：4849 passed / 1 failed。那 1 条是既有失败"），其中至少一次
  就是本可以顺手修好的。
- 如果你跑出红而这一页对不上，**那就是真红**。查它。

---

## 维护这一页

- **改动了让某条失效的东西**（例如真的把 eslint 装回来了、或修好了某批用例），
  就**同时改这里**。一份过期的台账比没有更糟：它会让人跳过真正的新红。
- 新增一条的判据：它必须**至少出现过两次**，且第二次有人**重新调研了一遍**。
  只出现一次的是偶发，不是台账材料。
- 引用 `CLAUDE.md` 的「验证纪律」一节（那一节讲**怎么跑**，这一页讲**怎么读红**）。
