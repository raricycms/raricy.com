# Flask 残留清单

> 生产早已切到 Next（2026-07），本仓 HEAD 里**没有任何 Python 源码**。
> 本文回答一个问题：**还剩哪些 Flask 痕迹、每一条该怎么处理**。
>
> ⚠️ 判据只有一条：**「是不是因为用了 Flask 才长这样」**。
> 不是所有「从旧版带过来的东西」都叫 Flask 痕迹 —— 大量所谓「兼容层」其实是
> **我们自己的业务决定**，换任何框架写一遍还是同样的值。把它们叫 Flask 痕迹会
> 误导后来人（见 §2.2），也会让真正的框架包袱藏在噪声里。

## 1. 结论

**参照系已经反转了。** 切到 Next 之后的提交数是 **520**，整个 Flask 时期是 **353** ——
Next 侧早就不是「新版本」，而是这个项目的标准版本。继续把 Python 版当参照物，
对读者是悬空引用（那些 `.py` 已经从工作区删了），对决策是错误归因。

盘点结果分四类：

| 类 | 是什么 | 规模 | 口径 |
|---|---|---|---|
| **① 框架/生态留下的** | werkzeug 密码格式、SQLAlchemy 的 TEXT 时间戳、Alembic 建出的物理库… | 6 项 | **不能删**，是数据的物理形态 —— §2.1 |
| **② 上一版实现留下的业务契约** | identicon 算法、两步式签到、幂等键格式… | 8 项 | **不能删**，但**不是 Flask 痕迹** —— §2.2 |
| **③ 措辞问题** | 把「我们自己定的」说成「旧框架逼的」 | 7 处文案 + 433 行注释 | **最该改的一类** —— §3 |
| **④ Python 源码本体** | `.py` / 模板 / Alembic | HEAD 里 **0** | 只在 git 历史里 —— §6 |

## 2. 继承的约束（不能删）

### 2.1 框架/生态留下的 —— 真·Flask 痕迹

这六项的共同点：**如果当年用的不是 Flask，它们根本不会长这样**。

| 项 | 位置 | 为什么是 Flask 的锅 |
|---|---|---|
| werkzeug 密码哈希格式 | `src/lib/password.ts` | `password_hash` 里躺的是 werkzeug 生成的 `scrypt:N:r:p$salt$hex`。**Flask 生态的默认选择**，不是我们的设计 |
| Fernet 密钥派生自 `SECRET_KEY` | `src/lib/account-client.ts` | 派生方式 `base64url(sha256(keySource))` 来自 Flask 的 `app/utils/AES.py`，且**密钥源是 Flask 的 `SECRET_KEY` 体系**。改了就解不开存量 `fish_api_key_encrypted` |
| 时间戳的 TEXT 存储形态 | `src/lib/fish-service.ts`、`src/lib/db-time.ts` | SQLAlchemy 把 `datetime.now()` 按 `"YYYY-MM-DD HH:MM:SS.ffffff"` 写成 **TEXT**；旧行至今是 TEXT，新行是 INTEGER，**混存** |
| 物理库由 Alembic 建出 | `prisma/migrations/0_init/migration.sql` | 530 行基线是从 Alembic 管出来的真库反向生成的。接手旧库必须先 `mark` 不能 `up`。见 `docs/instance-restore.md` |
| `instance/` 目录名 | 项目根 | **Flask 的 instance 目录约定**，Next 直接沿用。存量文件全在里面 |
| `?next=` 回跳语义 | `src/lib/safe-url.ts`、`src/lib/guard.ts` | 源自 Flask-Login 的 `login_view` 行为 |

> 另：`session_version` 失效机制常被说成「对齐 Flask-Login」，但 Flask-Login **并不提供**
> 这个字段 —— 它是旧版自建的、Next 继承的**业务设计**，见 §2.2。

### 2.2 上一版实现留下的业务契约 —— **不是 Flask 痕迹**

这八项常被误列进「Flask 兼容层」。它们与 Flask 框架无关：
**当年就算用 Django / Rails / 纯 WSGI 写，值也一模一样**。它们之所以不能改，
是因为**存量数据与对外契约按它们定的口径存在**，不是因为框架。

| 项 | 位置 | 真正的理由（与框架无关） |
|---|---|---|
| identicon 算法 | `src/lib/identicon.ts` | md5 前 6 位取色、8×8 镜像网格、底色 (240,240,240)。**改则老用户头像图案全变** |
| 字数统计正则 | `src/lib/blog-service.ts` 的 `countMarkdownWords` | 5 条正则（**只有代码块那条带 `re.DOTALL`**）。改则存量文章字数集体变化 |
| 两步式签到 | `src/lib/checkin-service.ts` | `checkIn()` 建记录时 `fortune_value` 留 `NULL`，翻牌才填。**是我们刻意这么设计的**（理由见该文件头部），库里真实存在这类行 |
| 短 ID / 邀请码字符集 | `src/lib/short-id.ts`、`src/lib/invite-code.ts` | 要能继续校验**存量已发出的**码 |
| 幂等键格式 | `src/lib/fish-compensate.ts`、`fish-admin.ts`、`checkin-service.ts`、`account-client.ts` | 远端账户微服务按键去重；`fish compensate` 的批次 ID 逐字节同构是**刻意的**，为了让迁移前跑了一半的批次能续跑 |
| API JSON snake_case 形状 | `src/lib/blog-service.ts` 等 | **对外契约**：站外机器人按这个形状写死了。对外文档见 `docs/bot/` |
| 权限档位语义 | `src/lib/guard.ts`、`src/lib/admin-user-service.ts` | 角色阶梯（user→core→admin→owner）是**产品设计**。见 `docs/architecture.md` §8 |
| `session_version` 失效机制 | `src/lib/session.ts`、`src/lib/auth.ts` | 改密/强制下线要让旧会话失效 —— **安全需求**，不是历史包袱 |

**其余同样不能删、但同属「契约」而非「框架」的**：`next.config.mjs` 的两条旧直链
rewrite（存量 55 篇 / 110 处写死的图床地址，见 `tests/e2e/legacy-urls.spec.ts`）、
snake_case 表名（`@map`，改则落到不存在的列）、`_raricy_migrations` 跟踪表、
CLI 退出码与 `LEGACY_COMMANDS` 旧命令名。

## 3. 措辞问题（该改的一类）

**同一个病根，两种表现**：把「我们自己定的」说成「旧框架逼的」。
前者读起来像「我们被绑住了」，后者才是事实；而且前者的**引用目标已经不存在了**，
对今天的读者不可操作。

### 3.1 陈旧说法 —— 读起来像 Flask 还在跑（7 处，改文案）

| # | 位置 | 现文 | 问题 |
|---|---|---|---|
| 1 | `prisma/schema.prisma` | `该库 schema 仍由 Flask-Migrate/Alembic 管理，不要对本库跑 prisma migrate` | 🔴 **事实错误**。schema 现在由本仓 `scripts/migrate.mjs` + `_raricy_migrations` 表管理（`docs/architecture.md` §9 的迁移史速查表明写：Alembic 31 版已删除，Prisma `0_init` 基线接管）。**结论对、理由错** —— 照此句去别处找 Alembic 会找不到，也看不到 `_raricy_migrations` |
| 2 | `docs/deploy.md`「修改 schema 后」节 | `schema.prisma 头部明确写了「不要 prisma migrate」（0_init 是从 Flask 1:1 抄来的，Prisma 不认识 alembic 迁移历史）` | 把上一条的**错误理由二次转述**出去。改第 1 条要一起改 |
| 3 | `.env.production.example` | `# 切换前务必：备份 → 规整 → 确认 Flask 已停写。`、`SECRET_KEY="<照搬 Flask 生产 SECRET_KEY>"`、`# 真实资源目录（与 Flask 共用同一份磁盘文件）` | 这是**当前**要复制成 `.env.production` 的模板（`docs/deploy.md` §3），整段却讲「切换前」。**注意变量本身全都还得填**，要改的只是措辞（改成「沿用历史密钥值，否则存量密文解不开」） |
| 4 | `scripts/diagnose-deploy.mjs` | `'SECRET_KEY 必须与当前 Flask 生产环境用的完全一致…'`、`'把 Flask 生产 .env 里的 SECRET_KEY 原样搬过来'` | 排障时弹出的文案，把「历史来源」说成「当前生产」 |
| 5 | `scripts/smoke.mjs` | `if (anon.status === 403) ok('未登录访问 /blog → 403（对齐 Flask 的 abort(403)）')` | **已是死分支**：现行语义是「未登录一律 307 跳 `/login?next=`」，`tests/e2e/access-control.spec.ts` 头部明写 403 是**被取代的旧语义** |
| 6 | `prisma/migrations/0_init/migration.sql` | （**零注释**，首行直接是 `-- CreateTable`） | 530 行基线，来历全靠外部文档解释（`docs/deploy.md` §4、`docs/instance-restore.md`）。建议加 4 行头注释 |
| 7 | `docs/bot/fish-bot.md` | `校验的是账号密码本身（werkzeug/scrypt 哈希）` | 面向**站外机器人开发者**，会让外部读者推断本站后端是 Python/Flask。建议写「scrypt 哈希（werkzeug 兼容格式）」 |

（另有一处疑似笔误：`prisma/migrations/6_drop_photowall/migration.sql` 的
「图上架（0_init）时创建」读不通，疑为「建库时创建」。）

### 3.2 框架归因 —— 注释里的 433 行（待改清单见 §4）

`src/` 里 **433 行**提到 flask，分布在 **155 个文件**。它们**全是注释** —— 代码本体
（标识符、字符串、路由）里没有任何 `flask`。

问题不在「提到了 Flask」，而在**归因错了**：

```
改前  // 对齐 Flask /clipboard/<id> 的 @authenticated_required：需核心用户。
       └─ 悬空引用（那个 .py 已经不在工作区了）─┘  └─ 真契约 ─┘

改后  // 需核心用户（core+）。

改前  // 背景 (240,240,240)，与 Flask 一致
改后  // 背景 (240,240,240) —— 改则存量用户头像图案全变
       （「与 Flask 一致」的言下之意是「改不得」，但没说清改了会怎样）

改前  // ⚠️【有意偏离 Flask】Flask 的 get_log 不过滤 visibility ——
改后  // ⚠️ 这里不过滤 visibility 是有意的：<原因>
       （价值在原因，不在把原因归给谁）
```

**⚠️ 历史沿革**：`../CLAUDE.md` 的「项目概述」此前写的是「这些注释是刻意留的对照说明，
不是待恢复的代码」—— 那条约定基于「Python 版仍是参照系」的前提。参照系反转后
（§1），约定随之调整：**注释要自足，不再向已删除的代码看齐**。
`../CLAUDE.md` 那一句必须同步改掉，否则下一个会话会按旧指令把它们护回来。

## 4. 待改清单（工作工单）

433 行按性质分五类。下面是**正则排他分类**的结果（优先级从上到下，
P3 → P5 → P2 → P1 → 其余归 P4），不是逐行终审 —— 尤其 P4 里混着少量 P2/P3，
真扫的时候要逐行判断。

| 类 | 行数 | 文件 | 处置 |
|---|---|---|---|
| **P4 夹带的** | 297 | 141 | 去掉归因，保留契约。例：`// 对齐 Flask：先校验接收者存在` → `// 先校验接收者存在` |
| **P1 纯溯源** | 91 | 52 | 删括号。例：`// blog-service.ts — 博客业务逻辑（对齐 Flask app/web/blog/services/BlogService）` → 删括号 |
| **P2 「与 Flask 一致」型** | 32 | 25 | 改写成「改则 X 会坏」。例：`// 权限：登录 + 仅作者本人或管理员可见 —— 与 Flask 一致。` → 去掉后半句（契约前半句本来就自足） |
| **P3 决策记录** | 9 | 8 | **保留原因**，只换说法。集中在 `src/lib/admin-user-service.ts`、`audit-service.ts`、`src/app/api/users/[id]/ban-history/route.ts` |
| **P5 框架层事实** | 4 | 4 | **不算待改**。`werkzeug` / `SQLAlchemy` / `itsdangerous` 出现在 `password.ts`、`fish-service.ts`、`session.ts`、`api/auth/login/route.ts` —— 它们描述的是 §2.1 的物理约束，本来就该这么说 |

复现分类：

```bash
grep -rn -i flask src | wc -l   # 433 行
grep -rl -i flask src | wc -l   # 155 个文件
```

**处置纪律**：P4 里大量行是「悬空引用」与「契约」写在同一条注释里 ——
**整行删会把契约一起删掉**。最典型的反例是 `checkin-service.ts` 里那条
「跨 UTC+8 午夜会显示『今天还没有签到』，这不是 bug」：删了，下一个人真会当 bug 修。

## 5. 命名与目录的结构性遗留

| 项 | 位置 | 判定 |
|---|---|---|
| `instance/` | 项目根 | Flask 的 instance 约定（§2.1）。**整套数据全在里面，不动** |
| `public/static/**` | `public/static/{img,js}` | 「Next 的 `public/` + Flask 的 `static/`」两层叠。全站 30+ 处引用 `/static/...`，4 个 e2e 用例盯着 —— **改造成本远大于收益，不建议动** |
| `static/js/core/base.js`、`static/js/cattca.js` | `public/static/js/` | 逐字节沿用旧版手写 JS，`src/app/layout.tsx` 用 `<Script>` 加载。是**在跑的代码**，不是残留 |
| `css:probe` 的输出名 `flask.css` | `package.json` 第 34 行 | 唯一「名字里带 flask」的产物。gitignored 的离线调试产物（343 KB），消费方是 `tests/.tmp/*.html` 的 4 个手工探针。改名需同步 `package.json`、`docs/frontend-styles.md` §1、`scripts/compiled-css.mjs` 注释，以及未入库的 `instance/css-audit.mjs` |
| `_bootstrap_fallback.scss` 的 `.bootstrap-failed` | `src/styles-scss/base/` | **死样式**：文件被 `main.scss` `@use`（会打包进 CSS），但全仓没有任何 JS/JSX 给它加类名。属可清理项 |
| `instance/blogs/` | `instance/blogs/` | 6195 个**空目录**。`scripts/check-instance.mjs` 仍会创建它「以兼容老路径」。新部署可以不建 |
| `.env` 尾部的死变量 | `.env`（**gitignored，不入库**） | `SQLALCHEMY_DATABASE_URI` / `DEBUG` / `PORT` / `CONFIG_TYPE` / `TURNSTILE_SITE_KEY` 五个，注释自认「Next.js 不读」。只在本地机器上，`.env.example` 里没有这段 —— 两个文件不一致本身值得对齐 |

## 6. Python 源码本体：HEAD 已清零，git 历史仍可检出

- **HEAD 里 `.py` = 0**（`git ls-tree -r HEAD` 实测）。`requirements.txt` / `Pipfile` /
  `pyproject.toml` / `setup.py` / `__pycache__` / `venv` **一条都没有**，git 跟踪与文件系统双向为零。
- 删除发生在 **`7d7be1c`（2026-07-18）**，一次提交干掉 **436 个文件**
  （其中 174 个 `.py`、79 个 `.html` 模板），`-82984` 行。同一次还把 `web-next/` 摊平到了项目根。
- **历史累计删除过 188 个 `.py` 路径、109 个 `.html` 模板**。
- 这些源码**仍在 git 历史里**（`.git` 约 31 MB），随时可检出：

```bash
git show 7d7be1c^:app/models.py          # 看某个旧文件
git ls-tree -r 7d7be1c^ --name-only app/ # 列出旧 app/ 全树
```

**不建议**为了「彻底去 Flask 化」重写历史（filter-repo / BFG）：代价是全仓 commit hash
变更，收益只是让一个已删除的目录不出现在历史里。真正在意的是**工作区**，而工作区已经干净。
若哪天确实需要考古，从 `7d7be1c^` 检出即可。

## 7. 假阳性清单（搜 Flask 时会误伤）

搜 `flask` / `python` / `\.py` 时下面这些**不是残留**，别顺手清掉：

| 命中形态 | 位置 | 实际是什么 |
|---|---|---|
| `.py-4` / `.py-5` | `src/styles-scss/utilities/_spacing.scss` | **padding-block 工具类**，Bootstrap 命名 |
| `dragStartRef.current.py` | `src/app/components/ImageLightbox.tsx` | 鼠标事件的 `pageY` 简写字段 |
| `python3 -c '...urllib.parse.quote...'` | `docs/oauth.md`、`docs/bot/favorite-bot.md`、`tests/oauth-e2e.sh` | 只是 shell 里的 **URL 编码 / JSON 美化**工具。⚠️ `tests/oauth-e2e.sh` 那条是**可执行脚本**，机器上没 `python3` 会失败 —— 换成 `jq -sRr @uri` 或 `node -e` 即可彻底脱钩 |
| `aliases:["jinja"]` | `public/static/vditor/dist/` 下的 highlight.js / markmap | vendored 第三方库里的**语法高亮语言定义** |
| `makeLegacyCheckin` / `legacyRoleCommands` | `tests/`、`scripts/cli/commands/roles.ts` | 「旧」指 **Next 侧自己的旧实现** |
| `ACCOUNT_SERVICE_URL` / `ACCOUNT_SYSTEM_KEY` | `.env*`、`src/lib/account-client.ts` | 指向 **FastAPI 账户微服务**（独立仓库）。它是 Python，但**不是 Flask，也不是本仓的代码** |
| `tests/oauth-e2e.sh` 里的 `python3` | `tests/` | 同上一行，与 `verify-account-integration.mjs` 里的 `seed.py` 一样指外部服务 |
| `smoke.mjs` 的 `'未登录访问 /admin → 跳登录页且带回跳地址'` | `scripts/smoke.mjs` | 这条是**对的**，别跟 §3.1 第 5 条混起来一起改 |

## 8. 清理优先级

按「收益 ÷ 风险」排序。**前四项都是改文档/注释，零运行风险**：

1. **修 `prisma/schema.prisma` 第 22 行**（§3.1 第 1 条），同步 `docs/deploy.md`「修改 schema 后」。
   这是全清单唯一一处**会让人按错误前提操作**的硬伤。
2. **把 `.env.production.example` 与 `scripts/diagnose-deploy.mjs` 的措辞改完成时**
   （§3.1 第 3、4 条）—— 变量值不动，只改说明。
3. **改 `scripts/smoke.mjs` 的死分支与 `docs/bot/fish-bot.md` 的 `werkzeug/scrypt` 表述**
   （§3.1 第 5、7 条）。
4. **给 `0_init/migration.sql` 加头注释**（§3.1 第 6 条）—— 4 行，回报很高。
5. **扫 §4 的 433 行注释**（P4/P1/P2/P3 四类），并**同步改 `../CLAUDE.md` 的那句约定**（§3.2）。
   建议按模块分批提交：`src/lib` 一批、`src/app/api` 一批、`src/app` 页面组件一批。
   P3 那 8 个文件是决策记录最密集的地方，单独一批更稳妥。
6. **删 `.bootstrap-failed` 那一族死样式**（§5）—— 确认无引用后删文件 + 去掉 `main.scss` 的 `@use`。
7. **可选**：`css:probe` 的输出改名 `probe.css`（§5）；对齐 `.env` 与 `.env.example`（§5）。

**明确不要做**：

- ❌ 动 §2.1、§2.2 里的任何一项 —— 它们要么是数据的物理形态，要么是对外契约
- ❌ 动 `public/static/` 的目录结构、`instance/` 布局、环境变量名（§5）
- ❌ 为了历史干净去 rewrite git history（§6）
