# 部署与运行

> 从零到上线的完整步骤。覆盖：环境要求、`.env`、数据库、systemd、nginx、TLS、自检、备份。
> 上线前必跑自检：`npm run diagnose -- --url https://你的域名`。

## 1. 系统要求

| 项 | 要求 | 备注 |
|----|------|------|
| OS | Linux（Debian/Ubuntu/CentOS 全适用） | |
| Node.js | ≥ 20.0.0 | 项目在 22 上实测 |
| npm | ≥ 10 | `npm ci` 需要 |
| SQLite | 系统自带（无独立安装） | 通过 `better-sqlite3` / Prisma 的 sqlite 引擎访问 |
| nginx | 可选（直连 `:3000` 也行） | 推荐，反代配 cookie/CSRF 关键头 |
| systemd | 可选 | 推荐，开机自启 + 自动重启 |
| 账户服务 | 独立仓库部署；与本站 **HTTP 可达** | 否则鱼干写路径 fail-closed 503 |

不需要：Python（已无任何 Flask 代码）、MySQL/Postgres（SQLite）。

## 2. 数据目录准备（一次性）

`instance/` 是**数据**（gitignored），含头像/图床/故事/数据库。部署机器需为**真实目录**：

```bash
# 服务器上克隆仓库后
cd /srv/raricy.com
node scripts/check-instance.mjs
# 输出：✓ instance/ 骨架已就绪（/srv/raricy.com/instance）
```

或在部署脚本里嵌入：

```bash
mkdir -p /srv/raricy.com/instance/{avatars,database,images,stories,blogs}
chown -R www-data:www-data /srv/raricy.com/instance
```

`blogs/` 是历史遗留空目录，可以不存在也不影响运行。

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
| `AVATARS_DIR` / `IMAGE_UPLOAD_FOLDER` / `STORIES_DIR` | 可选 | 头像 / 图床 / 故事路径（缺省是 `./instance/...`） | 找不到头像/图床 → 404 |

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

### 首次部署（已有 `db.db` 来自历史 Flask 库）

Prisma 0_init 已基线化，**不需要跑 `prisma migrate deploy`**——库已经在基线之后了。

```bash
# 1) 校验 schema 与库一致
npm run prisma:generate
npx prisma migrate status
#   期望：Database schema is up to date!

# 2) 检查时间戳格式（dev/旧库可能是 SQLAlchemy 文本格式）
DATABASE_URL="file:./instance/database/db.db" npm run diagnose
#   段 3 会显示当前格式;Prisma 期望 INTEGER 毫秒
```

如果 `db.db` 是 Flask 时代的（DATETIME 列存 `"2026-07-16 10:00:00.123456"` 文本），
Prisma 读到会抛 `Conversion failed`（登录 500）。**这要修，但不要直接覆盖原库**：

```bash
# 推荐做法：复制 → 规整 → 换库
DATABASE_URL="file:./instance/database/db.db" npm run prepare:cutover -- \
  --source /absolute/path/to/old-db.db \
  --dest   /absolute/path/to/prod.db
# 看完逐项输出，加 --apply 才执行
```

### 全新部署（无库）

```bash
# 启动一个全新空库
DATABASE_URL="file:./instance/database/db.db" npx prisma migrate deploy
# 走 0_init 把所有表建好
```

### 修改 schema 后

```bash
# 1) 改 prisma/schema.prisma
# 2) 生成增量迁移 + 应用本地库
DATABASE_URL="file:./instance/database/dev.db" npx prisma migrate dev --name add_xxx
# 3) 看一眼生成的 prisma/migrations/<时间戳>_add_xxx/migration.sql
# 4) 提交 schema.prisma + migration.sql
# 5) 部署到生产时：
DATABASE_URL="file:./instance/database/db.db" npx prisma migrate deploy
```

> 注意：不要直接对生产库 `prisma migrate dev`（会触发 drift 检测 + reset 提议）。
> 永远 `migrate deploy` 用于生产。

## 5. 依赖安装 + 构建 + 启动

### 依赖

```bash
# 严格按 lockfile 装（不要 npm install —— 可能把 Next 升到 16.x 启动即崩）
npm ci
#   添加 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 可省 Playwright 浏览器下载（生产不需要）
```

### 构建

```bash
npm run build
```

预期：`✓ Compiled successfully` + 70+ 页全列。

### 启动

```bash
# 直接前台
npm start
# → Listening on http://0.0.0.0:3000
```

生产用 systemd，详见 §7。

## 6. nginx 反代

放在 `proxy_pass http://127.0.0.1:3000` 后，**务必透传**以下三个头（缺一必出事）：

```nginx
client_max_body_size 12m;   # 必配：图床单文件上限 10MB;nginx 默认 1MB

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $http_host;     # ← 含端口,$host 不含
    proxy_set_header X-Forwarded-Host  $http_host;     # ← 缺它:全站 POST 403
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

完整配置参考 git 历史 `docs/nextjs-migration/nginx.conf.example`（已删除；如需可参考其本质 —— 主要关键头已列上）。

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
# 只放开真正要写的目录:头像 / 图床 / 故事 / 数据库
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
# 期望:5 段全绿
#   段 0:Node/Next 版本
#   段 1:.env 必需变量
#   段 2:数据库文件存在 + 可读写
#   段 3:时间戳格式是 INTEGER 毫秒
#   段 4:鱼干密钥能解开真实密文(5/5)

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

头像 / 图床 / 故事都是不可重建数据：

```bash
tar czf /backup/assets-$(date +%Y%m%d).tar.gz \
  /srv/raricy.com/instance/{avatars,images,stories}
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
| 404 异常 IP | grep `next-auth 401` 之类的（按需要） |

## 12. 升级与日常运维

### 升级到新版

```bash
cd /srv/raricy.com
git pull
npm ci
# 如果 prisma/schema.prisma 改了
DATABASE_URL="file:./instance/database/db.db" npx prisma migrate deploy
npm run build
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
| 登录 500 Conversion failed | 时间戳是 SQLAlchemy 文本格式;跑 `npm run prepare:cutover --` |
| `prisma migrate dev` 提议 reset | 生产**永远不要**跑 `migrate dev`;改用 `migrate deploy` |
| 本地写后 E2E 跑 readonly database | Playwright e2e 测试库名必须唯一(见 `playwright.config.ts` 注释) |
| 服务器一重启站就没了 | 没装 systemd unit;装一下 |
| MySQL/Postgres 报错 | 不要用——本站是 SQLite;若想换库,先看 clauds.md 风险表 |

---

## 14. 相关文档

- `docs/architecture.md` —— 项目架构 / 路由 / 子系统
- `docs/cli.md` —— 运维 CLI（提升权限、发扣鱼干）
- `README.md` —— 快速开始
- `claude.md` —— 关键约定
