# 部署与运行

> 从零到上线的完整步骤。覆盖：环境要求、`.env`、数据库、systemd、nginx、TLS、自检、备份。
> 上线前必跑自检：`npm run diagnose -- --url https://你的域名`。

## 1. 系统要求

| 项 | 要求 | 备注 |
|----|------|------|
| OS | Linux（Debian/Ubuntu/CentOS 全适用） | |
| Node.js | ≥ 20.0.0 | 项目在 22 上实测 |
| npm | ≥ 10 | `npm ci` 需要 |
| SQLite | 库本身系统自带 | 应用走 Prisma 自带的 sqlite 引擎；运维脚本走 Node 内置 `node:sqlite` —— **不依赖 `better-sqlite3`**。但 `npm run prepare:cutover`（§4）与备份验证（§10）都调用系统 `sqlite3` **命令行**，用这两条路径就得装它（`apt install sqlite3`） |
| nginx | 可选（直连 `:3000` 也行） | 推荐，反代配 cookie/CSRF 关键头 |
| systemd | 可选 | 推荐，开机自启 + 自动重启 |
| **中文字体** | **必须有**（任意含 CJK 的字体，见下） | 画报 / 收款码 / **文章分享卡片**都是服务端用 sharp（librsvg + fontconfig）光栅化的，**没有中文字体时图上的字全是豆腐块**。二维码不受影响（矢量矩形），所以图能生成、也能扫 —— 只有字是方框，属于「半坏」状态，最容易漏掉。见 `npm run diagnose` 段 5「画报中文字体」 |
| **行情源出口** | **墙内服务器要实测一次** | 练手盘（`/fish/trade`）的成交价是下单那一刻向 `data-api.binance.vision` **现取**的，拉不到就拒单 —— 出口不通时那个页面一直显示「行情暂不可用」、买卖按钮点不动，而**站点其余部分完全正常**。墙对这类域名的策略会变，开发机上通不代表这台通。`npm run diagnose` 段 6 会探；不通就换 `MARKET_PRICE_BASE_URL`（`api.gateio.ws` 实测墙内可达），不用改代码 |

### 装中文字体（画报要用）

**装哪一个**——画报只需要「常用汉字 + 拉丁字母」，两者都够用，差别在体积：

| 包 | 装完体积 | 说明 |
|----|---------|------|
| `fonts-wqy-microhei` | **约 5 MB** | 文泉驿微米黑。**先试这个** —— 体积是 Noto 的 1/20，画报场景完全够 |
| `fonts-noto-cjk` | 约 90 MB+ | Noto Sans CJK。字形更精致、覆盖含日韩，代价是体积 |

`src/lib/poster.ts` 的字体栈把两个都列了（`'Noto Sans SC', …, 'WenQuanYi Micro Hei', …, sans-serif`），
装哪个都能命中，不必改代码。

```bash
# Debian / Ubuntu
apt update && apt install -y fonts-wqy-microhei     # 或 fonts-noto-cjk
fc-cache -fv                                        # 必须刷新 fontconfig 缓存
fc-list :lang=zh | head                             # 确认能列出中文字体

# CentOS / RHEL / Alma / Rocky
yum install -y wqy-microhei-fonts                   # 或 google-noto-sans-cjk-fonts
fc-cache -fv

# Alpine（将来容器化时）
apk add --no-cache font-wqy-microhei && fc-cache -fv
```

装完**重启服务**再验：

```bash
systemctl restart <你的服务名>
npm run diagnose                 # 第 5 节「画报中文字体」、第 6 节「行情源」都应当是 ✓
```

> **为什么要重启**：fontconfig 的字体集是**进程内缓存**，`next start` 早已初始化过它 ——
> 不重启的话，新装的字体对那个进程不存在，你会以为「装了没用」。

**没有 root、或不想装包**：往 fontconfig 会扫的目录里丢一个 ttf/otf 再刷缓存即可。
用**系统级**目录（`/usr/local/share/fonts/`）而不是 `~/.local/share/fonts/` —— 除非你确定
systemd 服务跑的就是那个用户，否则服务进程根本看不到用户级目录：

```bash
mkdir -p /usr/local/share/fonts
# 从 Google Fonts（fonts.google.com/noto/specimen/Noto+Sans+SC → Download family）
# 或 noto-cjk 的 GitHub Releases 取一个 .otf/.ttf，拷进来；WQY 见 wenq.org
cp NotoSansSC-Regular.otf /usr/local/share/fonts/
fc-cache -fv && fc-list :lang=zh
```

> 探针原理（`npm run diagnose` 第 5 节）：把「聪明山」与私用区三个码位
> （正常字体里必然没有字形）各渲一张图比对 —— 缺字体时两组都是 .notdef
> （同一个豆腐块），逐像素相同。它只能告诉你「有没有」，字体好不好看得自己看一眼画报。

不需要：Python（本仓无任何 Python 代码）、MySQL/Postgres（SQLite）。

## 2. 数据目录准备（一次性）

`instance/` 是**数据**（gitignored），含头像/图床/故事/表情包/数据库。部署机器需为**真实目录**：

```bash
# 服务器上克隆仓库后
cd /srv/raricy.com
node scripts/check-instance.mjs
# 输出：✓ instance/ 骨架已就绪（/srv/raricy.com/instance）
```

或在部署脚本里嵌入：

```bash
mkdir -p /srv/raricy.com/instance/{avatars,database,images,audio,stories,stickers,blogs}
chown -R www-data:www-data /srv/raricy.com/instance
```

`blogs/` 是历史遗留目录（**全新部署时是空的；从 `instance.zip` 还原的实例里可能有几千个历史的存量文件**）。
当前没有任何代码读写它，所以可以不存在也不影响运行。

把生产 `db.db`、所有头像、所有图床、所有故事文件**按目录结构复制**到该处。

## 3. `.env` 配置

```bash
cp .env.example .env
chmod 600 .env
vim .env
```

### 关键变量详解

| 变量 | 必须 | 含义 | 配错代价 |
|------|------|------|---------|
| `DATABASE_URL` | ✅ | Prisma 库的 URL | 起不来 |
| `SECRET_KEY` | ✅ | JWT 签名密钥。**接管既有库时**它同时也是存量回调签名密钥的旧钥匙 | 详见下文 |
| `FISH_ENCRYPTION_KEY` | ⚠️ | 回调签名密钥的**专用**加密钥匙（新密文一律用它封） | 缺它 → 登记 / 换密钥的接口 503；存量仍靠 SECRET_KEY 解得开 |
| `ALLOWED_ORIGINS` | ⚠️ | CSRF 白名单 | 必填或反代必透传 `X-Forwarded-Host` |
| `COOKIE_SECURE` | 可选 | cookie `Secure` 标记 | 配错则登录"成功但不粘" |
| `ACCOUNT_SERVICE_*` | **已废除** | 账户微服务的连接四件套。账户逻辑已搬进站内，这四个变量**不再被任何代码读取** | 留着没有任何效果，删掉即可（见 §12「下线账户微服务」） |
| `FISH_SERVICE_ACCOUNTS` | 可选 | 鱼干服务账号白名单（逗号分隔的 **user id**）：转账配额 30/200 → 500/5000，给站外银行这类自动化账号用（`docs/bot/fish-bot.md` §4） | 留空 = 无人享受高配额，不影响其他功能 |
| `FISH_WEBHOOK_DRAIN_MS` | 可选 | 收款回调的投递扫描间隔（毫秒，默认 `30000`）。**`0` = 关闭定时投递** | 关掉后回调只会由 `fish webhook-retry` 推动；`/fish/api` 上登记的地址照样收不到通知 |
| `FISH_WEBHOOK_TIMEOUT_MS` | 可选 | 单次回调投递的超时（毫秒，默认 `5000`） | 商户端点慢于这个值会被判失败并重试 |
| `MARKET_PRICE_BASE_URL` | 可选 | 练手盘的行情源基址（默认 `https://data-api.binance.vision`）。**上线前必须在这台服务器上实测可达**（见 §1 系统要求表），不通就换源，不用发版 | 不通则**成交**与展示一起挂：下单/平仓 503「行情暂不可用」（这是刻意的，不降级到旧价） |
| `MARKET_POLL_MS` | 可选 | 练手盘行情的轮询间隔（毫秒，默认 `15000`）。**`0` = 关闭这条轮询**。**只刷展示缓存**，不影响任何成交价 | 关掉后若行情流也不可用，页面上的价就停在最后一轮；**它是行情流的兜底，别关** |
| `MARKET_STREAM_SILENCE_MS` | 可选 | 练手盘**实时行情流**（常驻 WebSocket）的半死阈值（毫秒，默认 `30000`）。**`0` = 关闭这条流**，展示回落到 `MARKET_POLL_MS` 那条轮询。**只喂展示**，成交价照旧现取 | 关掉只是价跳得慢（15 秒一轮），功能不受影响；需要 **Node 22+**，20 上会打一行日志后自动退化 |
| `MARKET_LIQUIDATE_MS` | 可选 | 练手盘**强平引擎**的扫描间隔（毫秒，默认 `15000`）。**`0` = 关闭它，同时一并关闭「开杠杆仓」**（`buy` 带 `leverage > 1` 会 503「杠杆暂不可用」，1 倍不受影响） | ⚠️ **别当普通的循环开关关掉**：关了它，用户手上**已经开着的**杠杆仓就没人清算 —— 仓位会停在 `open`、穿过爆仓价也不结清。要真正停掉杠杆，先把它的入口（页面上的档位）一起停，或者接受「现有杠杆仓由用户自己平」这个状态 |
| `AVATARS_DIR` / `IMAGE_UPLOAD_FOLDER` / `AUDIO_UPLOAD_FOLDER` / `STORIES_DIR` / `STICKERS_DIR` | 可选 | 头像 / 图床 / **音频床** / 故事 / 表情包路径（缺省是 `./instance/...`） | 找不到头像/图床/音频 → 404；**找不到表情素材则全站表情静默降级成纯文本 token**（启动时打一行 warn），见 `docs/guide/表情包使用指南.md` |

### 回调签名密钥的两把钥匙（接管既有库时的顺序）

回调签名密钥（`fish_webhook_endpoints.secret_encrypted`）是 Fernet 密文，钥匙由
`sha256(keySource)` 派生。**历史行是用 `SECRET_KEY` 封的**；新行一律用
`FISH_ENCRYPTION_KEY` 封；读的时候先试专用钥匙、解不开再回退 `SECRET_KEY`。

- **接管既有库的正确顺序**：`SECRET_KEY` 原样搬过来 → `FISH_ENCRYPTION_KEY` 先留空
  （存量照旧解得开）→ 设上它 → 跑一次 `npm run cli -- fish webhook-rekey`
  → 跑完 `SECRET_KEY` 就可以自由轮换了。
- **顺序反了也不炸**（读有回退，那是刻意的），但**跳过 rekey 就换 `SECRET_KEY`** 会让
  存量密文全解不开 → **商户再也收不到回调**（密文没坏，只是没了钥匙），**不可逆**。
- 全新部署 / 空库：直接设一个长随机串。留空的话**登记回调地址与换密钥这两条写路径
  会直接报错**（写路径刻意不回退到 `SECRET_KEY`：那样这个耦合会自己长回来）。
- 验证与进度：`npm run diagnose` 段 4 会逐条判「钥匙对不对」与「还剩几条没搬」——
  它是唯一的进度台账，别靠记忆。命令本身逐行判状态，可重复跑。
- 判据与实现：`src/lib/secret-box.ts` 头部（算法）+
  `src/lib/fish-webhook-service.ts` 的「回调签名密钥的钥匙」一节（策略）。

### 反向代理下的关键头

详见 §6 nginx 配置。装了 nginx 且 `proxy_set_header` 都对的话，`ALLOWED_ORIGINS` 与 `X-Forwarded-Host` 任一存在即可。**两个都配亦无害**。

## 4. 数据库准备

> `instance/` 是**唯一的数据目录**。头像 / 图床 / 故事 / 表情包 / 数据库都在这里，部署只需挂载一处。
>
> | 数据库 | 路径 | 何时用 |
> |--------|------|--------|
> | dev | `instance/database/dev.db` | 本地开发、修改 schema、写测试 |
> | prod | `instance/database/db.db` | 真实用户数据、生产部署 |

### dev 首次跑（从零起步）

```bash
cp .env.example .env       # DATABASE_URL="file:../instance/database/dev.db"

# 把生产库复制一份到 dev.db（同时规整时间戳为 INTEGER 毫秒）
npm run db:normalize
#   等价于:scripts/normalize-datetimes.mjs --source ./instance/database/db.db \
#                                          --dest ./instance/database/dev.db
#   若 instance/database/db.db 不存在,脚本直接抛「源库不存在」退出,不会建空库。

# 校验
npm run prisma:generate
npm run migrate -- status   # 期望:无 pending（跟踪表是项目自己的 _raricy_migrations）
```

> ⚠️ **没有真实库可用时**（全新 dev 机器 / CI），不要指望 `db:normalize` —— 源库不存在它会
> 直接报错退出（`normalize-datetimes.mjs` 里是 `throw`），**没有「生成空库」的分支**。
> 空库起步请走 §4「全新部署」的 `npm run migrate -- up`。

### dev 时想直接读真实库

```bash
DATABASE_URL="file:../instance/database/db.db" npm run dev
# 临时覆盖 .env 的 DATABASE_URL,不污染 .env 文件。
```

### 部署到生产

`.env.production` 必须显式用绝对路径指向 `instance/database/db.db`。Prisma 0_init 已基线化，**不需要跑 `prisma migrate deploy`**——库已经在基线之后了：

```bash
npm run prisma:generate
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- status
# 期望:无 pending（库已在 0_init 基线之后，见下方「修改 schema 后」）

DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run diagnose
# 段 3 会显示时间戳格式;Prisma 期望 INTEGER 毫秒。
```

如果生产库是历史格式的（DATETIME 列存 `"2026-07-16 10:00:00.123456"` 文本），Prisma 读到会抛 `Conversion failed`（登录 500）。**这要修，但不要直接覆盖原库**：

```bash
# 推荐做法:复制 → 规整 → 换库
npm run prepare:cutover -- \
  --source /path/to/instance/database/db.db \
  --dest   /path/to/prod-normalized.db
# 看完逐项输出,加 --apply 才执行
```

### 全新部署（空目录起步）

```bash
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- up
# 走 0_init 把所有表建好
# 之后按 .env.production.example 填 SECRET_KEY 等即可
```

> ⚠️ 不要用 `prisma migrate deploy` —— 本项目自己维护 `_raricy_migrations`
> 跟踪表，Prisma 不认识它，会试图重放 0_init 然后冲突失败（见 §4「修改 schema 后」）。

### 修改 schema 后

**本项目用 `scripts/migrate.mjs`，不用 `prisma migrate`**——因为：
- schema 由本仓 `scripts/migrate.mjs` + `_raricy_migrations` 跟踪表管理；`0_init` 是从历史库反向生成的基线，Prisma 不认识它
- `prisma migrate deploy` 会试图重放 0_init 然后冲突失败（DB 没有 `_prisma_migrations` 表）
- DateTime 格式陷阱需要我们自己 normalize，不能让 Prisma 自动跑

```bash
# 本地开发流程
# 1) 改 prisma/schema.prisma（加字段/表）
# 2) 手写 SQL 到 prisma/migrations/<n>_<name>/migration.sql
#    （<n> 是递增序号；用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 让脚本可重入）
# 3) 本地应用
DATABASE_URL="file:../instance/database/dev.db" npm run migrate -- status   # 看 pending
DATABASE_URL="file:../instance/database/dev.db" npm run migrate -- up       # 应用
# 4) 提交 schema.prisma + migration.sql + scripts/migrate.mjs（如改了）

# 部署到生产
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- status   # 看 pending
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- up       # 应用

# 从历史库接手的现有库（首次部署 OAuth 等新功能时）
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- mark 0_init
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- up
```

`npm run migrate -- verify` 比对已应用迁移的 checksum 与当前文件，发现漂移会报错。

#### 含数据变换的迁移（必须停服，别滚动）

上面那套流程对**纯 DDL** 迁移够用（加个表、加个列，新旧代码都能跑）。但**含数据变换**的
迁移不同：它把库里的值按比例改写，而**应用进程里有一个编译期常量（`FISH_UNIT_SCALE`）
必须与库里的标度同一时刻切换**。跑反了、或者两边并行了一会儿，都是**静默的错账**，
没有任何断言会当场报错：

| 顺序 | 后果 |
|------|------|
| 先迁移、后换代码 | 旧代码除以旧标度 → 余额显示成 1000 倍；写库只写 1/1000 |
| 先换代码、后迁移 | 新代码除以新标度 → 余额显示成 1/1000 |
| 两边并行（滚动重启 / 先 `npm run build` 再择机重启） | **最坏**：两个进程各按自己的标度写，流水与余额在同一个库里混着两个标度，各自内部还自洽，只有对账时才发现 |

所以含数据变换的迁移一律：

```bash
# 1) 停应用（systemd 单元 / pm2 / 你用什么停什么）—— 确认端口真的没人听了
# 2) 备份。⚠️ 必须用 SQLite 自己的机制，不能 cp：
#    库是 WAL 模式（src/lib/db.ts），cp 只拿主文件会漏掉 db.db-wal 里尚未检查点的写入，
#    得到的是一份**陈旧**快照 —— 它会「成功」，但少了最近的交易。
sqlite3 /path/to/instance/database/db.db ".backup '/path/to/backup-$(date +%F-%H%M).db'"
#    没有 sqlite3 CLI 时可用 node（VACUUM INTO 同样是一致性快照）：
#    node -e "new (require('node:sqlite').DatabaseSync)('/path/to/db.db',{readOnly:true})"
#      .exec(\"VACUUM INTO '/path/to/backup.db'\")
# 3) 迁移
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- status   # 确认 pending
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- up
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- verify
# 4) 只读核对（见下）—— **通过之后**才部署代码、启动
```

⚠️ **不要**先 `npm run build` 再择机重启：构建产物里已经带上新常量，落盘即处于危险态。

迁移后的只读核对（以 `21_fish_units_1e4` 为例，把 `1000` 换成该次的比例）：

```sql
SELECT COUNT(*) FROM users WHERE dried_fish <> ROUND(dried_fish);            -- 迁移**前**必须是 0
SELECT MAX(dried_fish), SUM(dried_fish) FROM users;                          -- 应精确 = 迁移前 ×1000
SELECT typeof(dried_fish), COUNT(*) FROM users GROUP BY 1;                   -- REAL 亲和下为 real，正常
-- 记账不变式：每人余额 == 他所有流水之和（这条不过就不要启动）
SELECT COUNT(*) FROM users u WHERE u.dried_fish <>
  (SELECT COALESCE(SUM(t.amount), 0) FROM fish_transactions t WHERE t.user_id = u.id);
SELECT name, checksum FROM _raricy_migrations WHERE name LIKE '21_%';        -- 有且仅一行
```

`21_fish_units_1e4` 会在自己的事务里写这行跟踪记录（哨兵），所以**重复执行不会二次翻倍** ——
但**千万不要手工重跑任何相对乘法的迁移**。若 `verify` 报这条迁移 checksum 漂移且值是
`pending`，说明上次「SQL 已提交、跟踪表没来得及刷新」，数据是对的，跑
`npm run migrate -- mark 21_fish_units_1e4` 刷新即可。

另注：**迁移 SQL 本身没有任何自动化测试会跑**（测试库由 `prisma db push` 建，走不到
`prisma/migrations/`）。`tests/unit/fish-migration-21.test.ts` 是为补这个洞加的：
它在临时库上照着**生产形态**（REAL 亲和列）重建这几列、灌已知值、原样执行迁移文件、
逐行断言。新增数据变换迁移时照抄那个文件的形态。

> 永远不要在生产跑 `prisma migrate dev` / `prisma db push` / `prisma migrate reset`——它们会无视 `_raricy_migrations` 直接动 schema。

## 5. 依赖安装 + 构建 + 启动

### 依赖

```bash
# 严格按 lockfile 装（不要 npm install —— 可能把 Next 升到 16.x 启动即崩）
npm ci
#   添加 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 可省 Playwright 浏览器下载（生产不需要）
```

`npm ci` 会跑 `postinstall`，把三个静态素材目录从 npm 包里**生成**出来
（它们都是包的派生产物、不入库，见 `.gitignore`）：

| 目录 | 来源包 | 少了会怎样 |
|---|---|---|
| `public/static/vditor/` | `vditor` | 编辑器图标 / 代码高亮 / 导出全 404 |
| `public/static/mathjax/` | `mathjax-full` | 公式仍显示，但用回退字体，字形与间距都不对 |
| `public/static/emoji/` | `@twemoji/svg` | 正文里的 `[@黄脸/…]` **静默降级成字面量**（不是裂图） |

> **`public/static/frames/`（头像框素材）不在上表里** —— 它是我们自己画的、
> **随代码入库**的，`git pull` 就有，不需要任何生成步骤。少了它会**静默不显示
> 头像框**（与「没发过框」长得一模一样），自查用 `npm run cli -- frame list --keys`。
> 详见 `docs/architecture.md` §6.6 与 §6.14。

⚠️ `npm ci --ignore-scripts`、或从缓存拷 `node_modules` 的构建会跳过它 —— 那种环境要
手工补一次：

```bash
npm run prepare:vditor && npm run prepare:mathjax && npm run prepare:emoji
```

### 构建

```bash
npm run build
```

`build` = `prisma generate && next build`，会先按当前 `schema.prisma` 重新生成 Prisma Client。
**不要跳过它直接 `next build`**——否则 `node_modules/.prisma/client` 还是上次生成的旧类型，
schema 新增字段（如 `focusMode`）会报 `Property 'x' does not exist on type 'SafeUser'`。

预期：`✓ Generated Prisma Client` + `✓ Compiled successfully` + 70+ 页全列。

### 启动

```bash
# 直接前台
npm start
# → Listening on http://0.0.0.0:3000
```

生产用 systemd，详见 §7。

## 6. nginx 反代

放在 `proxy_pass http://127.0.0.1:3000` 后，**务必透传**以下头（`Host` 最关键，见行内注释）：

```nginx
client_max_body_size 12m;   # 必配：图床单文件上限 10MB;nginx 默认 1MB

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $http_host;     # ← 含端口,$host 不含。缺它:CSRF 全站 403(nginx 默认把它改成 upstream 地址)
    proxy_set_header X-Forwarded-Host  $http_host;     # ← 备用来源:与 Host / ALLOWED_ORIGINS 命中任一即可
    proxy_set_header X-Forwarded-Proto $scheme;        # ← 缺它:登录成功但状态不粘
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

TLS / 证书：

```nginx
ssl_certificate     /etc/letsencrypt/live/raricy.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/raricy.com/privkey.pem;
```

关键头已列全 —— 照抄上面即可，不需要额外参考。
## 7. systemd unit 示例

`/etc/systemd/system/raricy-next.service`：

```ini
[Unit]
Description=raricy.com (Next.js)
After=network.target

[Service]
Type=simple

User=www-data
Group=www-data

WorkingDirectory=/srv/raricy.com

# 不挂 EnvironmentFile=.env —— next start 自己会读同目录的 .env
ExecStart=/srv/raricy.com/node_modules/.bin/next start -p 3000

Restart=always
RestartSec=3

StartLimitBurst=5
StartLimitIntervalSec=60

StandardOutput=journal
StandardError=journal
SyslogIdentifier=raricy-next

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
# 只放开真正要写的目录:头像 / 图床 / 故事 / 表情包 / 数据库
ReadWritePaths=/srv/raricy.com/instance

[Install]
WantedBy=multi-user.target
```

启用与检查：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now raricy-next
systemctl status raricy-next
journalctl -u raricy-next -f       # 实时日志
```

## 8. TLS 与会话 cookie

### 推荐配置

- 走 HTTPS → `COOKIE_SECURE` 留空（即 `true`），nginx 透传 `X-Forwarded-Proto: https`，cookie 自动加 `Secure`。
- 走 HTTP（仅供内网调试） → `.env` 显式 `COOKIE_SECURE="false"`。⚠️ **HTTP 下会话 cookie 明文传输，可被窃取冒用**，只用于内网验证。

### 常见坑

- 配 `Secure` 但走 HTTP → 浏览器**直接丢掉 cookie** → "登录接口返回成功，刷新仍为未登录"。
- 不配 `Secure` 但实际部署到公网 → cookie 明文传输。
- 多域名反向代理（raricy.com / zk.raricy.com） → 各域名各自的 cookie scope，只在当前域名下可用。

### 证书

- Let's Encrypt 自动续期：`sudo certbot --nginx -d raricy.com -d zk.raricy.com`。
- 验证：`systemctl list-timers | grep certbot` 或 `sudo certbot renew --dry-run`。

## 9. 上线前自检

```bash
# 必跑
cd /srv/raricy.com
npm run diagnose -- --url https://raricy.com
# 期望:7 段全绿(带了 --url 会多跑最后一段)
#   段 0:Node/Next 版本
#   段 1:环境变量
#   段 2:数据库文件
#   段 3:时间戳格式(登录 500 头号元凶)
#   段 4:回调签名密钥(上线前必查,错了不可逆)
#   段 5:画报中文字体 —— 服务器缺字体时画报上的字全是豆腐块,而二维码仍能扫
#         (接口 200、图能生成、也能扫,是最容易漏掉的"半坏"状态)
#   段 6:练手盘行情源 —— 出口不通时 /fish/trade 一直"行情暂不可用",站点其余部分正常
#         (同上,另一个"半坏"状态;换 MARKET_PRICE_BASE_URL 即可,不用改代码)
#   段 7:线上活体检查(仅当带 --url)

# 只读冒烟(需真实账号)
npm run smoke -- --url https://raricy.com --user <核心用户> --pass <密码>
# 覆盖:HTTPS / 公开页 / CSRF / 登录态/列表/详情/图床体积/音频床/指南页/角色门控
# (条数以脚本自己的输出为准 —— 这里写个数只会在下次加检查时变成一句错话)
```

报红就别往下走 —— 别跟自己过不去。

## 10. 备份

### 数据库（每日）

```bash
sqlite3 /srv/raricy.com/instance/database/db.db ".backup /backup/db-$(date +%Y%m%d).db"
```

> 用 `.backup` 而不是 `cp`：cp 在有 WAL 时会拷到不一致快照。

### 文件资产

头像 / 图床 / **音频床** / 故事 / 表情包都是不可重建数据（表情包素材由站长手工放进
`instance/stickers/`，**不入 git 仓库**，丢了就只能找原出处重下）：

```bash
tar czf /backup/assets-$(date +%Y%m%d).tar.gz \
  /srv/raricy.com/instance/{avatars,images,audio,stories,stickers}
```

> ⚠️ 这份清单要与 `scripts/check-instance.mjs` 的 `SUBDIRS` 和
> `src/lib/audio-service.ts` 那条存储域**逐项对齐** —— 漏一个目录不会报错，
> 只会在某次恢复之后表现为「那类文件全没了」。**`frames` 已经不在这里**：
> 头像框素材是我们自己画的，2026-09 起随代码入库（`public/static/frames/`）。

### `.env`（改了值就存一份）

`SECRET_KEY` 与 `FISH_ENCRYPTION_KEY` 住在里面，而**库备份里那批回调签名密钥是它们封的**
（`fish_webhook_endpoints.secret_encrypted`）：只有库、没有这两把钥匙，密文一条都解不开
（密文没坏），商户只能各自换密钥。所以 `.env` 与库**同级别**：

```bash
install -m 600 /srv/raricy.com/.env /backup/env-$(date +%Y%m%d)   # 600：里面是密钥材料
```

> ⚠️ **别把它塞进库/资产那份 tar 里** —— 密文与钥匙躺在一起等于没加密。
> 分开存、分开管权限。另：`.env` 里的 `FISH_ENCRYPTION_KEY` 一旦丢失或改错，
> 与丢失 `SECRET_KEY` 是同一类后果（`npm run diagnose` 段 4 会报出来）。

### 备份验证

```bash
sqlite3 /backup/db-20260718.db "select count(*) from users"
# 期望:与生产库行数一致
```

## 11. 监控与日志

| 项 | 命令 / 路径 |
|----|------------|
| 实时日志 | `journalctl -u raricy-next -f` |
| 错误过滤 | `journalctl -u raricy-next -p err` |
| 鱼干账目 | 已无对账日志可盯 —— 余额与流水在同一个事务里提交，没有「本地已提交、别处没落地」的窗口。要核就查库：每人 `users.driedFish` 应等于他 `fish_transactions.amount` 之和（存储单位是 0.0001 鱼干，见 `docs/architecture.md` §6.3） |
| 进程状态 | `systemctl status raricy-next` |
| 数据库大小 | `du -sh /srv/raricy.com/instance/database/db.db` |
| 404 异常 IP | 从 nginx access log 里筛 404 高频来源（按需要） |

## 12. 升级与日常运维

### 升级到新版

```bash
cd /srv/raricy.com
git pull
npm ci
# 如果 prisma/schema.prisma 改了（走项目自己的迁移脚本，不是 prisma migrate）
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- status
DATABASE_URL="file:/绝对路径/instance/database/db.db" npm run migrate -- up
npm run build     # 内含 prisma generate，会同步 Prisma Client 类型
sudo systemctl restart raricy-next
journalctl -u raricy-next -f    # 观察启动日志
```

### 升级 Node

不要用 apt 装 Node 16 那种。推荐：
- `nvm` / 官方二进制（NodeSource / Node.js foundation）
- 升级后：`hash -r npm && which node && node -v`
- 然后 `npm ci && npm run build` 重新构建 native binding

### 下线账户微服务（一次性收尾）

账户逻辑已搬进本仓：账目与业务数据在**同一个 SQLite 文件、同一个事务**里，每笔鱼干操作
就是一次普通事务。站外那台 FastAPI 服务（独立仓库）**不再被本站调用，可以下线了**：

- 停掉并禁用它的 systemd 单元，关掉它占的端口；
- 从监控 / 备份里把它摘掉（它若另有域名与证书，一并撤掉）。**不必错峰** —— 本站与它已无
  任何耦合，它停机不影响鱼干写入（当年要错峰，是因为写路径会因它不通而 fail-closed 503；
  那条依赖已经不存在了）；
- 存量 `.env` 里的 `ACCOUNT_SERVICE_*` 四个变量不再被任何代码读取 —— 留着没有任何效果，
  删掉即可（`../.env.production.example` 里也写了同一句）。

⚠️ 库里有几处**物理痕迹，别删**：`account_sync_ledger` 表现在只是幂等登记表（新行一律
`synced`）、`users.fish_api_key_encrypted` 列没有任何代码读它。清单与判据见
`docs/legacy-constraints.md` §1.1。

## 13. 故障排查速查

| 症状 | 原因 / 兜底 |
|------|------------|
| 登录接口返 200 但刷新没登录 | cookie 没 `Secure` 但走 HTTP;或反代未透传 `X-Forwarded-Proto` |
| 全站 POST 403 | `X-Forwarded-Host` 未透传;设 `ALLOWED_ORIGINS` 兜底 |
| 图床 413 | nginx `client_max_body_size` ≤ 1MB;改成 12m |
| 小鱼干相关接口报错 | 已无跨进程依赖可查（账户服务那档 503 不存在了）。业务拒绝（余额不足 / 参数非法）是 400、退出码 1；本地事务失败是真故障，500、退出码 2，此时未做任何变更、可重试。见 `docs/architecture.md` §6.3 |
| 登录 500 Conversion failed | 只在接手历史库时遇到:时间戳是 SQLAlchemy 文本格式;跑 `npm run prepare:cutover --` |
| `prisma migrate dev` 提议 reset | 生产**永远不要**跑 `prisma migrate dev` / `db push`；改用 `npm run migrate -- up` |
| 本地写后 E2E 跑 readonly database | Playwright e2e 测试库名必须唯一(见 `playwright.config.ts` 注释) |
| 服务器一重启站就没了 | 没装 systemd unit;装一下 |
| MySQL/Postgres 报错 | 不要用——本站是 SQLite;若想换库,先看 `docs/architecture.md` §10 风险表 |

---

## 14. 相关文档

- `docs/architecture.md` —— 项目架构 / 路由 / 子系统
- `docs/cli.md` —— 运维 CLI（提升权限、发扣鱼干）
- `../README.md` —— 快速开始
- `../CLAUDE.md` —— 关键约定
