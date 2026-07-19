# 运维 CLI 命令

> 站内给站长 / 管理员用的维护 CLI，对齐 Flask 时代的 `flask <cmd>`。
> 入口：`npm run cli -- <命令> [参数]`（用 `--` 把 npm 自己的参数与脚本参数隔开）。

> **未迁移**：Flask 时代有两个 CLI 没有 Next 版等价物——
> - `flask fish compensate`（全站群发补偿，涉及限频/批次幂等/断点续跑）
>   需要时另写专用脚本（参考 `scripts/compensate-unclaimed-fortunes.mjs`）。
> - `flask import-blogs`（历史博客导入工具；正文早已存 `BlogContent` 表，无意义）。

## 一、角色管理

角色体系：`user` → `core` → `admin` → `owner`。
详见 `claude.md` "认证与角色"。

| 命令 | 作用 | 提示 |
|------|------|------|
| `promote-admin <username>` | 提升为管理员 | 已是 admin/owner 时提示 |
| `demote-admin <username>` | 撤销管理员（降为 core） | owner 不能这么降，须先用 `demote-owner` |
| `promote-core <username>` | 提升为核心用户 | 已是 core/admin/owner 时提示 |
| `demote-core <username>` | 撤销核心用户（降为 user） | 非 core 时提示 |
| `promote-owner <username>` | 提升为站长 | 已是 owner 时提示 |
| `demote-owner <username>` | 撤销站长（保留管理员） | 非 owner 时提示 |

### 用法示例

```bash
npm run cli -- promote-admin alice
# 成功：已授予 alice 管理员权限

npm run cli -- demote-admin bob
# 提示：bob 不是管理员

npm run cli -- promote-owner charlie
# 成功：已授予 charlie 站长权限
```

⚠️ 当前 CLI **任何人都能跑**（没有二次确认 / 不要求本身是 owner）。这是历史 Flask 时代的语义延续：站点本应**只能经 SSH / 服务器登录**才能碰到该命令。生产环境务必把跑该命令的服务器 shell 列入堡垒机白名单。

## 二、小鱼干（fish）

对应账户微服务的复式记账。**写路径 fail-closed**：本地事务成功 commit 前，远端必须先同步成功；远端失败则本地事务回滚。

详见 `claude.md` "鱼干写路径" 与 `docs/历史`（账户微服务拆分历史）。

| 命令 | 作用 |
|------|------|
| `fish grant <username> <amount> [-d "说明"]` | 赠送小鱼干 |
| `fish deduct <username> <amount> [-d "说明"]` | 扣减小鱼干 |
| `fish balance <username>` | 查询余额 |

`amount` 是正整数（>0），单位是**整个小鱼干**（不是内部浮点 FISH_UNIT）。

### 用法示例

```bash
npm run cli -- fish grant alice 100 -d "手工补偿"
# 成功：已赠送 100 小鱼干给 alice
#   当前余额：100
#   已同步至账户服务

npm run cli -- fish balance alice
# alice 的小鱼干余额：100

npm run cli -- fish deduct alice 50
# 成功：已扣减 50 小鱼干从 alice
#   当前余额：50
```

未配置 `ACCOUNT_SERVICE_INTERNAL_TOKEN` 时，远端同步被跳过，CLI 会显式警告（不会假装已同步），仍能查到本地余额，方便在 dev 环境操作：

```bash
⚠️ 账户服务未配置，仅写入本地库（远端账目未同步）
```

## 三、退出码

Flask 时代的 `click` 风格，CLI 沿用：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 参数或用户错误（用户名不存在、amount 不合法、grant/deduct 业务失败） |
| `2` | **账户服务同步失败**（本地事务已回滚，余额未变） |

写入脚本可据此判定：

```bash
npm run cli -- fish grant alice 100
if [ $? -eq 2 ]; then
  echo "远端账户服务故障 — 已自动回滚，请排查账户服务后重试"
fi
```

## 四、限频（CLI 侧）

`fish grant` / `fish deduct` 命中站内内存限频规则 `RULES.fishAdmin`（默认 5 req/s）。本地连跑 5 次以上会被 `429 + Wait` 顶住。遇限频调低并发或加 `--batch-id`（如 `compensate-unclaimed-fortunes.mjs` 已支持）。

## 五、OAuth 2.0 应用

注册和管理第三方应用（client_id / client_secret / 回调 URI）。详见 `docs/oauth.md`。

### 命令

```
oauth create-app <name> [--owner <username>] [--homepage URL] [-d 说明] --redirect-uri URI [--redirect-uri URI2 ...]
oauth list-apps
oauth disable-app <id|client_id>
oauth enable-app  <id|client_id>
```

### 用法示例

```bash
# 注册一个新应用
npm run cli -- oauth create-app "cattca-game" \
  --homepage "https://cattca.example.com" \
  -d "CattCa 站点的用户绑定" \
  --redirect-uri "https://cattca.example.com/oauth/callback"

# 输出：
#   client_id:     AbCdEf123...
#   client_secret: XyZ_987...     ← 仅此一次，请立即复制
#
# ⚠️ client_secret 仅此一次显示。命令行若被记录（如 shell history、CI 日志），
#    请同步清理；推荐写到 secrets manager 而不是明文文件。

# 列出全部应用
npm run cli -- oauth list-apps

# 禁用 / 启用（按 id 或 client_id 都行）
npm run cli -- oauth disable-app AbCdEf123...
npm run cli -- oauth enable-app  AbCdEf123...
```

## 六、相关脚本

| 脚本 | 与 CLI 的关系 |
|------|---------------|
| `scripts/check-secrets.mjs` | 检测密钥与生产数据有没有进版本库 |
| `scripts/diagnose-deploy.mjs` | 部署前自检（运行时版本 / `.env` / 数据库 / 密钥） |
| `scripts/compensate-unclaimed-fortunes.mjs` | 一次性补偿「已签到未翻牌」的鱼干记录 |
| `scripts/verify-account-integration.mjs` | 端到端对账账户微服务（需独立空库） |
| `scripts/cli.mjs` | 即本文档描述的 CLI 实现 |
