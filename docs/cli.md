# 运维 CLI

> 站内给站长 / 管理员用的维护工具。**两种用法**：
>
> - **交互式**（推荐）：`npm run cli` —— 进菜单，每一步都有提示，**不需要背命令**
> - **命令式**：`npm run cli -- <命令> [参数]` —— 给脚本 / CI / 明确知道自己要做什么时

```bash
npm run cli                    # 交互式：菜单向导
npm run cli -- --help          # 全部命令一览
npm run cli -- stats overview  # 命令式：看一眼站点状态
```

> **未迁移**：旧版 CLI 的 `import-blogs`（历史博客导入；正文早已存
> `BlogContent` 表）。需要时另写专用脚本（参考 `scripts/compensate-unclaimed-fortunes.mjs`）。
>
> ~~`flask fish compensate`~~ 已迁移为 `fish compensate`（见「小鱼干」一节）——
> 语义有一处**与历史实现有意不同**，那里写明了原因。

---

## 一、交互式模式

不带参数、且在真正的终端里跑，就会进菜单。菜单用的是 inquirer 的**纵向列表**
（方向键选、回车确认），**不是输编号**：

```
? 聪明山 运维台 (Use arrow keys)
❯ 用户  7 条命令
  角色  7 条命令
  博客  4 条命令
  评论  4 条命令
  云剪贴板  4 条命令
  投票  4 条命令
  图床  3 条命令
  邀请码  3 条命令
  小鱼干  8 条命令
  审计日志  1 条命令
  申诉  2 条命令
  站点概览  1 条命令
  OAuth 应用  4 条命令
  审计身份：owner cms  切换
  查看全部命令与用法  --help
  退出
```

选中分组后列的是**命令原名**（不是「搜博客」这类改写过的说法），每项后面跟着该命令的摘要：

```
? 评论 (Use arrow keys)
❯ ← 返回上一步
  ✕ 取消本次操作
  comment search  搜评论（含已删）
  comment show    评论详情
  comment restore 恢复被删除的评论
  comment delete  删除评论
```

接着按该命令的参数逐个提问。自由文本提示都带导航后缀；select 类参数同样是方向键列表：

```
关键词（评论正文 / 作者用户名 / 所属文章标题；留空 = 最近一页）（:b 返回上一步，:q 回主菜单）› _
状态 1. 全部（含已删除）  2. 仅未删除  3. 仅已删除
```

写操作在动手前会弹确认框，逐项列出**具体将发生什么**（目标、字段级变更、后果），
而不是笼统的「确定吗」：

```
──────────────────────── 即将执行 ────────────────────────
命令：comment restore
执行者：owner cms（审计 admin_id = e43de295-…）

  评论 id  …
  原因     …

──────────────────────────────────────────────────────
评论作者：alice
所属文章：《构建报错排查》
正文预览：这个问题报错在第三行…
变更：BlogComment.isDeleted → false；重算文章评论计数与最后评论时间。
本次操作会写入审计日志（内部留痕，不进 /audit 公示页）。
──────────────────────────────────────────────────────
确认执行？ (y/N) › _
```

几个要点：

- **不用背命令，也不用背 ID。** 凡是「选某个实体」的参数（文章 / 评论 / 剪贴板 /
  投票 / 图片 / 用户 / 申诉），向导都让你**输关键词 → 从结果里挑**。
- **导航约定**：选命令的二级菜单、以及 select 类参数，前两项固定是
  「← 返回上一步 / ✕ 取消本次操作」；自由文本提示后写着 `（:b 返回上一步，:q 回主菜单）`。
  **顶层分组菜单没有返回项**（它已经是最外层），也没有字母快捷键 —— 全靠方向键。
- **退回上一题会带出原答案当默认值**，不用重敲；**与当前选择无关的题根本不问** ——
  例如密码来源选了「生成随机密码」，就不会再问新密码（改回去的话先前填的那个也会作废）。
- **`Ctrl-C` 只取消当前操作、回主菜单**，不退出整个工具；也不会留下半完成的写入。
- **非交互（管道 / CI）下不会进菜单**，而是打印帮助后退出 —— 绝不会挂在 stdin 上等输入。

---

## 二、全局参数

| 参数 | 作用 |
|------|------|
| `--json` | 结构化输出。stdout **只出一个 JSON 对象**，人读内容与提示改走 stderr，所以 `\| jq` 永远是干净的。**隐含非交互** |
| `--yes` / `-y` | 跳过危险操作的二次确认（非交互场景**必须**显式加上） |
| `--as <username>` | 指定审计身份（默认取库内最早的站长） |
| `--no-color` | 关闭颜色（也遵循 `NO_COLOR` 环境变量；非 TTY 自动关闭） |
| `--help` / `-h` | 顶层帮助；放在命令后则是该命令的详细帮助 |

## 三、退出码

沿用历史 CLI 的 `click` 风格（退出码约定）：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功（**包括用户主动取消** —— 取消不是错误） |
| `1` | 参数或用户错误（用户名不存在、amount 不合法、业务规则拒绝——余额不足也走这一档） |
| `2` | **本地事务失败**（真故障：不是你的输入问题。本地没有任何变更，可稍后重试） |

```bash
npm run cli -- fish grant alice 100
case $? in
  1) echo "被拒绝（参数非法 / 余额不足）—— 重试没用，先修正输入" ;;
  2) echo "本地事务失败 — 未做任何变更，稍后重试；上面那行「原因」是要查的东西" ;;
esac
```

> `2` 这个号当年是留给「站外账户微服务同步失败」的。账户搬进站内后那个场景不存在了，
> 号码**保留**、含义改成「本地事务失败」—— `0/1/2` 是脚本契约，别因为「没有 503 了」
> 就把它删掉（服务层那三档的对应关系见 `docs/architecture.md` §6.3）。

---

## 四、确认与审计

### 危险操作需要确认

| 危险级别 | 命令 | 行为 |
|----------|------|------|
| 破坏性 | 角色变更 · 用户禁言 · 强制下线 · 重置密码 · **站长建号** · 文章/评论/剪贴板/投票的删除与恢复 · **图床恢复** · 申诉裁决 | 终端里弹「即将执行」确认屏；非交互必须加 `--yes` |
| 不可逆 | `invite revoke`（物理删除邀请码行） · **`fish compensate`（群发 core+）** | 同上，且确认屏会额外标注「不可恢复」 |
| 安全 | 各类检索 / 查看 / `stats overview` / `fish grant`、`fish deduct` / OAuth 应用管理 | 不确认 |

确认屏会列出**具体将发生什么**（目标、字段级变更、后果、是否通知对方），而不是笼统的「确定吗」。

> **鱼干为什么基本不在危险集里**：写路径就是**一次本地事务**（余额与流水同事务提交），
> 要么整体生效、要么整体回滚，没有「钱动了一半」的中间态；每一笔都留在 `fish_transactions`
> 流水里可查可核。失败的两种结局都是干净的（业务拒绝 = 没写，真故障 = 整体滚回）——
> 再加一道确认只会让 `docs/` 里的示例不能直接粘贴执行。
>
> **`fish compensate` 是唯一的例外**，而且它要确认的理由不是「怕写坏账」（写路径本身就是
> 要么全成、要么整体回滚），是**规模**：一条命令改的是全部 core+ 用户的余额，敲错一个
> 数量级就得再发一轮反向补偿才能拉平（`fish deduct` 一次只能扣一个人）。所以它标
> `irreversible`。

### 审计身份

**多数**写操作会记一条审计日志。审计主体：

1. `--as <username>` 指定的用户；否则
2. 库内**最早的站长**（`createdAt` 升序）；都没有则
3. 直接报错，**绝不**伪造一个主体。

**为什么不能伪造**：`admin_action_logs.admin_id` 与 `user_bans.admin_id` 都是指向
`users.id` 的**真实外键**，而且审计日志的全部意义就在于「这是谁做的」。

### 后台写下的日志是「内部日志」

CLI 写下的每一条审计日志都落 `visibility='internal'`：**不进** `/audit`（顶栏「日志」
那张公示页），但**照常进库** —— 用 `audit log --visibility internal`（或 `all`）查得到。

**为什么不干脆不记**：那样等于把审计链自己剪断 —— 哪天要查「这个人的角色是谁改的、
谁在什么时候禁的言」，就只能靠猜。为了公示页干净而丢掉这个，不值。

> **用之前要知道的一个副作用**：用户申诉的对象就是公示页上的那条日志（申诉入口挂在
> 日志详情页上），公示页看不到 = **对方无法申诉**。所以：
>
> - 处罚**真实用户**（禁言 / 删文章 / 删评论）而还想留申诉渠道的，用**网页后台**的对应
>   入口 —— 那里写的是公开日志，确认屏上也会把这点写出来。
> - CLI 更适合「我自己知道后果」的操作：建号、重置密码、修数据、批量补偿。

> ⚠️ **例外 —— 这些写操作根本不写审计日志，`audit log` 里也找不到**：
> `fish grant` / `fish deduct` / `fish compensate` / `oauth create-app` /
> `oauth disable-app` / `oauth enable-app` / `invite generate`。
>
> 鱼干那三条是**现状，不是结构约束**：当年不写是因为写路径是三段结构（本地事务 +
> 远端 HTTP + 补偿事务），`logAdminAction` 挤进去会占满 SQLite 写锁；现在只剩一次本地
> 事务，那条理由**已经不成立**。要不要补上是一次独立的决定 —— 在那之前，它们留下的凭据
> 是 `fish_transactions` 流水（`fish compensate` 另有按批次派生的幂等登记行，一条 / 人）。

### 两个由此而来的限制

- **不能修改自己的角色**（`setRole` 的既有规则）。站点只有一个站长时，他不能用 CLI
  把自己降级 —— 要么 `--as` 指定另一个站长，要么先加一个。
- **不能重置自己的密码**（自助改密走网页端，要验原密码）。CLI 能免原密码重置自己
  等于把「会话劫持」做成了一条命令。

---

## 五、命令清单

<!-- cli-commands -->

### 角色管理

角色体系：`user` → `core` → `admin` → `owner`。权限分档：涉及 `admin` / `owner` 的
任何方向都只有站长能做；`user ↔ core` 归管理员。

| 命令 | 作用 |
|------|------|
| `promote-admin <username>` | 提升为管理员 |
| `demote-admin <username>` | 撤销管理员（降为 core） |
| `promote-core <username>` | 提升为核心用户 |
| `demote-core <username>` | 撤销核心用户（降为 user） |
| `promote-owner <username>` | 提升为站长 |
| `demote-owner <username>` | 撤销站长（保留管理员） |
| `role set <username> <role>` | 统一入口，交互式向导用的就是它 |

已经是目标角色时打印「提示：xxx 已是…」并**退出码 0**（不是错误）—— 脚本据此判定有没有真的改。

### 用户

| 命令 | 作用 |
|------|------|
| `user search [关键词]` | 按用户名 / 邮箱搜 |
| `user show <username>` | 详情：角色 / 禁言 / 鱼干余额 / 文章数 / 评论数 |
| `user reset-password <username> [generate\|manual] [--password <新密码>] --reason <原因>` | 重置密码（旧会话全部失效）。`manual` 模式**必须**给 `--password`（≥8 位）；`generate` 模式不给，**给了会报错**（不是静默忽略） |
| `user ban <username> --hours N --reason <原因>` | 禁言 |
| `user unban <username> [--reason <原因>]` | 解除禁言 |
| `user force-logout <username> [--reason <原因>]` | 强制下线（比禁言轻一档） |
| `user create <username> --password <初始密码> [--email <邮箱>] [--reason <原因>]` | 新建账号：站长专属，不经过人机验证与邀请码，角色直接是 core（见下） |

```bash
# 重置密码：默认生成 16 位随机密码，只显示一次
npm run cli -- user reset-password alice --reason "用户申诉邮箱被盗" --yes
#   新密码：xK9mP2qL7vN4wR8t
```

新密码**永远不会进审计日志** —— `/audit` 是公开页。

#### user create（站长建号）

生产机到 Cloudflare 的出口被墙，Turnstile 的服务端校验不可用。站长**继续开着**验证码
（等于关闭匿名注册以防批量注册），改用这条命令手动给认可的人开号。管理后台的
**用户管理 → 新建用户**是同一个功能的网页入口，规则完全一致。

```bash
# 不填邮箱 → 自动合成 <用户名>@users.invalid（RFC 2606 保留 TLD，永不投递）
npm run cli -- user create alice --password 'Hunter2Hunter2' --reason "朋友，验证码过不去" --yes

# 有真实邮箱就填上，别用占位邮箱
npm run cli -- user create bob --password 'Hunter2Hunter2' --email bob@example.com --yes
```

- **不消耗邀请码** —— 角色直接给 `core`，不走「邀请码升级」那条路。
- 密码与邮箱都**不会**进审计日志：`/audit` 是公开页，那里只记 `create_user` 这个动作。
- 邮箱留空的账号**收不到任何邮件**（当前站内也没有邮件功能，但别指望它能用来找回）。
- 建号遇到**意外故障**时这条命令**退出码 2**（和 `fish grant` 一样：那是「本地事务失败」
  那一档，不是你的输入问题），且本地不会留下半截用户 —— 建号走的是与网页注册同一个
  内核：用户行在一个事务里写入，任何异常都整体回滚。

### 内容检索与恢复

**这一组是这套工具存在的主要理由**：站内此前既没有评论 / 剪贴板搜索，也没有任何
「找回被误删内容」的入口（除了申诉通过时的副作用）。

| 命令 | 作用 |
|------|------|
| `blog search [关键词] [--status all\|active\|deleted]` | 搜文章，**含正文** |
| `blog show <id>` / `blog restore <id>` / `blog delete <id> --reason <原因>` | 查看 / 恢复 / 删除 |
| `comment search [关键词] [--blog <文章id>] [--status …]` | 搜评论 |
| `comment show <id>` / `comment restore <id> [--reason <原因>]` / `comment delete <id> [--reason <原因>]` | 查看 / 恢复 / 删除。处理**他人**评论时 `--reason` 必填；动自己的评论可不填 |
| `clip search [关键词] [--status …] [--publicity …]` | 搜云剪贴板（含私有） |
| `clip show <id> [--full]` / `clip restore <id>` / `clip delete <id> [--reason <原因>]` | 查看 / 恢复 / 删除。`--reason` 可选 |
| `vote search` / `vote show` / `vote restore [--reason <原因>]` / `vote delete --reason <原因>` | 投票同上。⚠️ **删除必填原因，恢复可不填** —— 两者不对称 |
| `image search` / `image show` / `image restore` | 图床（**没有物理删除**）。⚠️ `image restore` 是破坏性操作，终端会弹确认屏，非交互必须 `--yes` |

几处不显然的行为：

- **检索默认含已删除**（`--status` 默认 `all`）。想只看活着的加 `--status active`。
- **搜文章默认搜正文**（标题 / 描述 / 正文 / 作者 / 精确 id）。网页后台仍是只搜标题 ——
  那条服务是 opt-in 的，网页行为没有变。
- **列表不显示正文**：剪贴板正文上限 5 万字，一页 20 行就是近一兆。正文用 `clip show` 单条看。
- **`image show` 会报告磁盘文件是否还在**。软删只翻标志位、不删文件，但文件可能被手工
  清理过 —— 恢复一条文件已不在的记录，页面上会是坏图，这件事必须在动手**之前**看到。
- **恢复评论时会提醒 `status ≠ approved` 的情况**：`isDeleted` 与 `status` 是两个正交的
  闸门，只翻前者的话评论恢复了也不会出现在评论区。
- **每条 search 都支持 `--keyword` / `-q` 和 `--page`**（关键词也可以写成位置参数，
  如 `blog search 报错栈`；翻页默认第 1 页）。上表为省版面只写了位置形式。
  这两个参数在**向导里也会问**，不用记。

```bash
# 典型流程：找回一篇被误删的文章
npm run cli -- blog search 报错栈 --status deleted
npm run cli -- blog restore 2b7ec270-be9c-4283-b1a2 --reason "作者申诉，误删" --yes
```

### 邀请码

| 命令 | 作用 |
|------|------|
| `invite generate [-n N]` | 生成（12 位 base62，填了即升 core） |
| `invite list [--filter all\|unused\|used]` | 列出 |
| `invite revoke <码\|ID>` | 撤销**未使用**的码 |

`invite revoke` 是本工具里**唯一破「永不物理删除」的地方** —— `InviteCode` 没有软删列，
撤销只能是 `DELETE`。因此收窄到最小：

- **未使用的码**才删（后果只是持码人注册不了，这正是「撤销」的语义）
- **已使用的码会被拒绝**：`used_by` 是「谁邀请了谁」的唯一记录，删了就永久丢失
- 审计日志里**只记数字 ID，绝不记码值** —— `/audit` 是公开页，码就是注册凭证

真要撤销已使用的码，那需要给 `InviteCode` 加 `is_revoked` 列 + 手写迁移，是另一件事。

### 小鱼干

| 命令 | 作用 |
|------|------|
| `fish grant <username> <amount> [-d 说明]` | 赠送（一次本地事务） |
| `fish deduct <username> <amount> [-d 说明]` | 扣减（一次本地事务） |
| `fish balance <username>` | 查余额 |
| `fish compensate <amount> [--batch-id ID] [--dry-run]` | **给全部 core+ 群发补偿**（逐人原子） |
| `fish credential-list <username>` | 列出某用户的鱼干只读凭据（不含明文与哈希） |
| `fish credential-revoke <id>` | 吊销一张只读凭据（立即失效，幂等） |
| `fish webhooks [username]` | 列出回调地址与投递积压（留空列全部） |
| `fish webhook-retry` | 立刻重投待发回调（不等退避） |

**关于只读凭据**：站外机器人 / 银行用它查余额与流水（`Authorization: Bearer`），
**查不了钱也动不了钱**，可单独吊销，改密码不会作废它。凭据由**用户自己在站内签发**
（`/fish/api`，签发要再输一次密码），CLI 这两条是运维侧的口子 —— 只在用户不配合、
或凭据泄露但联系不上本人时用。凭据不物理删除，只标记 `revokedAt`。

**关于回调**：钱到账时主动通知商户（`/fish/api` 上自助配置）。投递是
**at-least-once** —— 商户可能收到重复回调，靠 header 里的 `X-Raricy-Delivery` 去重。
失败会自动重试（指数退避，约 10s/1m/5m/30m/2h/6h），耗尽后置 `dead`。
`fish webhooks` 里那一列死信就是「商户没收到通知」的那几笔，要提醒它拉流水对账。

⚠️ **失败到判死不会自动停用地址** —— 悄悄停掉全部回调是典型的静默失效：
商户以为还在收通知，其实早就没了。要停由商户自己在页面上停。

`amount` 是正整数，单位是**整个小鱼干**。写路径就是**一次本地事务**（余额与流水同事务
提交）：要么整体生效、要么整体回滚，没有中间态，也绝不静默成功。两种失败各自对应一个
退出码：**业务拒绝**（余额不足、amount 非法）→ `1`；**本地事务失败**（真故障）→ `2`，
此时本地没有任何变更，稍后重试即可。（`ACCOUNT_SERVICE_INTERNAL_TOKEN` 等四个
`ACCOUNT_SERVICE_*` 变量已废除，CLI 不会再读它们 —— 见 `docs/deploy.md` §12。）

**崩在写入中间怎么办**：不需要怎么办 —— 崩在事务提交前等于整体回滚，崩在提交后等于整体
生效（SQLite 自己保证），不存在「余额动了、流水没写」这种要人工收敛的状态，也没有对应的
重放命令。**唯一要人工查证的是迁移前遗留的账目**：`fish compensate` 命中的 `blocked` 那
几位，见下。

#### 群发补偿 `fish compensate`

给**全部 core+ 用户**（core / admin / owner）发放同样数量。

**非核心账号一分不发。** 鱼干在站内的赚取渠道（签到翻牌、投喂分成）全在 core 门槛之后，
给 `user` 角色空投等于「注册就有鱼干」，与这套口径直接冲突；何况这条命令一次改的是全站
余额，多发的人越多、回滚成本越高。**被禁言者照发** —— 补偿是系统行为，与个人当前状态无关，
禁言只停发言权、不没收财产。取的是**当前**角色，所以曾降权的账号会被跳过。

```bash
npm run cli -- fish compensate 10 --dry-run          # 先看计划，不动账
npm run cli -- fish compensate 10 -d "故障补偿"      # 交互式会弹确认屏
npm run cli -- fish compensate 10 -d "故障补偿" --yes # 脚本 / 非交互
```

**失败语义是「逐人原子」，不是「全有或全无」。** 每人独立走一次本地事务（余额 + 流水 +
幂等登记一起提交），所以中途失败**不回滚**已经发出去的部分：前 300 人拿到了，后面的
没有。没发成的那几位，他们那笔事务整体回滚，对他们等价于没发生 —— 用同一个批次 ID
续跑接着发。

逐人而不是「一个大事务发给所有人」是**刻意的**：一锤子的大事务要么全成要么全败，拿不到
「发到哪了」，也就没有续跑可言；而且它会把 SQLite 写锁一次性占满整批（上千人的写入，
期间全站写路径排队等锁）。详见 `src/lib/fish-compensate.ts` 头部。

> 历史注记：迁移前的实现是「一个大事务发给所有人」，逐人是**刻意**换掉的形状。当年它还有
> 第二条理由 ——「远端 HTTP 不能放进 SQLite 事务」；账户搬进站内后那条约束消失了（现在
> 只有一次本地事务，也没有第二个存储要对账），形状仍然保留，理由如上。

**续跑**——用同一个批次 ID 重跑，已发放的会自动跳过：

```bash
# 批次 ID 在开跑前就打印出来（进程被杀也找得回），失败时退出码 2 的消息里也带完整续跑命令
npm run cli -- fish compensate 10 --batch-id 3f9a2c81d0b4 --yes
```

去重靠的是由批次派生的**确定性幂等键**（`comp-{sha256('compensate-{batchId}-{userId}-{amount}')[:16]}`，
派生算法与迁移前的实现**逐字节相同** —— 当年用某个批次 ID 只跑了一半的批次，现在传同一个
ID 就能接着跑）。这不是锦上添花，是必须的：若只是「重跑一遍」，同一批人会**实打实再拿
一次**（这笔钱是真的发出去了，不是账面误差）。

**迁移前遗留的非 synced 行会被跳过并警告，不会重新发放。** 新写入的登记行一律是
`synced`（登记与发放同事务提交），所以命中的只可能是当年「本地已提交、远端那半笔状态
不明」的欠账。这些用户**必须人工查证** —— 重发会在本地实打实叠加一笔；收敛它们的那条
重放命令已随账户服务一起撤销，代码里没有、也不该有自动重放。传 `--batch-id` 续跑时，
确认屏会把这批人的数量列出来。

### 审计日志与申诉

| 命令 | 作用 |
|------|------|
| `audit log [--user <用户名>] [--action <动作>] [--since 7d] [--visibility …]` | 检索审计日志 |
| `appeal list [--status pending\|accepted\|rejected\|all]` | 列出申诉 |
| `appeal decide <id> accept\|reject [--note <说明>]` | 裁决（通过时会自动撤回原处罚） |

与公开的 `/audit` 页不同，`audit log` **看得到 `visibility` 非 `public` 的内部日志**，
也**没有 30 天窗口** —— 排查陈年问题要能翻到任意久之前。

`appeal decide` 通过时会尽力撤回原操作：

| 原操作 | 撤回动作 |
|--------|----------|
| `ban_user` | 自动解除禁言 |
| `delete_blog` | 恢复文章（`ignore=false`） |
| `delete_comment` | 恢复评论并回补文章评论计数 |
| 其它 | **不撤回任何数据**（确认屏会写明） |

**不能裁决「针对自己」的申诉** —— 申诉是对管理权力的制衡，自裁会让这道闸失效。

### 站点概览

| 命令 | 作用 |
|------|------|
| `stats overview` | 人数 / 内容量 / **已删内容** / 待审申诉 |

交互式向导打开后，这一屏是了解「现在站点什么状态」最快的入口。

### OAuth 2.0 应用

注册和管理第三方应用（client_id / client_secret / 回调 URI）。协议细节见 `docs/oauth.md`。

```
oauth create-app <name> [--owner <username>] [--homepage URL] [-d 说明] --redirect-uri URI [...]
oauth list-apps
oauth disable-app <id|client_id>
oauth enable-app  <id|client_id>
```

```bash
npm run cli -- oauth create-app "cattca-game" \
  --homepage "https://cattca.example.com" \
  -d "CattCa 站点的用户绑定" \
  --redirect-uri "https://cattca.example.com/oauth/callback"
#   client_id:     AbCdEf123...
#   client_secret: XyZ_987...     ← 仅此一次，请立即复制
```

⚠️ `client_secret` **仅此一次显示**。命令行若被记录（shell history / CI 日志），
请同步清理；推荐写到 secrets manager 而不是明文文件。

### 头像框

发放 / 收回 / 盘点用户的头像框。框是**授权**，不是商品：用户侧只能在
`/settings` 决定「戴哪个」，而「有没有资格戴」由这里决定。

```
frame grant  <username> <key> [--days N] [-r 说明]
frame revoke <username> <key> [-r 说明]
frame list   [username] [--keys]
```

```bash
npm run cli -- frame grant alice sakura --days 30 -r "中秋活动"
#   已发放：alice ← 「樱花」
#   到期：2026-10-20T12:00:00.000Z

npm run cli -- frame list alice
#   alice   樱花(sakura)   有效   到期:2026-10-20 12:00:00   来源:cli   佩戴中

npm run cli -- frame list --keys     # ★ 素材体检
#   sakura   樱花   素材:有   透明通道:有   18244 字节
```

**语义要点**

- **授予 ≠ 装备**。发下去只是给了资格，戴不戴是用户自己的事（`/settings`）。
- **幂等且只延长不缩短**：已持有时取「原到期」与「新到期」的较晚者。已经是永久的，
  再发 30 天仍是永久（空操作）。要缩短或收回，用 `frame revoke`。
- **收回会顺带摘下**：正戴着这个框时，收回会连同装备状态一起清掉（同一事务）。
  没持有过、或已经收回过的，照样成功（幂等）。
- **到期是懒判定**：限时框过期后，库里那两列**留着过期的值、不做任何清理**，
  判定时恒为「不显示」。所以想让某人下周失效，用 `frame grant --days 7`，别用 revoke。
- **退役一个框**：把 `src/lib/frame-refs.ts` 里那条的 `retired` 置 true，
  **不要从 `FRAME_KEYS` 里删** —— 删了用户就摘不掉它了（面板认不出那一行）。

**⚠️ 素材缺失只警告，不算失败**

授权是写库的，素材在 `instance/frames/<key>.png`（gitignored 的运行时数据）。
授权成功但盘上没有那张图时，本域命令**只打黄色警告、退出码仍是 0** ——
那时全站都不会显示这个框，而**页面不会有任何报错**。`frame list --keys` 是
唯一能主动发现这件事的地方。

`frame list --keys` 还会报「没有透明通道」——那种素材会**盖住用户的脸**，
是全站一起坏的一种。

---

## 六、注意事项

- **跑 CLI 的机器是权限边界**。CLI 不校验「执行者本身是不是站长」（权限分档在服务层，
  见 `src/lib/admin-user-service.ts` 的 `setRole`）。生产环境务必把跑该命令的服务器
  shell 列入堡垒机白名单。
- **Windows 终端的中文显示**：若控制台代码页不是 UTF-8（`chcp 65001` 可切），
  中文会显示成乱码。这是终端环境问题，工具本身无法代劳。
- **交互式模式需要真正的 TTY**。在 IDE 的内嵌终端、某些 CI 环境中 `isTTY` 可能为
  false，此时会自动退化成打印帮助 —— 属预期行为，用命令式即可。

### 改了代码之后的手工冒烟

```
npm run cli                                    # 进菜单，走一遍「搜到被删评论 → 恢复」
npm run cli -- stats overview                  # 概览能出数
npm run cli -- blog search <正文里的词> --status deleted
npm run cli -- blog restore <id> --yes         # 再 search 确认已恢复
npm run cli -- audit log --action restore_blog # 审计里有，且主体是真实站长
npm run cli -- fish compensate 1 --dry-run --yes  # 只列计划、不动账（鱼干那一组还能用）
```

在向导里按一次 `Ctrl-C`，确认它回到菜单而不是退出、也没留下半完成的写入。

---

## 七、相关脚本

| 脚本 | 与 CLI 的关系 |
|------|---------------|
| `scripts/check-secrets.mjs` | 检测密钥与生产数据有没有进版本库 |
| `scripts/diagnose-deploy.mjs` | 部署前自检（运行时版本 / `.env` / 数据库 / 密钥） |
| `scripts/compensate-unclaimed-fortunes.mjs` | 一次性补偿「已签到未翻牌」的鱼干记录 |
| `scripts/cli.ts` | CLI 入口；命令声明在 `scripts/cli/registry.ts` |

## 八、给维护者：加一条命令

1. 在 `scripts/cli/commands/<域>.ts` 里加一个 `CommandSpec`，
2. 挂进 `scripts/cli/registry.ts` 的 `COMMANDS`。

**`--help` 与交互式向导会自动跟上** —— `scripts/cli/wizard.ts` 不需要改一行，因为它就是
拿注册表的元数据当脚本用的。`tests/unit/cli-registry.test.ts` 会守住注册表自身的完整性
（命名、位置参数序号、flag 不与全局冲突、危险命令必须写 `describe`），
`tests/unit/cli-guards.test.ts` 会守住**三条**硬约定（`--help` 不加载 Prisma、时间戳只用一把钟、
不许顶层 await —— `scripts/` 按 CJS 语义执行）。
