# 实时游戏服务

`services/realtime/` 是同仓库、独立进程的 Node.js WebSocket 服务。
主站继续负责页面、账号和数据库；实时服务负责连接与游戏内状态。
`shared/` 放无 Node.js、Next.js、Prisma 依赖的传输契约、Wand 地图与移动计算。

**当前交付范围**：服务可独立构建、启动和停止；提供健康检查、精确 Origin 检查、
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

先在主站 `.env` 与实时服务的独立环境中设置相同的 `REALTIME_SERVICE_TOKEN`，
使用 32–256 字符的独立随机值，不复用 `SECRET_KEY`，不提交真实凭据。
开发时实时服务的 `REALTIME_ALLOWED_ORIGINS` 设为
`http://localhost:3000,http://127.0.0.1:3000`，认证地址默认回环 3000 端口。

在仓库根目录分别启动主站与实时进程（两个终端）：

```bash
npm ci
npm run dev
# 另一个终端，先由终端环境注入实时服务配置，再执行：
npm run realtime:dev
# 默认监听 127.0.0.1:3033
curl http://127.0.0.1:3033/healthz

npm run realtime:build
npm run realtime:start
```

实时进程不自动加载 `.env`。也可把 `services/realtime/.env.example` 复制到被忽略的
`services/realtime/.env` 并填好后，用 Node 显式加载：

```bash
# 开发（替代上面的 realtime:dev）
node --env-file=services/realtime/.env --import tsx --watch services/realtime/src/main.ts
# 生产构建后运行（替代上面的 realtime:start）
node --env-file=services/realtime/.env services/realtime/dist/services/realtime/src/main.js
```

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
| `REALTIME_ALLOWED_ORIGINS` | 逗号分隔的完整 origin，无路径或尾斜杠；生产必填 |
| `REALTIME_AUTH_BASE_URL` | 主站 HTTP origin，默认 `http://127.0.0.1:3000`；非回环须 HTTPS |
| `REALTIME_SERVICE_TOKEN` | 主站与实时进程都必填，相同的独立随机凭据，32–256 字符 |
| `REALTIME_PUBLIC_ORIGIN` | **主站读取**，浏览器连接的 ws(s) origin，无路径；非回环须 wss |

开发未配置白名单时允许 `http://localhost:3000` 和 `http://127.0.0.1:3000`。
`REALTIME_PUBLIC_ORIGIN` 留空时，开发使用 `SITE_URL` 的主机加 3033 端口（可用
`REALTIME_PORT` 改）；生产使用本站同域 `/realtime/`。分域时设置此值并配置精确白名单。
可参考 `services/realtime/.env.example`，生产用服务管理器的 EnvironmentFile 注入。

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
   按用户限频 10 次 / 分钟，返回 `{ticket, expiresIn: 60, wsUrl}`；未配置服务凭据返回 503。
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

ATÅMAS 随主站原有流程部署即可。Wand 需要配置并启动实时服务；
现有主站启动命令不会自动启动第二个进程。

systemd 示例（通用示例路径，按实际环境调整）：

```ini
[Unit]
Description=Raricy realtime games
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/raricy.com
Environment=NODE_ENV=production
EnvironmentFile=/srv/raricy.com/services/realtime/.env
ExecStart=/usr/bin/node /srv/raricy.com/services/realtime/dist/services/realtime/src/main.js
Restart=on-failure
TimeoutStopSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

构建用 `npm run build`（含实时服务）或 `npm run realtime:build`。发布时分别管理主站和实时服务的重启，
重启实时服务会断开所有连接；当前没有持久化或跨实例房间恢复。
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
