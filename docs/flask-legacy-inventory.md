# Flask 残留清单

> 生产早已切到 Next（2026-07），本仓 HEAD 里**没有任何 Python 源码**。本文是**全量盘点**：
> 还剩哪些 Flask 痕迹、每一条**能不能动**、动了会坏什么。
>
> ⚠️ 先读这一句：**「痕迹」不等于「该清」**。下面第二节的兼容层一旦清掉就是静默事故
> （用户登不上、图全碎、经济账错乱），它们的存在是**设计**，不是没扫干净。

## 1. 结论

盘点结果分四类，**处理口径完全不同**：

| 类 | 是什么 | 数量级 | 口径 |
|---|---|---|---|
| **① 功能性兼容层** | 代码真的在读写 Python 时代的产物（哈希、时间戳、旧 URL、磁盘目录、幂等键） | 约 20 个模块 | **绝不能删**。删了不报错，只出事故 —— 见 §2 |
| **② 会误导人的陈旧说法** | 措辞停留在「切换前」，读起来像 Flask 还在跑 | 7 处 | **最该改的一类**，成本极低 —— 见 §3 |
| **③ 纯注释与命名** | 「对齐 Flask xxx」的溯源注释、`flask.css` 这类命名 | 约 400 行注释 | 大多**有意保留**，别当垃圾扫 —— 见 §4、§5 |
| **④ Python 源码本体** | `.py` / 模板 / Alembic | HEAD 里 **0** | 只在 git 历史里 —— 见 §6 |

**关键判据**：第 ③ 类里绝大多数是**刻意留的对照说明**，`../CLAUDE.md` 的「项目概述」一节
专门写了这件事。批量删除它们会抹掉「这段 TS 为什么长这样」的唯一线索。

## 2. 不能动的兼容层（功能性）

每一条都注明**删了会坏什么**与**守着它的测试**。

### 2.1 身份与凭据

| 项 | 位置 | 删了会坏什么 |
|---|---|---|
| werkzeug 密码哈希校验/生成 | `src/lib/password.ts` | **存量用户全部登不上**。库里 `password_hash` 是 werkzeug 的 `scrypt:N:r:p$salt$hex`，本模块手写解析它，且新哈希也保持 werkzeug 可读（双向过渡） |
| 同上，被这三处复用 | `src/lib/credential-auth.ts`、`src/lib/oauth.ts`、`src/app/api/fish/market/_auth.ts` | 鱼干市场凭据、OAuth `client_secret` 与网页登录**必须逐字同一份实现**，否则同一密码在不同入口结论不同 |
| `session_version` 失效机制 | `src/lib/session.ts`、`src/lib/auth.ts` | 改密 / 强制下线后旧会话**不失效** —— 已登录的攻击者继续能用 |
| `?next=` 回跳 | `src/lib/safe-url.ts`、`src/lib/guard.ts` | 登录后回不到原页（`docs/architecture.md` §8 的四个 guard 全依赖它） |
| Fernet 密钥派生 | `src/lib/account-client.ts` | 派生方式 `base64url(sha256(keySource))` 与 Flask `app/utils/AES.py` 一致。**改了就解不开存量 `fish_api_key_encrypted`** —— 全站鱼干 503 |

### 2.2 时间

| 项 | 位置 | 说明 |
|---|---|---|
| 「UTC+8 墙上时间贴 Z 标签」 | `src/lib/db-time.ts`、`src/lib/format.ts` | 全库约 **31 万个时间戳**都是这个语义（Flask `datetime.now()` 写的 naive 时间，规整只补 `T`/`Z` 不平移）。混钟的后果全是静默的：禁言多显示 8 小时、当日发文计数跨日错位 |
| 时间戳列**必须是 INTEGER 毫秒** | `src/lib/fish-service.ts` | 旧行是 TEXT、新行是 INTEGER，**混存**；SQLite 跨存储类型比较按类型序不按数值，裸 SQL 日期函数一律不可靠。曾有实测事故：`countBlogsToday` 把历史全部文章算成「今天发的」 |

详见 `src/lib/db-time.ts` 头部（来龙去脉与反推证据）。

### 2.3 旧 URL

| 项 | 位置 | 说明 |
|---|---|---|
| `/image/i/<id>` → `/api/images/<id>/raw` | `next.config.mjs` 的 `rewrites()` | 截至 2026-09 存量：**55 篇博客 / 110 处 URL** 把旧图床直链写死在正文里。断则**存量文章全变碎图**。用 rewrite 不是 redirect：不改地址栏、不多一次往返，且 404/鉴权/`Cache-Control` 全自动继承 |
| `/auth/avatar/<id>` → `/api/avatar/<id>` | 同上 | 同上（头像直链） |
| 守它的测试 | `tests/e2e/legacy-urls.spec.ts` | 断言新旧地址取到的图 **`Buffer.compare === 0`**（不是「也返回 200 就算过」），并单独测「删掉的图仍 404」 |

⚠️ 已知无解项：正文里还有一类 `http://116.62.179.232:22822/image/i/...` —— host 写死，
站内路由管不着，只能改存量内容。站外读者可见的说明在 `docs/guide/图床使用指南.md`。

### 2.4 磁盘目录

| 项 | 位置 | 说明 |
|---|---|---|
| `instance/**` 整套布局 | `src/lib/story-service.ts`、`sticker-service.ts`、`avatar.ts`、`image-upload.ts`、`rate-limit.ts` | `instance/` 是 **Flask 的 instance 目录约定**，Next 直接沿用。**存量文件全在里面**：`avatars/` 1000+ 张、`images/` 987 个、`stories/` 8 个合集、`blogs/` 6195 个空壳目录 |
| 环境变量名 | `IMAGE_UPLOAD_FOLDER` / `AVATARS_DIR` / `STORIES_DIR` / `STICKERS_DIR` | 全大写 + `_FOLDER` 后缀是 Flask 时代风格。**改名会打断生产 `.env.production`**，别动 |
| 扫盘时跳过 `__pycache__` | `story-service.ts`、`sticker-service.ts` | 历史数据目录里真出现过 Python 副产物，跳过是防御性保留 |

### 2.5 对外契约（形状/格式必须逐字节同构）

| 项 | 位置 | 为什么不能改 |
|---|---|---|
| API JSON 一律 snake_case | `src/lib/blog-service.ts`、`comment-service.ts`、`feed-service.ts`、`src/app/api/fish/transactions/route.ts` | 旧前端与**站外机器人**按这个形状写死了。对外文档见 `docs/bot/` |
| 幂等键格式 | `src/lib/fish-compensate.ts`、`fish-admin.ts`、`checkin-service.ts`、`account-client.ts` | 远端账户微服务按键去重。`fish compensate` 的批次 ID（`uuid4().hex[:12]`）与 Flask **逐字节同构**是**刻意**的：迁移前跑了一半的批次，换个实现能接着跑 |
| 流水类型 `system_compensate` | `src/lib/fish-sync.ts`、`fish-admin.ts` | 账户服务流水里靠它区分「补偿」与「手动赠送」 |
| 字数统计 | `src/lib/blog-service.ts` 的 `countMarkdownWords` | 逐条复刻 `app/utils/markdown_countword.py` 的 5 条正则（**只有代码块那条带 `re.DOTALL`**）。漂了 → 存量文章字数集体变化 |
| identicon 算法 | `src/lib/identicon.ts` | 复刻 `avatar_generator.py`（md5 前 6 位取色、8×8 镜像网格）。**改则老用户头像图案全变** |
| 短 ID / 邀请码字符集 | `src/lib/short-id.ts`、`src/lib/invite-code.ts` | 要能继续生成/校验**存量已发出的**码 |
| 响应体 `{ code, message, ...data }` | `src/lib/format.ts` | 站外机器人按它解析 |
| 「两步式」签到 | `src/lib/checkin-service.ts` | `checkIn()` 建记录时 `fortune_value` 留 `NULL`，翻牌才填 —— Flask 原始设计，库里**真实存在**这种行 |
| CLI 退出码与旧命令名 | `scripts/cli.ts`、`scripts/cli/registry.ts` 的 `LEGACY_COMMANDS` | 0 成功 / 1 参数错 / 2 账户服务同步失败。旧命令名（`promote-owner` 等）必须继续可用，`tests/unit/cli-registry.test.ts` 是迁移完整性闸 |

### 2.6 数据库

| 项 | 位置 | 说明 |
|---|---|---|
| snake_case 表名/列名 | `prisma/schema.prisma` 的 `@map` / `@@map` | 21 张表全部沿用旧库物理名（`users`、`blog_contents`、`daily_checkins`、`image_hosting`…）。改名 = 落到不存在的列 |
| `_raricy_migrations` + `0_init` 基线 | `scripts/migrate.mjs`、`prisma/migrations/` | `0_init` 是**从 Flask 库反向生成**的建表 SQL（530 行）。接手旧库必须先 `mark` 不能 `up`，否则第一条 `CREATE TABLE "users"` 就失败。见 `docs/instance-restore.md` |
| `admin_action_logs.extra` 映射成 String | `schema.prisma` | 旧库是 JSON 声明列，Prisma 在 SQLite 上没有 Json 标量 |

## 3. 会误导人的陈旧说法（建议改）

**这类最值得处理**：不影响运行，但会让下一个读代码/文档的人（包括未来的你）走错路。
按严重度排序。

| # | 位置 | 现文 | 问题 |
|---|---|---|---|
| 1 | `prisma/schema.prisma` | `该库 schema 仍由 Flask-Migrate/Alembic 管理，不要对本库跑 prisma migrate` | 🔴 **事实错误**。schema 现在由本仓 `scripts/migrate.mjs` + `_raricy_migrations` 表管理（`docs/architecture.md` §9 的迁移史速查表明写：Alembic 31 版已删除，Prisma `0_init` 基线接管）。**结论对、理由错** —— 照此句去别处找 Alembic 会找不到，也看不到 `_raricy_migrations` 的存在 |
| 2 | `docs/deploy.md`「修改 schema 后」节 | `schema.prisma 头部明确写了「不要 prisma migrate」（0_init 是从 Flask 1:1 抄来的，Prisma 不认识 alembic 迁移历史）` | 把上一条的**错误理由二次转述**出去。改完第 1 条要一起改 |
| 3 | `.env.production.example` | `# 切换前务必：备份 → 规整 → 确认 Flask 已停写。`、`# ⚠️⚠️ 会话与加密密钥 —— 必须与 Flask 生产环境【完全一致】 ⚠️⚠️`、`SECRET_KEY="<照搬 Flask 生产 SECRET_KEY>"`、`# 真实资源目录（与 Flask 共用同一份磁盘文件）` | 这是**当前**要复制成 `.env.production` 的模板（`docs/deploy.md` §3），整段却讲「切换前」。是全仓最容易被读成「Flask 还在跑」的地方。**注意变量本身全都还得填**，要改的只是措辞（改成「沿用历史密钥值，否则存量密文解不开」） |
| 4 | `scripts/diagnose-deploy.mjs` | `'SECRET_KEY 必须与当前 Flask 生产环境用的完全一致…'`、`'把 Flask 生产 .env 里的 SECRET_KEY 原样搬过来'` | 排障时弹出的文案，同样把「历史来源」说成「当前生产」 |
| 5 | `scripts/smoke.mjs` | `if (anon.status === 403) ok('未登录访问 /blog → 403（对齐 Flask 的 abort(403)）')` | **已是死分支**：现行语义是「未登录一律 307 跳 `/login?next=`」，`tests/e2e/access-control.spec.ts` 头部明写 403 是**被取代的旧语义**。这行永远不触发，且它旁边那句还会误导排障 |
| 6 | `prisma/migrations/0_init/migration.sql` | （**零注释**，首行直接是 `-- CreateTable`） | 530 行的基线文件，来历全靠外部文档解释（`docs/deploy.md` §4、`docs/instance-restore.md`）。建议加 4 行头注释 |
| 7 | `docs/bot/fish-bot.md` | `校验的是账号密码本身（werkzeug/scrypt 哈希）` | 面向**站外机器人开发者**。技术准确，但会让外部读者推断本站后端是 Python/Flask。建议写「scrypt 哈希（werkzeug 兼容格式）」 |

（另有一处疑似笔误：`prisma/migrations/6_drop_photowall/migration.sql` 的
「图上架（0_init）时创建」读不通，疑为「建库时创建」。）

## 4. 纯注释残留（有意保留，别当垃圾清）

`src/` 里约 **400 行**提到 Flask，**全部在注释里** —— 代码本体（标识符、字符串、路由）
中没有任何 `flask`。形态高度同构：

| 主题 | 数量级 | 典型 |
|---|---|---|
| 服务层溯源 | 约 25 个 `src/lib/*.ts` | `blog-service.ts`：`博客业务逻辑（对齐 Flask app/web/blog/services/BlogService）` |
| 路由权限档位 | 约 20 个 `route.ts` | `对齐 Flask @authenticated_required：需核心用户（core 及以上）` |
| 页面/组件样式出处 | 约 15 个 `page.tsx` | `登录页 — Flask auth/login.html 样式` |
| 管理端门禁 | 约 10 个 `layout.tsx` | `仅站长可进 —— 对齐 Flask 的 @owner_required` |
| 前端交互移植 | 约 20 个 `tsx` | `VoteEmbed — 对齐 Flask app/templates/vote/detail.html` |

**它们引用的是已删除的 Python 文件路径**（`app/web/blog/services/feed_fish_service.py`
这类，全仓约 40 处）。这是**刻意的**：`../CLAUDE.md` 写明「那是给权限档位留的对照说明，
不是待恢复的代码」。清掉它们等于抹掉「这段逻辑为什么长这样」的唯一线索 —— 尤其对本仓
大量「有意偏离 Flask，原因如下」的注释，删了就把**决策**一起删了。

零散几处：

- `.gitattributes`：解释 `*.css/*.scss eol=lf` 这条规则的**原始动机**是保护入库的
  `flask.css`（产物已退库，规则仍在，注释已标注）
- `.gitignore`：`__pycache__/`、`*.pyc`（永不匹配的防御性条目，注释里自己承认了）
- `scripts/check-instance.mjs`：说明本脚本是 Python 时代 `check_instance.py` 的等价移植

## 5. 命名与目录的结构性遗留

| 项 | 位置 | 判定 |
|---|---|---|
| `instance/` | 项目根 | **Flask 的 instance 目录约定**，Next 沿用。整套数据全在里面，不动 |
| `public/static/**` | `public/static/{img,js}` | 「Next 的 `public/` + Flask 的 `static/`」两层叠在一起。全站 30+ 处引用 `/static/...`，4 个 e2e 用例盯着 —— **改造成本远大于收益，不建议动** |
| `static/js/core/base.js`、`static/js/cattca.js` | `public/static/js/` | 逐字节沿用 Flask 时代的手写 JS，`src/app/layout.tsx` 用 `<Script>` 加载。是**在跑的代码**，不是残留 |
| `css:probe` 的输出名 `flask.css` | `package.json` 第 34 行 | 唯一「名字里带 flask」的产物。它是 **gitignored 的离线调试产物**（343 KB），消费方是 `tests/.tmp/*.html` 的 4 个手工探针。要改名需同步 `package.json`、`docs/frontend-styles.md` §1、`scripts/compiled-css.mjs` 的注释，以及未入库的 `instance/css-audit.mjs` |
| `_bootstrap_fallback.scss` 的 `.bootstrap-failed` | `src/styles-scss/base/` | **死样式**：文件被 `main.scss` `@use`（会打包进 CSS），但全仓没有任何 JS/JSX 给它加类名。这是 Flask 模板 Bootstrap CDN 时代的兜底。属可清理项 |
| `instance/blogs/` | `instance/blogs/` | 6195 个**空目录**，Flask 遗留。`scripts/check-instance.mjs` 仍会创建它「以兼容老路径」。新部署可以不建 |
| `.env` 尾部的死变量 | `.env`（**gitignored，不入库**） | `SQLALCHEMY_DATABASE_URI` / `DEBUG` / `PORT` / `CONFIG_TYPE` / `TURNSTILE_SITE_KEY` 五个，注释自认「Next.js 不读」。**只在本地机器上**，`.env.example` 里没有这段 —— 但两个文件不一致本身值得对齐 |

## 6. Python 源码本体：HEAD 已清零，git 历史仍可检出

- **HEAD 里 `.py` = 0**（`git ls-tree -r HEAD` 实测）。`requirements.txt` / `Pipfile` /
  `pyproject.toml` / `setup.py` / `__pycache__` / `venv` **一条都没有**，git 跟踪与文件系统双向为零。
- 删除发生在 **`7d7be1c`（2026-07-18）**，一次提交干掉 **436 个文件**
  （其中 174 个 `.py`、79 个 `.html` 模板），`-82984` 行。同一次还把 `web-next/`
  子目录摊平到了项目根。
- **历史累计删除过 188 个 `.py` 路径、109 个 `.html` 模板**（含该提交之前的多次搬迁）。
- 这些源码**仍在 git 历史里**（`.git` 约 31 MB），随时可检出：

```bash
git show 7d7be1c^:app/models.py          # 看某个旧文件
git ls-tree -r 7d7be1c^ --name-only app/ # 列出旧 app/ 全树
```

**不建议**为了「彻底去 Flask 化」重写历史（filter-repo / BFG）：代价是全仓 commit hash
变更，收益只是让一个已删除的目录不出现在历史里。真正在意的是**工作区**，
而工作区已经干净。

## 7. 假阳性清单（搜 Flask 时会误伤）

搜 `flask` / `python` / `\.py` 时下面这些**不是残留**，别顺手清掉：

| 命中形态 | 位置 | 实际是什么 |
|---|---|---|
| `.py-4` / `.py-5` | `src/styles-scss/utilities/_spacing.scss` | **padding-block 工具类**，Bootstrap 命名 |
| `dragStartRef.current.py` | `src/app/components/ImageLightbox.tsx` | 鼠标事件的 `pageY` 简写字段 |
| `python3 -c '...urllib.parse.quote...'` | `docs/oauth.md`、`docs/bot/favorite-bot.md`、`tests/oauth-e2e.sh` | 只是 shell 里的 **URL 编码 / JSON 美化**工具。⚠️ `tests/oauth-e2e.sh` 那条是**可执行脚本**，机器上没 `python3` 会失败 —— 换成 `jq -sRr @uri` 或 `node -e` 即可彻底脱钩 |
| `aliases:["jinja"]` | `public/static/vditor/dist/` 下的 highlight.js / markmap | vendored 第三方库里的**语法高亮语言定义** |
| `makeLegacyCheckin` / `legacyRoleCommands` | `tests/`、`scripts/cli/commands/roles.ts` | 「旧」指 **Next 侧自己的旧实现**，与 Python 无关 |
| `ACCOUNT_SERVICE_URL` / `ACCOUNT_SYSTEM_KEY` | `.env*`、`src/lib/account-client.ts` | 指向 **FastAPI 账户微服务**（独立仓库）。它是 Python，但**不是 Flask，也不是本仓的代码** |
| `scripts/verify-account-integration.mjs` 里的 `seed.py` | `scripts/` | 同上，指账户微服务仓库的脚本 |
| `smoke.mjs` 里 `'未登录访问 /admin → 跳登录页且带回跳地址'` | `scripts/smoke.mjs` | 这条是**对的**，别跟第 §3 条 5 混起来一起改 |

## 8. 清理优先级建议

按「收益 ÷ 风险」排序。**前三项都是改文档/注释，零运行风险**：

1. **修 `prisma/schema.prisma` 第 22 行**（§3 第 1 条），同步 `docs/deploy.md`「修改 schema 后」。
   这是全清单唯一一处**会让人按错误前提操作**的硬伤。
2. **把 `.env.production.example` 与 `scripts/diagnose-deploy.mjs` 的措辞改完成时**
   （§3 第 3、4 条）—— 变量值不动，只改说明。
3. **改 `scripts/smoke.mjs` 的死分支与 `docs/bot/fish-bot.md` 的 `werkzeug/scrypt` 表述**
   （§3 第 5、7 条）。
4. **给 `0_init/migration.sql` 加头注释**（§3 第 6 条）—— 4 行，回报很高。
5. **删 `.bootstrap-failed` 那一族死样式**（§5）—— 确认无引用后删文件 + 去掉 `main.scss` 的 `@use`。
6. **可选**：`css:probe` 的输出改名 `probe.css`（§5）；对齐 `.env` 与 `.env.example`（§5）。

**明确不要做**：

- ❌ 清理 `src/` 里「对齐 Flask …」的注释（§4）—— 那是刻意的对照说明
- ❌ 动 `public/static/` 的目录结构、`instance/` 布局、环境变量名（§5）
- ❌ 动 §2 兼容层里的任何一项
- ❌ 为了历史干净去 rewrite git history（§6）
