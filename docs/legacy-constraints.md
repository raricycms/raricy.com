# 历史遗留约束清单

> 项目 2026-07 由上一版实现（Flask 单体）整体重写为当前的 Next.js 实现。
> 2026-09 做过一轮全仓注释清理，把**「向已删除的实现看齐」**的注释写法清干净了 —— 记录见 §5。
> 本文留下的是**清理之后仍然动不得的东西**，以及它们为什么动不得。
>
> ⚠️ 判据只有一条：**「是不是因为用了 Flask 才长这样」**。
> 大量所谓「兼容层」其实是**我们自己的设计与对外契约** —— 换任何框架写一遍值都一样。
> 把它们叫「框架包袱」会误导后来人，也会让真正的技术约束藏在噪声里（见 §1.2）。

## 1. 继承的约束（不能删）

### 1.1 上一版技术栈留下的物理形态（真·框架痕迹）

下表记录旧实现留下的物理形态与沿用的约定；其中已成为产品契约的部分，不再按框架痕迹处理。

| 项 | 位置 | 为什么 |
|---|---|---|
| werkzeug 密码哈希格式 | `src/lib/password.ts` | 库里 `password_hash` 躺的是 werkzeug 生成的 `scrypt:N:r:p$salt$hex`。**生态库的默认选择**，不是我们的设计。新哈希也保持 werkzeug 可读（双向过渡），改动即等于让存量用户重置密码 |
| Fernet 密钥派生自 `SECRET_KEY` | `src/lib/secret-box.ts` | 派生方式 `base64url(sha256(keySource))` 来自旧实现，且**当年的密钥源是旧站的 `SECRET_KEY`**。它当年服务两处凭证：用户发往账户微服务的 API Key、回调签名密钥。**前者随账户服务搬进站内一起消失，后者还是活的** —— 改了派生，`fish_webhook_endpoints.secret_encrypted` 全解不开，商户再也收不到回调、且**不可逆**。⚠️ **密钥源这一半已经可以摘掉**：写成 `FISH_ENCRYPTION_KEY`、跑 `fish webhook-rekey` 把存量重封过去即可（新行已经不碰 `SECRET_KEY` 了，见 `fish-webhook-service.ts` 的「回调签名密钥的钥匙」）—— 冻的只是**派生公式**，不是「必须挂在会话密钥上」 |
| `users.fish_api_key_encrypted` 列 | `prisma/schema.prisma` | 站外账户微服务签发的用户 API Key 的 Fernet 密文。**该服务已搬进站内，这一列没有任何代码再读它**；**已随迁移 `42_retire_residual` 删除**（停服迁移：升级前先确认该列数据可弃或备份，删除不可逆）。看到 `account_sync_ledger` 里残留的键名别以为还有远端 |
| `account_sync_ledger` 表名 | `prisma/schema.prisma`、`src/lib/fish-idempotency.ts` | 名字说的是「账户服务同步账本」（outbox），而那个机制已经不存在 —— 现在它只是一张**幂等记录**表，新行一律 `status='synced'`。表**刻意不改名**：里面有真的历史账（那些行的 payload/status 是当年对账的唯一凭据）。语义以 `fish-idempotency.ts` 头部为准 |
| 时间戳的 TEXT 存储形态 | `src/lib/fish-service.ts`、`src/lib/db-time.ts` | SQLAlchemy 把 `datetime.now()` 按 `"YYYY-MM-DD HH:MM:SS.ffffff"` 写成 **TEXT**；新行是 INTEGER，**混存**。SQLite 跨存储类型比较按类型序不按数值，裸 SQL 日期函数一律不可靠 |
| 物理库由 Alembic 建出 | `prisma/migrations/0_init/migration.sql` | 530 行基线是从 Alembic 管出来的真库反向生成的。接手已有库必须先 `mark` 不能 `up` |
| `instance/` 目录名 | 项目根 | 旧框架的 instance 目录约定，Next 直接沿用。**存量文件全在里面** |
| `?next=` 回跳语义 | `src/lib/safe-url.ts`、`src/lib/guard.ts` | 源自旧站的 `login_view` 行为，现在是既定契约（登录后必须回原页） |

> ⚠️ `session_version` 失效机制**不属于这一类** —— 它常被说成「对齐 Flask-Login」，
> 但 Flask-Login 并不提供这个字段。它是旧版自建的、Next 继承的**安全设计**，见 §1.2。

### 1.2 我们自己的设计与对外契约 —— **不是框架痕迹**

这七项经常被误列进「框架兼容层」。**当年就算用 Django / Rails / 纯 WSGI 写，值也一模一样**。
它们不能改，是因为**存量数据与对外契约按这个口径存在**，不是因为框架。

| 项 | 位置 | 真正的理由（与框架无关） |
|---|---|---|
| identicon 算法 | `src/lib/identicon.ts` | md5 前 6 位取色、8×8 镜像网格、底色 (240,240,240)。**改则老用户头像图案全变** |
| 字数统计正则 | `src/lib/blog-service.ts` 的 `countMarkdownWords` | 6 条清洗正则（代码块 / 行内代码 / 图片 / 链接 / HTML 标签 / Markdown 特殊字符；**只有代码块那条跨行**）。改则存量文章字数集体变化 |
| 短 ID / 邀请码字符集 | `src/lib/short-id.ts`、`src/lib/invite-code.ts` | 要能继续校验**存量已发出的**码（12 位 base62，注册侧按 `length===12` 校验） |
| 幂等键格式 | `src/lib/fish-idempotency.ts`、`fish-compensate.ts` | 客户端幂等键「1–48 位、`[A-Za-z0-9_.:-]`」是**对外契约**（`docs/bot/fish-bot.md` §6 按它写）。群发补偿的批次 ID 逐字节稳定是**刻意的**，为了让迁移前跑了一半的批次能续跑。**注意**：派生键前缀曾按「发往账户微服务、对方限 64 字符」设计（`xfer-{8位哈希}`）；该边界消失后 R3-314 已把**内部**身份命名空间加宽到 16 位哈希，读路径双读旧 8 位键（存量重放不变），客户端键的 1–48 位格式未变 |
| API JSON snake_case 形状 | `src/lib/blog-service.ts` 等 | **对外契约**：站外机器人按这个形状写死了。对外文档见 `docs/bot/` |
| 权限档位语义 | `src/lib/guard.ts`、`src/lib/admin-user-service.ts` | 角色阶梯（user → core → admin → owner）是**产品设计**，见 `docs/architecture.md` §8 |
| `session_version` 失效机制 | `src/lib/session.ts`、`src/lib/auth.ts` | 改密 / 禁言 / 强制下线要让旧会话立即失效 —— **安全需求** |

**其余同样不能删、但同属「契约」而非「框架」的**：`next.config.mjs` 的两条旧直链
rewrite（存量 55 篇 / 110 处写死的图床地址，见 `tests/e2e/legacy-urls.spec.ts`）、
snake_case 表名（`@map`，改则落到不存在的列）、`_raricy_migrations` 跟踪表、
CLI 退出码与 `LEGACY_COMMANDS` 旧命令名。

## 2. 唯一保留的框架字面量

`scripts/check-links.mjs` 里有一个 `if (/FLASK_ORIGIN/.test(txt))` 的守卫。
**这处字面量是刻意留的**：`FLASK_ORIGIN` 是**被检查对象的名字**，
不是归因 —— 它当年是「回源旧后端」的源站地址，代码读到它就是拿旧部署的 origin 拼地址。
删掉这个 `if` 是**删守卫**（行为变更），不是清理注释。

今天更可能的错误是有人照旧习惯把这个变量加回去，留着零成本。

## 3. 命名与目录的结构性遗留

| 项 | 位置 | 判定 |
|---|---|---|
| `instance/` | 项目根 | §1.1 的目录约定。**整套数据全在里面，不动** |
| `public/static/**` | `public/static/{img,js}` | 「Next 的 `public/` + 旧站的 `static/`」两层叠。全站 30+ 处引用 `/static/...`，4 个 e2e 用例盯着 —— **改造成本远大于收益，不建议动** |
| `static/js/core/base.js`、`static/js/cattca.js` | `public/static/js/` | 沿用的手写 JS：`base.js` 由 `src/app/layout.tsx` 用 `<Script>` 全站加载；`cattca.js` 是故事阅读器（`CattcaPlayer`）在浏览器里按需 `import` 的引擎。都是**在跑的代码**，不是残留 |
| `instance/blogs/` | `instance/blogs/` | 6195 个**空目录**。`scripts/check-instance.mjs` 仍会创建它「以兼容老路径」 |
| 环境变量名 | `IMAGE_UPLOAD_FOLDER` / `AVATARS_DIR` / `STORIES_DIR` / `STICKERS_DIR` | 全大写 + `_FOLDER` 后缀是旧站风格。**改名会打断生产 `.env.production`**，别动 |
| `css:probe` 的产物名 | `src/styles-scss/compiled/probe.css` | 2026-09 由 `flask.css` 改名而来（唯一「名字里带 flask」的产物）。gitignored 的离线调试产物，消费方是 `tests/.tmp/*.html` 的探针 |

## 4. Python 源码本体：HEAD 已清零，git 历史仍可检出

- **HEAD 里 `.py` 只剩 1 个**：`scripts/make-numeric-fonts.py`（数字字体子集化工具，与旧站无关；
  `git ls-tree -r HEAD` 实测）。`requirements.txt` / `Pipfile` / `pyproject.toml` / `setup.py` /
  `__pycache__` / `venv` **一条都没有**。
- 删除发生在 **`7d7be1c`（2026-07-18）**，一次提交干掉 **436 个文件**
  （其中 174 个 `.py`、79 个 `.html` 模板）。同一次还把 `web-next/` 摊平到了项目根。
- 这些源码**仍在 git 历史里**（`.git` 约 31 MB），随时可检出：

```bash
git show 7d7be1c^:app/models.py          # 看某个旧文件
git ls-tree -r 7d7be1c^ --name-only app/ # 列出旧 app/ 全树
```

**不建议**重写历史（filter-repo / BFG）：代价是全仓 commit hash 变更，收益只是让一个
已删除的目录不出现在历史里。真正在意的是**工作区**，而工作区已经干净。

## 5. 2026-09 注释清理：记录与口径

清理覆盖 **785 行 / 220 文件**（`git grep -i flask` 实测）。过程见 `99f89bf`（重写本文、
把那本旧的 flask 遗留清单整本删掉，并改 `../CLAUDE.md` 的注释约定）、`c08221f`、`a157b08`
三个提交 —— 细节不在这里留副本。

再遇到这类注释时的**铁律：绝不整行删**（整行纯溯源除外）—— 「悬空引用」与「契约」常写在
同一条里，整行删会把契约一起删掉。判例：`src/lib/fish-idempotency.ts` 里「键长这样是因为
当年要发往账户微服务、对方限 64 字符」—— 出处（那条远端路径）已随账户服务搬进站内一起
消失，但**格式本身仍是对外契约**（存量账目与站外机器人按它写），所以留契约、注历史。
做法是**去出处、留契约**（`// 对齐 Flask @authenticated_required：需核心用户` → `// 需核心用户（core+）`）。

**刻意保留的**：`docs/architecture.md` 开篇边界声明与 §9「迁移史速查」、`docs/cli.md` 里
`~~flask fish compensate~~` 那种对旧命令名的删除线标注 —— 那是**历史记录**，不是参照系，
改掉反而认不出旧命令；§1.1 的技术事实（werkzeug / SQLAlchemy / Alembic / itsdangerous）
留给运维排障；指**本仓现行代码**的「对齐」照旧写（如「对齐 `src/lib/guard.ts` 的现行语义」）。

> 背景：切到 Next 之后的提交数是 **520**，整个 Flask 时期是 **353** —— Next 侧早就不是
> 「新版本」，而是这个项目的标准版本。继续把已删除的实现当参照物，对读者是悬空引用
> （那些文件不在工作区），对决策是错误归因。现行约定见 `../CLAUDE.md`「项目概述」。

### 5.1 已应用迁移头部注释漂移（迁移不可改写，下列为现行口径）

已应用的迁移文件**不重写**（改写会让 `_raricy_migrations` 的 checksum 与生产库对不上）。
下列迁移头部注释与现行实现已经不符，**以本节为现行口径**，迁移文件保持原样不改：

- `1_oauth` —— 头部写「`redirect_uris` / `scopes` 是 JSON 字符串」。现行：`redirect_uris` 仍是 JSON；**`scopes` 是空格分隔字符串**（`scopesToString` = `join(' ')`，读侧 `parseStoredScopes`）。
- `2_account_sync_ledger` —— 头部描述「本地事务 → 登记 pending → 提交后调远端 → synced / compensated / failed」的远端状态机。现行：账户服务已搬进站内、远端 HTTP 路径退役，这张表只做**站内幂等登记**（转账 / 补偿的幂等键唯一存储，见 `src/lib/fish-idempotency.ts`）。
- `9_chat_prefs` —— 头部列了 `users.notify_chat`（聊天通知总开关）。现行：该列已被**迁移 10**（`10_drop_notify_chat`）删除，站内不再有账号级聊天通知开关（会话级静音 / 隐藏仍在 `chat_members`）。
- `18_market_positions` —— 头部说系统账户「只存在于远端账户服务」、并把「远端同步失败的补偿事务删掉一行」列为唯一例外。现行：账户服务退役后练手盘在站内结算，**没有补偿删行**；仓位行仍绝不物理删除。
- `23_market_leverage` —— 头部把白名单指向 `src/lib/market-service.ts` 的 `LEVERAGE_OPTIONS`。现行：杠杆词表已搬到 **`src/lib/market-leverage.ts`**（`MIN_LEVERAGE` / `MAX_LEVERAGE` / `LEVERAGE_PRESETS`；服务端只校验上下界，档位是纯 UI 快捷）。
- `32_profile_block_sort` —— 头部说手机顺序单独存 `sort` 列。现行：**`sort` 列已被迁移 42 删除**；手机顺序改为桌面坐标的投影（`projectMobile`，按 (y, x) 排序），读路径不再读该列。
- `35_reactive_md_format` —— 头部写「reactive 的写入闸门当前关闭」。现行：**写入已开放**（`resolveContentWriteFormat` 接受 reactive；语法 / 格式校验在 service 层，编不过的正文不落库）。

## 6. 假阳性清单（搜索时会误伤）

搜 `flask` / `python` / `\.py` 时下面这些**不是残留**：

| 命中形态 | 位置 | 实际是什么 |
|---|---|---|
| `.py-4` / `.py-5` | `src/styles-scss/utilities/_spacing.scss` | **padding-block 工具类**，Bootstrap 命名 |
| `dragStartRef.current.py` | `src/app/components/ImageLightbox.tsx` | 鼠标事件的 `pageY` 简写字段 |
| `makeLegacyCheckin` / `legacyRoleCommands` | `tests/`、`scripts/cli/commands/roles.ts` | 「旧」指**本应用自己的旧实现** |
| 「旧实现 / 原实现」 | `src/lib/chat-service.ts`、`tests/global-setup.ts` 等 | 同上 —— 绝大多数是 Next-vs-Next 的历史，**是解释回归的正当线索，别扫** |
| `account_sync_ledger` ~ `ACCOUNT_SERVICE_*` | `prisma/`、`src/lib/fish-idempotency.ts`、`.env*` 的注释 | 站外 **FastAPI 账户微服务**（独立仓库）的遗物 —— 它是 Python，但**不是 Flask，也不是本仓的代码**。那个服务已于 2026-09 搬进站内，见 §1.1 的三行。其中 `users.fish_api_key_encrypted` 列已随迁移 `42_retire_residual` 删除；`account_sync_ledger` 表名与 `ACCOUNT_SERVICE_*` 变量保留/无效果，见 §8 |
| `{{` / `{%` | 各处 `.tsx` | JSX 的 `style={{…}}` 双花括号，不是 Jinja |
| `Bootstrap 风格 / Bootstrap-like / no Bootstrap` | 十几处 `src/styles-scss/**` 注释 | **本站完全不用 Bootstrap**，这些是**类比**：类名（`.card` / `.table` / `.m*-*`）沿用了 Bootstrap 的命名与外观习惯，实现全是我们自己的。删了这些注释不会少一行样式 |
| `Bootstrap 的 show / 不是 Bootstrap 那套` | `CommentSection.tsx`、`ImagePickerModal.tsx`、两个 e2e 用例 | **防混淆警告**，价值高：站内 modal 的展开类是 `is-open` / `show`，与 Bootstrap 的不是一回事，写错就点不开 |
| `Bootstrap Icons` | `src/lib/poster.ts`、`src/styles-scss/pages/blog/_menu.scss` | 一个**图标库**的名字，与 Bootstrap 框架无关 |

## 7. 待决事项去向与已解决记录

2026-10-12 校对：翻译跳转入口的取舍移入 `docs/plan/maintenance-plan.md` §2。
该路由仍在，写死 IP 的使用理由保留；缺少工具箱入口不等于可以直接退役。

原列出的 `tests/e2e/fish-layout.spec.ts` 类型错误**已于 2026-09-19 修复**（`65de7568`）：
`evaluateAll` 中选中的 HTML 元素断言为 `HTMLElement[]`，不再对联合类型直接读
`innerText`。这条不再是待办；不能改用 `textContent`，否则隐藏前缀仍被计入，文案压缩
断言就失去意义。

## 8. schema 与手写迁移的已知结构差异（只记录，不擅自收敛）

生产库由 `prisma/migrations/` 的手写 SQL 建出，测试 / 模板库由 `prisma db push` 从
`prisma/schema.prisma` 生成 —— 两条路径描述同一个库，但**不是同一份真相**：
`npm run migrate -- verify` 只比迁移文件 checksum，不比结构。已知差异如下（均已核，
不逐条收敛的理由写在每行；机器比对用 `npm run schema:diff`）：

| 差异 | 生产（迁移路径） | 测试（schema 路径） | 为什么不收敛 |
|---|---|---|---|
| **外键 ON DELETE** | **7 处 `ON DELETE CASCADE`**：`1_oauth` 4 处（OAuth 授权码 / 令牌等）、`15_fish_api_tokens` 1 处、`16_fish_webhooks` 2 处 | `schema.prisma` 全文 `onDelete: Cascade` 计数为 **0**；这些关系都是必填 → `db push` 生成 `RESTRICT` | 已应用迁移不可改；`DELETE FROM users` 只在运维手工 / 未来物理删用户时才会触发，而当前产品路径是软删（`User.archivedAt`），运行期差异为零。真要收敛只能新迁移重建表，风险大于收益（R3-014 方案 B，未采纳） |
| 金额列物理类型 | `users.dried_fish` / `blog_feeds.amount` / `fish_transactions.amount` 是 SQLite **REAL** | schema 写 `Int` | 历史精度与 0.0001 单位换算依赖 REAL 的存储形态；改类型要重建表 + 全量校验，收益低 |
| `13_blog_visibility` 的列默认值 | `'private'` | `'internal'` | 插入路径全部显式给值，不依赖默认值；改迁移会改 checksum |
| 索引名 | 迁移里多为**显式命名** | Prisma 忽略 `name:` 时用派生名 | 只在 `migrate diff` / 人工比对时造成噪音，不影响查询 |
| `blogs.renderer_override` | 列在库里 | 列在 schema 里 | **保留**：对外 bot 契约字段（见 §1.1 与迁移 `42_retire_residual` 头部），退役需产品 / 文档批次 |

> 判据：这些差异**不改运行期行为**，所以只登记、不逐条收敛。`npm run schema:diff`
> 会把「迁移路径库」与「schema 路径库」逐项比对（表 / 列 / 索引 / 外键 / 触发器），
> 输出就是本表的机器版本；新增差异应先在这里登记再决定是否收敛。
