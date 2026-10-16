# 实时游戏服务

`services/realtime/` 是同仓库、与主站共同启停的 Node.js WebSocket 进程。
主站继续负责页面、账号和数据库；实时服务负责连接与游戏内状态。
`shared/` 放无 Node.js、Next.js、Prisma 依赖的传输契约、Wand 地图与移动计算。

**当前交付范围**：服务与主站统一配置、启动和停止；提供健康检查、精确 Origin 检查、
认证首帧、游戏接入接口、文本与二进制帧、心跳、大小与频率限制。
「测试」合集已接入 Wand demo，支持主站登录、一次性票据、服务端移动与多人位置同步。
ATÅMAS 在浏览器内运行，不需要这个服务。

## 1. 目录与依赖方向

```text
src/app/game/                     主站游戏页面
src/games/atamas/                 纯客户端游戏
src/games/wand/                   Wand 画布与输入客户端
src/lib/realtime-ticket-service.ts 主站瞬时票据与权限复核
shared/realtime/protocol.ts       认证与控制帧契约
shared/wand/                     地图、输入与快照契约、移动计算
services/realtime/src/
  main.ts                        进程启动、信号处理
  config.ts                      环境配置与校验
  server.ts                      HTTP / WebSocket 连接生命周期
  game.ts                        游戏、身份与会话接口
  games.ts                       显式游戏注册表
  site-auth.ts                   主站票据消费与身份复核客户端
  wand.ts                        Wand 权威移动与广播
```

共用仓库根目录的依赖与 lockfile，使用独立的 TypeScript 构建配置。
`services/realtime/dist/` 是生成目录，不提交 Git。
实时服务可以依赖 `shared/`，不能导入 `src/lib/` 的主站服务、
Prisma、Next.js 或主站会话密钥；同一源码文件在两个进程内也有两份独立状态。

## 2. 开发与运行

在仓库根目录使用原来的主站命令，一个终端即可：

```bash
npm ci
npm run dev
# 生产
npm run build
npm start
```

统一入口 `scripts/start.mjs` 使用 Next 的环境加载规则读取主站 `.env*`，开发与生产分别
选择对应环境文件。无需创建 `services/realtime/.env`，既有该文件也不会被读取。
启动时自动生成随机内部凭据，分别传给主站与实时子进程，不落盘、不复用 `SECRET_KEY`。
实时进程只接收运行所需的环境变量，不接收主站数据库地址、会话或鱼干加密密钥。

来源白名单默认从主站 `SITE_URL` 与 `ALLOWED_ORIGINS` 推导；生产至少配置其中一个。
开发额外允许实际主站端口的 localhost / 127.0.0.1。内部认证地址默认指向同一主站端口，
例如 `npm run dev -- --port 3200` 会使用 `http://127.0.0.1:3200`。
开发实时进程通过 Node watch 监测所加载的源码，修改服务或共享协议后自动重启。

退出统一入口会回收两个服务及其开发子进程；任一受管进程退出时，统一入口停止整组并
返回非零状态，由外层 systemd 统一重启。Linux 先发 SIGTERM，5 秒后强制回收；
Windows 使用进程树终止，避免遗留 Next dev / Node watch 的子进程。

进入 `/game` →「测试」→ Wand demo，登录后点击「开始联机」。
`npm run build` 同时构建主站与实时服务；`realtime:build` 只构建后者。

健康检查返回：

```json
{"ok":true,"service":"realtime","version":1,"games":["wand"]}
```

| 环境变量 | 默认 / 规则 |
|---|---|
| `REALTIME_HOST` | `127.0.0.1` |
| `REALTIME_PORT` | `3033`，整数 1–65535 |
| `REALTIME_ALLOWED_ORIGINS` | 可选覆盖；逗号分隔的完整 origin，无路径或尾斜杠；默认复用主站域名配置 |
| `REALTIME_AUTH_BASE_URL` | 可选覆盖；默认主站回环地址与实际端口；非回环须 HTTPS |
| `REALTIME_SERVICE_TOKEN` | 可选覆盖；默认每次共同启动自动生成；手动指定需 32–256 字符 |
| `REALTIME_PUBLIC_ORIGIN` | **主站读取**，浏览器连接的 ws(s) origin，无路径；非回环须 wss |

以上变量都配置在主站环境文件中。`REALTIME_PUBLIC_ORIGIN` 留空时，开发使用当前页面
的主机加 3033 端口（可用
`REALTIME_PORT` 改）；生产使用本站同域 `/realtime/`。分域时设置此值并配置精确白名单。
通常无需填写任何 `REALTIME_*` 变量；独立端口和分域配置才需要覆盖默认值。

## 3. 连接与游戏契约

浏览器连接 `wss://raricy.com/realtime/<gameId>`。路由只认已注册游戏，
不接受查询串中的票据；Origin 必须与白名单精确相等，Cookie 不参与认证。

第一条消息必须是文本 JSON：

```json
{"type":"realtime.authenticate","version":1,"ticket":"短期一次性票据"}
```

服务调用该游戏的 `authenticate({ gameId, ticket, signal })`。
认证器必须校验游戏归属、有效期和身份，并原子消费票据；验证超时或连接断开时 signal 取消。
禁止以客户端自报的 userId 建立身份。Wand 使用如下主站接口：

1. 浏览器 `POST /api/game/wand/launch`，主站通过会话 Cookie 检查登录、专注模式与当前封禁，
   按用户限频 10 次 / 分钟，返回 `{ticket, expiresIn: 60, wsUrl}`；绕过统一入口且未配置凭据时返回 503。
2. 浏览器只在 WS 首帧发送票据，不放进 URL，也不保存到 localStorage。
3. 实时进程以 `Authorization: Bearer <REALTIME_SERVICE_TOKEN>` 调用
   `POST /api/internal/realtime/session`，提交 `{action:"consume", gameId:"wand", ticket}`。
   主站在第一次 await 前消费票据，重新检查数据库中的会话版本、专注模式和当前封禁。
4. 已连接玩家每 10 秒通过同一接口的 `action:"validate"` 复核身份；主站超时、不可用或
   身份失效都关闭连接。复核 HTTP 超时 2.5 秒，传输层另设 3 秒截止。

内部接口只认独立服务凭据，浏览器 Cookie 无效，不需要主站的 JWT 密钥。
票据只存 SHA-256 摘要和可信身份，存在主站 `globalThis` Map；每人最多 4 张未消费票据，
总上限 1024，60 秒过期。主站重启会使未消费票据失效，重新申请即可；无需数据库迁移。
签发与消费依赖主站单实例，不能直接扩成多个主站进程。

认证成功后，服务先发送 `realtime.ready`（含协议版本、游戏 ID 和连接 ID），
再调用游戏的 `connect(peer)`。客户端必须等待 ready 后再发游戏帧。
`peer.identity` 含可信的用户 ID、用户名与会话版本；游戏通过 `peer.send()` 返回文本或二进制消息，
通过会话的 `receive()` 处理指令、`close()` 清理连接状态。
传输层不规定移动、房间、地图或存档格式，也不替游戏判断指令合法性。

`receive` 与 `close` 是同步接口；异步存储应在游戏自己的边界安排。
多人状态由服务端权威维护，高频更新留在内存，数据库写入按业务时机安排。
房间成员和操作权限仍须由游戏判定，建立连接不等于有权进入任意房间。

认证失败、超时、格式错误、限频和游戏异常返回稳定的 `realtime.error` 错误码，
随后关闭连接；不把票据或内部错误写进响应和日志。

### 3.1 当前连接限制

- 认证时限 5 秒，覆盖票据验证过程；未完成认证的额外帧直接拒绝。
- 客户端每条消息最多 16 KiB，每条连接每秒最多 60 条（包含认证消息）。
- 最多 256 个连接，包含尚未认证的连接；不启用帧压缩。
- 发送前若缓冲超过 256 KiB，按慢客户端断开。
- 每 30 秒 ping，下一轮仍未收到 pong 则回收。
- SIGINT / SIGTERM 停止接受新连接，通知客户端断开；3 秒后强制清理剩余连接。

票据过期只约束建连；已有连接依靠定期身份复核撤权，包括开启专注模式、封禁、
改密或强制下线造成的会话版本变化，正常情况下在 10 秒内发现，失败按超时上界关闭。

### 3.2 Wand demo

当前是一个最多 32 个连接的共享地图；每个标签页有独立连接和玩家位置，不分角色档位。
玩家从草地 `(50,50)` 出生，方向键 / WASD 或手机方向按钮移动，湖泊与边界不可穿过。
客户端发送 4 字节二进制帧：opcode `1`、方向位、uint16 大端序号；不接受客户端坐标。
服务端每 50ms 计算移动并广播 JSON `wand.snapshot`，过期或重复输入被忽略；
输入停止 250ms 后自动停步。客户端插值显示，斜向不加速。

断开会清理玩家；重连需要新票据、从出生点重新开始。实时服务重启后地图清空。
当前没有房间选择、战斗、成绩、持久化存档或跨实例同步。新增玩法在 Wand 模块内扩展，
新增游戏在注册表显式登记，并实现认证、定期复核、连接与清理接口。

## 4. 部署

主站与 Wand 共用一次构建、一个服务管理单元和一份主站环境文件。
运行 `npm start` 即同时启动两个进程；实时服务仍只监听内部 3033 端口。

systemd 示例（通用示例路径，按实际环境调整）：

```ini
[Unit]
Description=Raricy website and realtime games
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/raricy.com
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /srv/raricy.com/scripts/start.mjs start
Restart=on-failure
TimeoutStopSec=10
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

保留现有主站 systemd 单元，只把直接执行 `next start` 的入口替换为上面的统一入口，
不再创建独立实时服务单元；若此前已经创建，先停用它，避免抢占 3033 端口。
Node 路径与运行用户按实际部署填写。Next 自己也能读取主站环境文件，无需另挂环境文件。

构建用 `npm run build`（含实时服务），发布时只需重启这一个单元。
重启会断开所有游戏连接；当前没有持久化或跨实例房间恢复。
更新协议或添加游戏时，要同时检查客户端与实时服务的版本兼容。

nginx 在主站同域增加：

```nginx
location /realtime/ {
    proxy_pass http://127.0.0.1:3033;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 75s;
}
```

保留 `/realtime/` 路径交给服务校验，TLS 在 nginx 终止，浏览器使用 wss。
`/healthz` 默认只在内部端口检查，无需对外代理。
本站 iframe 与 Cookie 约定见 `docs/architecture.md` §6.4，实时服务不改变它们。
