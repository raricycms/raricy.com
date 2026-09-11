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

> **未迁移**：Flask 时代的 `flask fish compensate`（全站群发补偿，涉及限频 / 批次幂等 /
> 断点续跑）与 `flask import-blogs`（历史博客导入；正文早已存 `BlogContent` 表）。
> 需要时另写专用脚本（参考 `scripts/compensate-unclaimed-fortunes.mjs`）。

---

## 一、交互式模式

不带参数、且在真正的终端里跑，就会进菜单：

```
聪明山 运维台                    审计身份：owner cms（可切换）

  1. 用户管理        5. 邀请码
  2. 内容检索与恢复   6. 审计日志 / 申诉
  3. 小鱼干          7. 站点概览
  4. 角色            8. OAuth 应用
  q. 退出

> 2

内容检索与恢复
  1. 搜博客  2. 搜云剪贴板  3. 搜评论  4. 搜投票  5. 搜图床   b. 返回
> 3

关键词（回车跳过 = 全部）> 报错
状态  1. 全部（含已删除）  2. 仅未删除  3. 仅已删除
作者（回车跳过）>

  [1] 我也遇到报错…      bob    2026-08-03  正常
  [2] 这个问题报错在…    alice  2026-07-29  已删除
  n. 下一页   k. 换关键词   b. 返回
> 2

──────────────────────── 即将执行 ────────────────────────
命令：comment restore
执行者：owner cms（审计 admin_id = e43de295-…）
  评论作者：alice   文章：《构建报错排查》
  内容预览：这个问题报错在第三行…
后果：BlogComment.isDeleted → false；重算文章评论计数；写 restore_comment 审计日志。
──────────────────────────────────────────────────────
确认执行？ (y/N) › _
```

几个要点：

- **不用背命令，也不用背 ID。** 凡是「选某个实体」的参数（文章 / 评论 / 剪贴板 /
  投票 / 图片 / 用户 / 申诉），向导都让你**输关键词 → 从结果里挑**。
- **导航约定**：每层菜单都有 `b. 返回`；自由文本提示后写着 `（:b 返回上一步，:q 回主菜单）`；
  select 类的前两项固定是「← 返回上一步 / ✕ 取消本次操作」。
- **退回上一题会带出原答案当默认值**，不用重敲。
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

沿用 Flask 时代的 `click` 风格：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功（**包括用户主动取消** —— 取消不是错误） |
| `1` | 参数或用户错误（用户名不存在、amount 不合法、业务规则拒绝） |
| `2` | **账户服务同步失败**（本地事务已补偿回滚，余额未变） |

```bash
npm run cli -- fish grant alice 100
if [ $? -eq 2 ]; then
  echo "远端账户服务故障 — 已自动回滚，请排查账户服务后重试"
fi
```

---

## 四、确认与审计

### 危险操作需要确认

| 危险级别 | 命令 | 行为 |
|----------|------|------|
| 破坏性 | 角色变更 · 用户禁言 · 强制下线 · 重置密码 · 文章/评论/剪贴板/投票的删除与恢复 · 申诉裁决 | 终端里弹「即将执行」确认屏；非交互必须加 `--yes` |
| 不可逆 | `invite revoke`（物理删除邀请码行） | 同上，且确认屏会额外标注「不可恢复」 |
| 安全 | 各类检索 / 查看 / `stats overview` / `fish grant`、`fish deduct` / OAuth 应用管理 | 不确认 |

确认屏会列出**具体将发生什么**（目标、字段级变更、后果、是否通知对方），而不是笼统的「确定吗」。

> **鱼干为什么不在危险集里**：它的写路径已经是 fail-closed（远端失败即补偿回滚），
> 且每一笔都留在 `fish_transactions` 与 `account_sync_ledger` 里可查可重放 ——
> 再加一道确认只会让 `docs/` 里的示例不能直接粘贴执行。

### 审计身份

写操作都会记一条审计日志（默认 `visibility: 'public'`，见 `/audit` 公示页）。审计主体：

1. `--as <username>` 指定的用户；否则
2. 库内**最早的站长**（`createdAt` 升序）；都没有则
3. 直接报错，**绝不**伪造一个主体。

**为什么不能伪造**：`admin_action_logs.admin_id` 与 `user_bans.admin_id` 都是指向
`users.id` 的**真实外键**，而且审计日志的全部意义就在于「这是谁做的」。

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
| `user reset-password <username> [generate\|manual] --reason <原因>` | 重置密码（旧会话全部失效） |
| `user ban <username> --hours N --reason <原因>` | 禁言 |
| `user unban <username> [--reason <原因>]` | 解除禁言 |
| `user force-logout <username> [--reason <原因>]` | 强制下线（比禁言轻一档） |

```bash
# 重置密码：默认生成 16 位随机密码，只显示一次
npm run cli -- user reset-password alice --reason "用户申诉邮箱被盗" --yes
#   新密码：xK9mP2qL7vN4wR8t
```

新密码**永远不会进审计日志** —— `/audit` 是公开页。

### 内容检索与恢复

**这一组是这套工具存在的主要理由**：站内此前既没有评论 / 剪贴板搜索，也没有任何
「找回被误删内容」的入口（除了申诉通过时的副作用）。

| 命令 | 作用 |
|------|------|
| `blog search [关键词] [--status all\|active\|deleted]` | 搜文章，**含正文** |
| `blog show <id>` / `blog restore <id>` / `blog delete <id> --reason <原因>` | 查看 / 恢复 / 删除 |
| `comment search [关键词] [--blog <文章id>] [--status …]` | 搜评论 |
| `comment show <id>` / `comment restore <id> --reason <原因>` / `comment delete <id> --reason <原因>` | 查看 / 恢复 / 删除 |
| `clip search [关键词] [--status …] [--publicity …]` | 搜云剪贴板（含私有） |
| `clip show <id> [--full]` / `clip restore <id>` / `clip delete <id> --reason <原因>` | 查看 / 恢复 / 删除 |
| `vote search` / `vote show` / `vote restore` / `vote delete` | 投票同上 |
| `image search` / `image show` / `image restore` | 图床（**没有物理删除**） |

几处不显然的行为：

- **检索默认含已删除**（`--status` 默认 `all`）。想只看活着的加 `--status active`。
- **搜文章默认搜正文**（标题 / 描述 / 正文 / 作者 / 精确 id）。网页后台仍是只搜标题 ——
  那条服务是 opt-in 的，网页行为没有变。
- **列表不显示正文**：剪贴板正文上限 5 万字，一页 20 行就是近一兆。正文用 `clip show` 单条看。
- **`image show` 会报告磁盘文件是否还在**。软删只翻标志位、不删文件，但文件可能被手工
  清理过 —— 恢复一条文件已不在的记录，页面上会是坏图，这件事必须在动手**之前**看到。
- **恢复评论时会提醒 `status ≠ approved` 的情况**：`isDeleted` 与 `status` 是两个正交的
  闸门，只翻前者的话评论恢复了也不会出现在评论区。

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
| `fish grant <username> <amount> [-d 说明]` | 赠送（fail-closed） |
| `fish deduct <username> <amount> [-d 说明]` | 扣减（fail-closed） |
| `fish balance <username>` | 查余额 |
| `fish pending` | 列出账本里未同步的账目 |
| `fish sync-retry` | 重放 pending / failed 的远端同步 |

`amount` 是正整数，单位是**整个小鱼干**。写路径 fail-closed：远端账户服务失败 →
本地写入被补偿事务精确撤销（对用户等价于回滚）→ **退出码 2**。绝不静默成功。

未配置 `ACCOUNT_SERVICE_INTERNAL_TOKEN` 时远端同步被跳过，CLI 会显式警告（不会假装已同步）：

```
⚠️ 账户服务未配置，仅写入本地库（远端账目未同步）
```

**崩在「本地已提交、远端未同步」之间怎么办**：`fish pending` 看残留，`fish sync-retry` 按
幂等键重放收敛。`stats overview` 也会把这两个数字报出来。

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
| `stats overview` | 人数 / 内容量 / **已删内容** / 待审申诉 / 鱼干账目状态 |

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
npm run cli -- fish pending                    # 未配账户服务时应有 pending 行
```

在向导里按一次 `Ctrl-C`，确认它回到菜单而不是退出、也没留下半完成的写入。

---

## 七、相关脚本

| 脚本 | 与 CLI 的关系 |
|------|---------------|
| `scripts/check-secrets.mjs` | 检测密钥与生产数据有没有进版本库 |
| `scripts/diagnose-deploy.mjs` | 部署前自检（运行时版本 / `.env` / 数据库 / 密钥） |
| `scripts/compensate-unclaimed-fortunes.mjs` | 一次性补偿「已签到未翻牌」的鱼干记录 |
| `scripts/verify-account-integration.mjs` | 端到端对账账户微服务（需独立空库） |
| `scripts/cli.ts` | CLI 入口；命令声明在 `scripts/cli/registry.ts` |

## 八、给维护者：加一条命令

1. 在 `scripts/cli/commands/<域>.ts` 里加一个 `CommandSpec`，
2. 挂进 `scripts/cli/registry.ts` 的 `COMMANDS`。

**`--help` 与交互式向导会自动跟上** —— `scripts/cli/wizard.ts` 不需要改一行，因为它就是
拿注册表的元数据当脚本用的。`tests/unit/cli-registry.test.ts` 会守住注册表自身的完整性
（命名、位置参数序号、flag 不与全局冲突、危险命令必须写 `describe`），
`tests/unit/cli-guards.test.ts` 会守住两条硬约定（`--help` 不加载 Prisma、时间戳只用一把钟）。
