# 历史遗留约束清单

> 项目 2026-07 由上一版实现（Flask 单体）整体重写为当前的 Next.js 实现。
> 2026-09 做过一轮全仓清理，把**「向已删除的实现看齐」**的注释写法清干净了 —— 记录见 §4。
> 本文留下的是**清理之后仍然动不得的东西**，以及它们为什么动不得。
>
> ⚠️ 判据只有一条：**「是不是因为用了 Flask 才长这样」**。
> 大量所谓「兼容层」其实是**我们自己的设计与对外契约** —— 换任何框架写一遍值都一样。
> 把它们叫「框架包袱」会误导后来人，也会让真正的技术约束藏在噪声里（见 §2.2）。

## 1. 清理后的现状

清理前的基线（HEAD，`git grep -i flask` 实测），以及清理后的残留：

| 区域 | 清理前 | 清理后 |
|---|---|---|
| `src/` | 433 行 / 155 文件 | 保留 §2.1 的技术事实（werkzeug / SQLAlchemy / itsdangerous 等），无框架归因 |
| `tests/` | 212 行 / 36 文件 | **0** |
| `scripts/` | 47 行 / 15 文件 | 1 处：`check-links.mjs` 的 `FLASK_ORIGIN`（见 §3） |
| `docs/` | 73 行 / 7 文件 | 显式的迁移史章节 + §2.1 的技术事实（见 §4.3） |
| `prisma/` | 3 行 / 1 文件 | 0 |
| 根配置 | 17 行 / 6 文件 | 受 §2.1 保护的密钥来源说明 |
| **合计** | **785 行 / 220 文件** | — |

## 2. 继承的约束（不能删）

### 2.1 上一版技术栈留下的物理形态（真·框架痕迹）

这六项的共同点：**如果当年用的不是 Flask，它们根本不会长这样**。

| 项 | 位置 | 为什么 |
|---|---|---|
| werkzeug 密码哈希格式 | `src/lib/password.ts` | 库里 `password_hash` 躺的是 werkzeug 生成的 `scrypt:N:r:p$salt$hex`。**生态库的默认选择**，不是我们的设计。新哈希也保持 werkzeug 可读（双向过渡），改动即等于让存量用户重置密码 |
| Fernet 密钥派生自 `SECRET_KEY` | `src/lib/account-client.ts` | 派生方式 `base64url(sha256(keySource))` 来自旧实现，且**密钥源是旧站的 `SECRET_KEY` 体系**。改了就解不开存量 `fish_api_key_encrypted` —— 全站鱼干 503 |
| 时间戳的 TEXT 存储形态 | `src/lib/fish-service.ts`、`src/lib/db-time.ts` | SQLAlchemy 把 `datetime.now()` 按 `"YYYY-MM-DD HH:MM:SS.ffffff"` 写成 **TEXT**；新行是 INTEGER，**混存**。SQLite 跨存储类型比较按类型序不按数值，裸 SQL 日期函数一律不可靠 |
| 物理库由 Alembic 建出 | `prisma/migrations/0_init/migration.sql` | 530 行基线是从 Alembic 管出来的真库反向生成的。接手已有库必须先 `mark` 不能 `up` |
| `instance/` 目录名 | 项目根 | 旧框架的 instance 目录约定，Next 直接沿用。**存量文件全在里面** |
| `?next=` 回跳语义 | `src/lib/safe-url.ts`、`src/lib/guard.ts` | 源自旧站的 `login_view` 行为，现在是既定契约（登录后必须回原页） |

> ⚠️ `session_version` 失效机制**不属于这一类** —— 它常被说成「对齐 Flask-Login」，
> 但 Flask-Login 并不提供这个字段。它是旧版自建的、Next 继承的**安全设计**，见 §2.2。

### 2.2 我们自己的设计与对外契约 —— **不是框架痕迹**

这八项经常被误列进「框架兼容层」。**当年就算用 Django / Rails / 纯 WSGI 写，值也一模一样**。
它们不能改，是因为**存量数据与对外契约按这个口径存在**，不是因为框架。

| 项 | 位置 | 真正的理由（与框架无关） |
|---|---|---|
| identicon 算法 | `src/lib/identicon.ts` | md5 前 6 位取色、8×8 镜像网格、底色 (240,240,240)。**改则老用户头像图案全变** |
| 字数统计正则 | `src/lib/blog-service.ts` 的 `countMarkdownWords` | 5 条正则（**只有代码块那条跨行**）。改则存量文章字数集体变化 |
| 两步式签到 | `src/lib/checkin-service.ts` | `checkIn()` 建记录时 `fortune_value` 留 `NULL`，翻牌才填。**是我们刻意这么设计的**，库里真实存在这类行 |
| 短 ID / 邀请码字符集 | `src/lib/short-id.ts`、`src/lib/invite-code.ts` | 要能继续校验**存量已发出的**码（12 位 base62，注册侧按 `length===12` 校验） |
| 幂等键格式 | `src/lib/fish-compensate.ts`、`fish-admin.ts`、`checkin-service.ts`、`account-client.ts` | 远端账户微服务按键去重；批次 ID 逐字节稳定是**刻意的**，为了让迁移前跑了一半的批次能续跑 |
| API JSON snake_case 形状 | `src/lib/blog-service.ts` 等 | **对外契约**：站外机器人按这个形状写死了。对外文档见 `docs/bot/` |
| 权限档位语义 | `src/lib/guard.ts`、`src/lib/admin-user-service.ts` | 角色阶梯（user → core → admin → owner）是**产品设计**，见 `docs/architecture.md` §8 |
| `session_version` 失效机制 | `src/lib/session.ts`、`src/lib/auth.ts` | 改密 / 禁言 / 强制下线要让旧会话立即失效 —— **安全需求** |

**其余同样不能删、但同属「契约」而非「框架」的**：`next.config.mjs` 的两条旧直链
rewrite（存量 55 篇 / 110 处写死的图床地址，见 `tests/e2e/legacy-urls.spec.ts`）、
snake_case 表名（`@map`，改则落到不存在的列）、`_raricy_migrations` 跟踪表、
CLI 退出码与 `LEGACY_COMMANDS` 旧命令名。

## 3. 唯一保留的框架字面量

`scripts/check-links.mjs` 里有一个 `if (/FLASK_ORIGIN/.test(txt))` 的守卫。
**这是全仓仅剩的 `flask` 字样，而且是刻意留的**：`FLASK_ORIGIN` 是**被检查对象的名字**，
不是归因 —— 它当年是「回源旧后端」的源站地址，代码读到它就是拿旧部署的 origin 拼地址。
删掉这个 `if` 是**删守卫**（行为变更），不是清理注释。

今天更可能的错误是有人照旧习惯把这个变量加回去，留着零成本。

## 4. 2026-09 清理记录

### 4.1 处置口径

清理**不是**无脑删注释。按性质分五类：

| 类 | 处置 | 例 |
|---|---|---|
| **P1 纯溯源** | 删出处分句 | `// blog-service.ts — 博客业务逻辑（对齐 Flask …/BlogService）` → 删括号 |
| **P2「与旧版一致」型** | 改写成**说清为什么改不得** | `// 背景 (240,240,240)，与 Flask 一致` → `// 背景 (240,240,240) —— 改则存量用户头像图案全变` |
| **P3 决策记录** | **保留原因**，只去归因 | `⚠️【有意偏离 Flask】…` → `⚠️ 这里 X 是有意的：<原因>` |
| **P4 夹带的** | 去出处、留契约（最常见） | `// 对齐 Flask @authenticated_required：需核心用户` → `// 需核心用户（core+）` |
| **P5 技术事实** | **保留技术内容**，主语换掉 | `Flask 用的是 itsdangerous 签名的 cookie` → `旧版用的是 …` |

**铁律**：绝不整行删（整行纯溯源除外）。很多注释是「悬空引用」与「契约」写在同一条里，
整行删会把契约一起删掉 —— 最典型的是 `checkin-service.ts` 那条「跨 UTC+8 午夜会显示
『今天还没有签到』，**这不是 bug**」，删了下一个开发者真会当 bug 修。

### 4.2 同步的约定（重要）

`../CLAUDE.md` 的「项目概述」里那条旧约定（「这些注释是**刻意留的对照说明**，
不是待恢复的代码」）**已随之改写**。它成立的前提是「Python 版仍是参照系」，而
**参照系已经反转**：切到 Next 之后的提交数是 **520**，整个 Flask 时期是 **353** ——
Next 侧早就不是「新版本」，而是这个项目的标准版本。继续把已删除的实现当参照物，
对读者是悬空引用（那些文件不在工作区），对决策是错误归因。

现行约定：**代码注释不向已删除的实现看齐**，一律自足；技术事实（§2.1）照实写。

### 4.3 刻意保留的

- **显式的迁移史章节**：`docs/architecture.md` 开篇的边界声明与 §9「迁移史速查」、
  `docs/cli.md` 里 `~~flask fish compensate~~` 那种对旧命令名的删除线标注 —— 那是
  **历史记录**，不是参照系，改掉反而认不出旧命令。
- **§2.1 的技术事实**：werkzeug / SQLAlchemy / Alembic / itsdangerous 的提法全部保留，
  运维排障要靠它们。
- **指本仓现行代码的「对齐」**：例如「对齐 `src/lib/guard.ts` 的现行语义」——
  「对齐」在这里指**我们自己的代码**，不是 Flask 痕迹。

### 4.4 这一轮顺带发现的问题

| 问题 | 处置 |
|---|---|
| `tests/oauth-e2e.sh` 用 `python3` 做 URL 编码 —— 本机 `python3` 解析到 Microsoft Store 占位符，**退出码 0 但输出空串**，`redirect_uri=` 一直是空的 | ✅ 改成 node 实现的 `urlencode()`，与真 Python 逐字节对拍验证等价 |
| 给 `prisma/migrations/0_init/migration.sql` 加头注释后，`migrate verify` 报 checksum 漂移（该命令比对**文件全文**哈希，注释也算） | ✅ 已 `npm run migrate -- mark 0_init` 修复。**存量库需要各跑一次 mark** —— 见 §8 |
| `src/styles-scss/base/_bootstrap_fallback.scss` 实测无任何引用，但 `docs/frontend-styles.md` §12 把它列为「刻意保留」 | ❌ **未删**，两份文档口径不一致，交站长定夺（§8） |

## 5. 命名与目录的结构性遗留

| 项 | 位置 | 判定 |
|---|---|---|
| `instance/` | 项目根 | §2.1 的目录约定。**整套数据全在里面，不动** |
| `public/static/**` | `public/static/{img,js}` | 「Next 的 `public/` + 旧站的 `static/`」两层叠。全站 30+ 处引用 `/static/...`，4 个 e2e 用例盯着 —— **改造成本远大于收益，不建议动** |
| `static/js/core/base.js`、`static/js/cattca.js` | `public/static/js/` | 沿用的手写 JS，`src/app/layout.tsx` 用 `<Script>` 加载。是**在跑的代码**，不是残留 |
| `instance/blogs/` | `instance/blogs/` | 6195 个**空目录**。`scripts/check-instance.mjs` 仍会创建它「以兼容老路径」 |
| 环境变量名 | `IMAGE_UPLOAD_FOLDER` / `AVATARS_DIR` / `STORIES_DIR` / `STICKERS_DIR` | 全大写 + `_FOLDER` 后缀是旧站风格。**改名会打断生产 `.env.production`**，别动 |
| `css:probe` 的产物名 | `src/styles-scss/compiled/probe.css` | 2026-09 由 `flask.css` 改名而来（唯一「名字里带 flask」的产物）。gitignored 的离线调试产物，消费方是 `tests/.tmp/*.html` 的探针 |

## 6. Python 源码本体：HEAD 已清零，git 历史仍可检出

- **HEAD 里 `.py` = 0**（`git ls-tree -r HEAD` 实测）。`requirements.txt` / `Pipfile` /
  `pyproject.toml` / `setup.py` / `__pycache__` / `venv` **一条都没有**。
- 删除发生在 **`7d7be1c`（2026-07-18）**，一次提交干掉 **436 个文件**
  （其中 174 个 `.py`、79 个 `.html` 模板）。同一次还把 `web-next/` 摊平到了项目根。
- 这些源码**仍在 git 历史里**（`.git` 约 31 MB），随时可检出：

```bash
git show 7d7be1c^:app/models.py          # 看某个旧文件
git ls-tree -r 7d7be1c^ --name-only app/ # 列出旧 app/ 全树
```

**不建议**重写历史（filter-repo / BFG）：代价是全仓 commit hash 变更，收益只是让一个
已删除的目录不出现在历史里。真正在意的是**工作区**，而工作区已经干净。

## 7. 假阳性清单（搜索时会误伤）

搜 `flask` / `python` / `\.py` 时下面这些**不是残留**：

| 命中形态 | 位置 | 实际是什么 |
|---|---|---|
| `.py-4` / `.py-5` | `src/styles-scss/utilities/_spacing.scss` | **padding-block 工具类**，Bootstrap 命名 |
| `dragStartRef.current.py` | `src/app/components/ImageLightbox.tsx` | 鼠标事件的 `pageY` 简写字段 |
| `aliases:["jinja"]` | `public/static/vditor/dist/` 下的 highlight.js / markmap | vendored 第三方库里的**语法高亮语言定义** |
| `makeLegacyCheckin` / `legacyRoleCommands` | `tests/`、`scripts/cli/commands/roles.ts` | 「旧」指**本应用自己的旧实现** |
| 「旧实现 / 原实现」 | `src/lib/chat-service.ts`、`tests/global-setup.ts` 等 | 同上 —— 绝大多数是 Next-vs-Next 的历史，**是解释回归的正当线索，别扫** |
| `ACCOUNT_SERVICE_URL` / `ACCOUNT_SYSTEM_KEY` | `.env*`、`src/lib/account-client.ts` | 指向 **FastAPI 账户微服务**（独立仓库）。它是 Python，但**不是 Flask，也不是本仓的代码** |
| `{{` / `{%` | 各处 `.tsx` | JSX 的 `style={{…}}` 双花括号，不是 Jinja |

## 8. 待决事项（需站长定夺）

1. **三处代码字面量仍指向旧站 IP**（是行为不是注释，故未动）：
   `src/app/tool/redirect/page.tsx` 的 `http://116.62.179.232`（还被标成「本站」）、
   `src/app/tool/new_redirect/page.tsx` 的两条（「聪明山」`:5002`、「智慧河」`:22821`）、
   `src/app/tool/translate/page.tsx` 的 `redirect('http://116.62.179.232:9198')`。
   ⚠️ 顺带一提：`check-links.mjs` 的「不得写死绝对 URL」守卫只匹配 `raricy.com/...`，
   **裸 IP 从它网眼里漏过去了**。
2. **`_bootstrap_fallback.scss`**：实测无任何类名引用（`.bootstrap-failed` 全仓无人添加），
   但 `docs/frontend-styles.md` §12 列为「刻意保留」。删或留需一并改那份文档。
3. **`migrate verify` 在本机恒报 3 个漂移**（`3_fish_integer_units` / `4_chat` /
   `11_comment_attachments`）——**与本次清理无关，是既有问题**。根因：`checksumOf()`
   对**文件全文**取哈希，而本机 `core.autocrlf=true` 且 `.gitattributes` 只钉了
   `*.css` / `*.scss` 为 LF，**`*.sql` 没钉**。于是同一提交在 Windows 检出是 CRLF、
   Linux 是 LF，checksum 必然不同 —— `verify` 跨平台不可靠。
4. **`src/app/components/CheckinCard.tsx` 的 `FORTUNE_LABELS[5]` 多一个尾随空格**
   （`'运势爆棚 '`），服务端 `checkin-service.ts` 那份没有。服务端有单测钉着，
   客户端那份没有，于是漂了 —— 翻牌弹窗渲染的是客户端这份。**疑似真 bug，未改**。
5. **`0_init` 的 checksum**：本轮给它加了头注释（`mark 0_init` 已在开发库执行）。
   **每个存量库（含生产）需各跑一次 `npm run migrate -- mark 0_init`**，否则
   `npm run migrate -- verify` 会报该基线漂移。`up` 不受影响（已应用的一律跳过）。
