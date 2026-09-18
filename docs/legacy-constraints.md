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
> 但 Flask-Login 并不提供这个字段。它是旧版自建的、Next 继承的**安全设计**，见 §1.2。

### 1.2 我们自己的设计与对外契约 —— **不是框架痕迹**

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

## 2. 唯一保留的框架字面量

`scripts/check-links.mjs` 里有一个 `if (/FLASK_ORIGIN/.test(txt))` 的守卫。
**这是全仓仅剩的 `flask` 字样，而且是刻意留的**：`FLASK_ORIGIN` 是**被检查对象的名字**，
不是归因 —— 它当年是「回源旧后端」的源站地址，代码读到它就是拿旧部署的 origin 拼地址。
删掉这个 `if` 是**删守卫**（行为变更），不是清理注释。

今天更可能的错误是有人照旧习惯把这个变量加回去，留着零成本。

## 3. 命名与目录的结构性遗留

| 项 | 位置 | 判定 |
|---|---|---|
| `instance/` | 项目根 | §1.1 的目录约定。**整套数据全在里面，不动** |
| `public/static/**` | `public/static/{img,js}` | 「Next 的 `public/` + 旧站的 `static/`」两层叠。全站 30+ 处引用 `/static/...`，4 个 e2e 用例盯着 —— **改造成本远大于收益，不建议动** |
| `static/js/core/base.js`、`static/js/cattca.js` | `public/static/js/` | 沿用的手写 JS，`src/app/layout.tsx` 用 `<Script>` 加载。是**在跑的代码**，不是残留 |
| `instance/blogs/` | `instance/blogs/` | 6195 个**空目录**。`scripts/check-instance.mjs` 仍会创建它「以兼容老路径」 |
| 环境变量名 | `IMAGE_UPLOAD_FOLDER` / `AVATARS_DIR` / `STORIES_DIR` / `STICKERS_DIR` | 全大写 + `_FOLDER` 后缀是旧站风格。**改名会打断生产 `.env.production`**，别动 |
| `css:probe` 的产物名 | `src/styles-scss/compiled/probe.css` | 2026-09 由 `flask.css` 改名而来（唯一「名字里带 flask」的产物）。gitignored 的离线调试产物，消费方是 `tests/.tmp/*.html` 的探针 |

## 4. Python 源码本体：HEAD 已清零，git 历史仍可检出

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

## 5. 2026-09 注释清理：记录与口径

清理覆盖 **785 行 / 220 文件**（`git grep -i flask` 实测）。过程见 `99f89bf`（重写本文、
把那本旧的 flask 遗留清单整本删掉，并改 `../CLAUDE.md` 的注释约定）、`c08221f`、`a157b08`
三个提交 —— 细节不在这里留副本。

再遇到这类注释时的**铁律：绝不整行删**（整行纯溯源除外）—— 「悬空引用」与「契约」常写在
同一条里，整行删会把契约一起删掉。判例：`src/lib/checkin-service.ts` 那条「跨 UTC+8 午夜
会显示『今天还没有签到』，**这不是 bug**」，删了下一个开发者真会当 bug 修。做法是
**去出处、留契约**（`// 对齐 Flask @authenticated_required：需核心用户` → `// 需核心用户（core+）`）。

**刻意保留的**：`docs/architecture.md` 开篇边界声明与 §9「迁移史速查」、`docs/cli.md` 里
`~~flask fish compensate~~` 那种对旧命令名的删除线标注 —— 那是**历史记录**，不是参照系，
改掉反而认不出旧命令；§1.1 的技术事实（werkzeug / SQLAlchemy / Alembic / itsdangerous）
留给运维排障；指**本仓现行代码**的「对齐」照旧写（如「对齐 `src/lib/guard.ts` 的现行语义」）。

> 背景：切到 Next 之后的提交数是 **520**，整个 Flask 时期是 **353** —— Next 侧早就不是
> 「新版本」，而是这个项目的标准版本。继续把已删除的实现当参照物，对读者是悬空引用
> （那些文件不在工作区），对决策是错误归因。现行约定见 `../CLAUDE.md`「项目概述」。

## 6. 假阳性清单（搜索时会误伤）

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
| `Bootstrap 风格 / Bootstrap-like / no Bootstrap` | 十几处 `src/styles-scss/**` 注释 | **本站完全不用 Bootstrap**，这些是**类比**：类名（`.card` / `.table` / `.m*-*`）沿用了 Bootstrap 的命名与外观习惯，实现全是我们自己的。删了这些注释不会少一行样式 |
| `Bootstrap 的 show / 不是 Bootstrap 那套` | `CommentSection.tsx`、`ImagePickerModal.tsx`、两个 e2e 用例 | **防混淆警告**，价值高：站内 modal 的展开类是 `is-open` / `show`，与 Bootstrap 的不是一回事，写错就点不开 |
| `Bootstrap Icons` | `src/lib/poster.ts`、`src/styles-scss/pages/blog/_menu.scss` | 一个**图标库**的名字，与 Bootstrap 框架无关 |

## 7. 待决事项（需站长定夺）

1. **`src/app/tool/translate/` 是孤儿**（0 引用，同样不在 `ToolMenu` 里）。页面没有界面，
   只有一句服务端 `redirect('http://116.62.179.232:9198')`（`page.tsx:5`）。**未删**，
   留待你定 —— 同类的 `tool/redirect`、`new_redirect` 已作为孤儿页删掉（`a157b08`），
   它成了最后一个。写死的「IP + 端口」是**刻意的**（存在无法做 DNS 解析、只能用 IP
   访问的用户），不是待清理的旧站地址 —— 同 §1.2 的两条旧直链 rewrite。
2. **`src/app/components/CheckinCard.tsx:22` 的 `FORTUNE_LABELS[5]` 多一个尾随空格**
   （`'运势爆棚 '`），服务端 `src/lib/checkin-service.ts:55` 那份没有。服务端有单测钉着，
   客户端那份没有，于是漂了 —— 翻牌弹窗渲染的是客户端这份。**疑似真 bug，未改**。
3. **`tests/e2e/fish-layout.spec.ts:60` 有一条既有的 tsc 报错**
   （`el.innerText` 不存在于 `SVGElement | HTMLElement`），与 2026-09 清理无关，当时未动。
