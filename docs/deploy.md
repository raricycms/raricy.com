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
| 账户服务 | 独立仓库部署；与本站 **HTTP 可达** | 否则鱼干写路径 fail-closed 503 |
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
mkdir -p /srv/raricy.com/instance/{avatars,database,images,stories,stickers,blogs}
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
| `SECRET_KEY` | ✅ | JWT 签名 + 鱼干密钥派生源 | 详见下文 |
| `FISH_ENCRYPTION_KEY` | ⚠️ | 鱼干密钥派生（优先生效） | 详见下文 |
| `ALLOWED_ORIGINS` | ⚠️ | CSRF 白名单 | 必填或反代必透传 `X-Forwarded-Host` |
| `COOKIE_SECURE` | 可选 | cookie `Secure` 标记 | 配错则登录"成功但不粘" |
| `ACCOUNT_SERVICE_*` | ⚠️ | 账户微服务连接 | 投喂/签到/注册/CLI → 503 |
| `FISH_SERVICE_ACCOUNTS` | 可选 | 鱼干服务账号白名单（逗号分隔的 **user id**）：转账配额 30/200 → 500/5000，给站外银行这类自动化账号用（`docs/bot/fish-bot.md` §4） | 留空 = 无人享受高配额，不影响其他功能 |
| `FISH_WEBHOOK_DRAIN_MS` | 可选 | 收款回调的投递扫描间隔（毫秒，默认 `30000`）。**`0` = 关闭定时投递** | 关掉后回调只会由 `fish webhook-retry` 推动；`/fish/api` 上登记的地址照样收不到通知 |
| `FISH_WEBHOOK_TIMEOUT_MS` | 可选 | 单次回调投递的超时（毫秒，默认 `5000`） | 商户端点慢于这个值会被判失败并重试 |
| `AVATARS_DIR` / `IMAGE_UPLOAD_FOLDER` / `STORIES_DIR` / `STICKERS_DIR` | 可选 | 头像 / 图床 / 故事 / 表情包路径（缺省是 `./instance/...`） | 找不到头像/图床 → 404；**找不到表情素材则全站表情静默降级成纯文本 token**（启动时打一行 warn），见 `docs/guide/表情包使用指南.md` |

### `SECRET_KEY` 的硬要求

- **跨环境保持一致**：从生产环境**原样搬过来**，不要重新生成。
- 它是 JWT 签名密钥，也是鱼干用户 API Key 字段的加密密钥派生源。
- 切换期若改了，全库已加密的 API Key 全解不开 → 鱼干功能集体失效、**不可逆**。
- 验证方式：`npm run diagnose` 段 4 会抽 5 条库内真实密文试解报对错。

### `FISH_ENCRYPTION_KEY` 必须留空

- **首次部署既有库**：留空。否则派生密钥变了，存量密文全解不开。
- 全新部署 / 空库：可独立设值，与 SECRET_KEY 解耦。

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
# 之后按 .env.production.example 填 SECRET_KEY / ACCOUNT_* 等即可
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
# 如果 account-service 在同机,加上让它先起来
# After=account-service.service
# Wants=account-service.service

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
#   段 4:小鱼干密钥(切换前必查,错了不可逆)
#   段 5:画报中文字体 —— 服务器缺字体时画报上的字全是豆腐块,而二维码仍能扫
#         (接口 200、图能生成、也能扫,是最容易漏掉的"半坏"状态)
#   段 6:练手盘行情源 —— 出口不通时 /fish/trade 一直"行情暂不可用",站点其余部分正常
#         (同上,另一个"半坏"状态;换 MARKET_PRICE_BASE_URL 即可,不用改代码)
#   段 7:线上活体检查(仅当带 --url)

# 11 条只读冒烟(需真实账号)
npm run smoke -- --url https://raricy.com --user <核心用户> --pass <密码>
# 覆盖:HTTPS / 公开页 / CSRF / 登录态/列表/详情/图床体积/角色门控
```

报红就别往下走 —— 别跟自己过不去。

## 10. 备份

### 数据库（每日）

```bash
sqlite3 /srv/raricy.com/instance/database/db.db ".backup /backup/db-$(date +%Y%m%d).db"
```

> 用 `.backup` 而不是 `cp`：cp 在有 WAL 时会拷到不一致快照。

### 文件资产

头像 / 图床 / 故事 / 表情包都是不可重建数据（表情包素材由站长手工放进 `instance/stickers/`，
**不入 git 仓库**，丢了就只能找原出处重下）：

```bash
tar czf /backup/assets-$(date +%Y%m%d).tar.gz \
  /srv/raricy.com/instance/{avatars,images,stories,stickers}
```

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
| 鱼干对账窗口日志 | grep `ACCOUNT_RECONCILE_REQUIRED` —— 出现要人工核账 |
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

### 升级 account-service（独立仓库）

不在本仓——拉独立仓库的发布说明。与本站通常**独立发布**，但写路径会因账户服务停而 fail-closed 503，请错峰升级。

## 13. 故障排查速查

| 症状 | 原因 / 兜底 |
|------|------------|
| 登录接口返 200 但刷新没登录 | cookie 没 `Secure` 但走 HTTP;或反代未透传 `X-Forwarded-Proto` |
| 全站 POST 403 | `X-Forwarded-Host` 未透传;设 `ALLOWED_ORIGINS` 兜底 |
| 图床 413 | nginx `client_max_body_size` ≤ 1MB;改成 12m |
| 小鱼干 503 | 账户服务不通或不配 `ACCOUNT_SERVICE_INTERNAL_TOKEN`(fail-closed) |
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
