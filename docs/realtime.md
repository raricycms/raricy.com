# 实时游戏服务

`services/realtime/` 是同仓库、与主站共同启停的 Node.js WebSocket 进程。
主站继续负责页面、账号和数据库；实时服务负责连接与游戏内状态。
`shared/` 放无 Node.js、Next.js、Prisma 依赖的传输契约、Wand 地图与移动计算。

**当前交付范围**：服务与主站统一配置、启动和停止；提供健康检查、精确 Origin 检查、
认证首帧、游戏接入接口、文本与二进制帧、心跳、大小与频率限制。
「测试」合集已接入 Wand demo、Wand demo 2、公共空间与圈地运动，支持主站登录、一次性票据与多人状态同步。
ATÅMAS 在浏览器内运行，不需要这个服务。

## 1. 目录与依赖方向

```text
src/app/game/                     主站游戏页面
src/games/atamas/                 纯客户端游戏
src/games/wand/                   Wand 画布与输入客户端
src/games/wand2/                  精灵战斗、地图、排行榜与触屏输入
src/games/public-space/           公共空间网格与观众席
src/games/quandi/                 圈地运动外壳与受认证保护的游戏文档
public/static/quandi/             已获原作者授权的圈地运动脚本、样式、素材与署名
src/lib/realtime-ticket-service.ts 主站瞬时票据与权限复核
shared/realtime/protocol.ts       认证与控制帧契约
shared/wand/                     地图、输入与快照契约、移动计算
shared/wand2/                    精灵战斗协议、权威世界与史莱姆 AI
shared/public-space/             网格、心跳与成员快照契约
shared/quandi/                   操作校验、资源上限与增量领地计分
services/realtime/src/
  main.ts                        进程启动、信号处理
  config.ts                      环境配置与校验
  server.ts                      HTTP / WebSocket 连接生命周期
  game.ts                        游戏、身份与会话接口
  games.ts                       显式游戏注册表
  site-auth.ts                   主站票据消费与身份复核客户端
  wand.ts                        Wand 权威移动与广播
  wand2.ts                       Wand 2 权威世界驱动、输入与广播
  public-space.ts                 公共空间占位、观众席与断线清理
  quandi.ts                      圈地运动账号连接、双人房间与生命周期
  quandi-engine/                 圈地运动权威引擎及六种模式
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
{"ok":true,"service":"realtime","version":1,"games":["wand","wand2","public-space","quandi"]}
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
禁止以客户端自报的 userId 建立身份。两个联机 demo 使用如下主站接口（下文以 Wand 为例，
公共空间对应的 gameId 是 `public-space`，签发入口是 `POST /api/game/public-space/launch`）：

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
第一版没有房间选择、战斗、成绩、持久化存档或跨实例同步。战斗版见下文 Wand demo 2，
新增游戏在注册表显式登记，并实现认证、定期复核、连接与清理接口。

#### Wand demo 2

`/game/wand2` 为独立入口，票据和 WebSocket 游戏 ID 均为 `wand2`；第一版保持原玩法。
`shared/wand2/` 定义 960 × 640 草地图、碰撞、战斗与史莱姆 AI，
`services/realtime/src/wand2.ts` 驱动权威世界，`src/games/wand2/` 绘制与收集输入。
最多 32 个连接，每 50ms 广播 `wand2.snapshot`。输入仍为 4 字节：opcode `2`、
方向及攻击位（1/2/4/8/16）、uint16 大端序号；拒绝过期、重复和无效输入。
250ms 未收到输入即停止移动及后续攻击。离线后需重新申请票据，撤权规则与第一版一致。

方向键 / WASD 移动，空格 / J / 点击地图挥剑；手机有支持同时按住的方向与攻击按钮，
镜头跟随并显示全局小地图。人物有四方向待机、步行、挥剑和受击动画。
透明精灵表由内置 image_gen 根据用户提供的人物参考生成，素材及提示保存在
`public/static/games/wand2/`，游戏配色固定，外壳随站点主题。

画面在客户端按**到达时刻**做两帧缓冲插值：渲染时刻固定落后当前一个播放缓冲，包早到或迟到
只改变缓冲的消费速度，不会让人物前跳或定住；缓冲被吃穿时按最后两帧的速度短暂外推。自己那格
再用本地按键和同一份碰撞把位置前推到「现在」，镜头跟随的是同一份平滑结果 —— 规则见
`src/games/wand2/motion.ts` 头部。

有人在线时按间隔随机刷新史莱姆，数量随连接数增长、最多 28 只；空场立即清理怪物并停止计时。
史莱姆游荡、追逐、绕石寻路，接近玩家后蓄力扑击。剑击校验距离、朝向、冷却与遮挡，
每剑对每只怪物最多命中一次；击杀时青绿 / 淡紫 / 金色分别奖励 1 / 3 / 5 猫薄荷。
接触触发玩家受击、击退和 850ms 无敌，没有血量或猫薄荷损失；无玩家间伤害。

排行只列在线账号，同账号多个标签各有角色位置，但共享猫薄荷并合并排名。
分数保存在实时进程内，最多保留 2048 个账号，达到上限时逐出最早保留的离线账号；
服务重启后清零，不接入鱼干账户、库表或持久化存档。

### 3.3 公共空间 demo

`/game/public-space` 登录后自动连接，进入共享的 5 × 5 网格外的观众席。
点击空格发送 `{"type":"public-space.move","cell":0}`，位置按行从 0 编号到 24；
发送 `cell:null` 回到观众席。点击自己的格子或「回到观众席」均可退出网格，
「离开空间」与页面卸载会断开连接。

服务端同步检查占用并换位，同一格只能有一个用户；冲突返回 `public-space.occupied`，
失败者保留原位。成员快照 `public-space.snapshot` 同时携带网格成员与观众，包含主站可信的
用户 ID、用户名、`frameUrlFor()` 解析的头像框与格子位置。头像框在建连时解析，重新连接刷新。
同一账号的多个标签页共用一个头像与位置，最后一个连接关闭后才移除。

网格坐满仍可旁观；最多 128 个不同账号，另受传输层 256 连接的总上限约束。
客户端每 5 秒发送 `public-space.ping`，服务返回 `public-space.pong`；
服务端每 5 秒清理超过 15 秒无应用心跳的连接，因此无关闭通知的断网通常在 15–20 秒内释放位置。
客户端同样检测服务静默并显示重新连接入口。普通断开立即移除，重连从观众席开始。
成员与位置只保存在实时进程内存，服务重启后清空，无需数据库迁移。

### 3.4 圈地运动

`/game/quandi` 位于测试合集，要求登录，不要求 core 档位；本地双人和联机共用该页面。
原作与固定源码版本、授权及修改说明在 `public/static/quandi/NOTICE.txt`。
保留探索、对战、无限、生存、夺旗、昼夜六种模式，当前只支持电脑键盘操作。

主站的 `POST /api/game/quandi/launch` 签发绑定 `quandi` 的一次性票据，
连接路径为 `/realtime/quandi`；身份消费、每 10 秒复核、封禁、专注模式、会话版本、
Origin 和传输限制与其他联机游戏共用。昵称只取主站认证结果，不接受客户端自报。
每个账号最多一个圈地联机连接，游戏最多 64 个连接、16 个双人房间。

游戏文档从 `/game/quandi/play` 分发，该 Route Handler 独立检查登录、封禁和专注模式，
禁止缓存；HTML 不放在可匿名读取的 public 目录。
iframe 仅设置 `sandbox="allow-scripts"`；文档响应自身也设置 CSP sandbox，直接访问仍隔离。
不开放 same-origin、表单、弹窗或顶层导航，游戏不能读取本站 Cookie、父页 DOM 或存储。
文档 CSP 禁止自行联网，仅加载本站固定脚本、样式和图片；本站父页持有票据与 WebSocket，
通过只交给该 iframe 的 MessagePort 转发操作，父页与服务端都校验操作结构。
此 CSP 仅作用于游戏文档，不设置 `frame-ancestors`，不改变主站被第三方嵌入的约定。

联机房间固定两人，密码学随机生成六位房间码；创建、加入、准备、开始、离开、弃权只作用于
当前连接所属房间，双方准备且房主操作才能开局。控制操作每连接最多 12 次 / 10 秒，
连续猜码同样计入；跨房间、重复建房、自报昵称或坐标等输入无法绕过这些检查。
移动上行 30Hz，传递方向与递增序号；服务端计算位置、碰撞、生命、领地与胜负。
重复或旧序号无效，300ms 没有新输入就停止移动；客户端失焦清空按键，并正确销毁监听器。

父页每 5 秒发送应用心跳，服务端 20 秒无操作回收连接，客户端 15 秒无服务消息提示断线。
断线或离开立即判为弃权，释放账号占用及房间成员；房主离开后转移房主，空房间立即清理。
不恢复断线前对局，用户需主动重连并重新加入。结束后双方重新准备可再开一局。
等待房间 5 分钟无房间操作即释放；每局最多 10 分钟（含无限模式），到时按现有胜负规则结算。
每人轨迹最长 1000 个采样点、领地最多 128 个多边形，每局领地最多 8192 个顶点，
单个广播包最多 192KiB；达到复杂度上限或引擎抛错只关闭该房间，不影响其他对局。
计分沿用原版 4px 网格与非零环绕规则，以增量占用网格计算，避免每帧重复扫描全部领地。

状态只在实时进程内存中，不保存成绩、不涉及鱼干、不需要迁移或额外服务配置。

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
