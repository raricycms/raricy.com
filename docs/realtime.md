# 实时游戏服务

`services/realtime/` 是同仓库、独立进程的 Node.js WebSocket 服务。
主站继续负责页面、账号和数据库；实时服务负责连接与游戏内状态。
`shared/realtime/` 放无 Node.js、Next.js、Prisma 依赖的传输契约。

**当前交付范围**：服务可独立构建、启动和停止；提供健康检查、精确 Origin 检查、
认证首帧、游戏接入接口、文本与二进制帧、心跳、大小与频率限制。
游戏注册表目前为空，所有游戏升级请求均返回 404。
ATÅMAS 在浏览器内运行，不需要这个服务；Wand 玩法与主站票据签发、消费尚未接入。

## 1. 目录与依赖方向

```text
src/app/game/                     主站游戏页面
src/games/atamas/                 纯客户端游戏
shared/realtime/protocol.ts       认证与控制帧契约
services/realtime/src/
  main.ts                        进程启动、信号处理
  config.ts                      环境配置与校验
  server.ts                      HTTP / WebSocket 连接生命周期
  game.ts                        游戏、身份与会话接口
  games.ts                       显式游戏注册表
```

共用仓库根目录的依赖与 lockfile，使用独立的 TypeScript 构建配置。
`services/realtime/dist/` 是生成目录，不提交 Git。
实时服务可以依赖 `shared/realtime/`，不能导入 `src/lib/` 的主站服务、
Prisma、Next.js 或主站会话密钥；同一源码文件在两个进程内也有两份独立状态。

## 2. 开发与运行

在仓库根目录执行：

```bash
npm ci
npm run realtime:dev
# 默认监听 127.0.0.1:3033
curl http://127.0.0.1:3033/healthz

npm run realtime:build
npm run realtime:start
```

健康检查返回：

```json
{"ok":true,"service":"realtime","version":1,"games":[]}
```

| 环境变量 | 默认 / 规则 |
|---|---|
| `REALTIME_HOST` | `127.0.0.1` |
| `REALTIME_PORT` | `3033`，整数 1–65535 |
| `REALTIME_ALLOWED_ORIGINS` | 逗号分隔的完整 origin，无路径或尾斜杠；生产必填 |

开发时允许 `http://localhost:3000` 和 `http://127.0.0.1:3000`。
独立进程只读取环境变量，不自动加载主站 `.env`。
可参考 `services/realtime/.env.example`，用服务管理器的 EnvironmentFile 注入。

## 3. 连接与游戏契约

浏览器连接 `wss://raricy.com/realtime/<gameId>`。路由只认已注册游戏，
不接受查询串中的票据；Origin 必须与白名单精确相等，Cookie 不参与认证。

第一条消息必须是文本 JSON：

```json
{"type":"realtime.authenticate","version":1,"ticket":"短期一次性票据"}
```

服务调用该游戏的 `authenticate({ gameId, ticket, signal })`。
认证器必须校验游戏归属、有效期和身份，并原子消费票据；验证超时或连接断开时 signal 取消。
禁止以客户端自报的 userId 建立身份。当前没有默认认证器，也没有可调用的主站票据端点。

认证成功后，服务先发送 `realtime.ready`（含协议版本、游戏 ID 和连接 ID），
再调用游戏的 `connect(peer)`。客户端必须等待 ready 后再发游戏帧。
`peer.identity` 只含可信的用户 ID；游戏通过 `peer.send()` 返回文本或二进制消息，
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

票据过期只约束建连，不会自动断开已建立的游戏会话。
Wand 接入前还需实现：主站签发与消费、角色和专注模式检查、
撤权或强制下线时的连接处理、重连与房间恢复规则。

## 4. 部署

ATÅMAS 随主站原有流程部署即可。实时服务目前没有游戏，按需启用；
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

构建用 `npm run realtime:build`。发布时分别管理主站和实时服务的重启，
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
