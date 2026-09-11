# 从 instance.zip 还原数据目录与数据库

> 输入：仓库根目录的 `instance.zip`（gitignored 的实例归档）
> 产出：`instance/` 数据目录 + 一个 Prisma 能直连的 SQLite 库
> 实测：Node 22.22.2 / Next 15.5.20 / Prisma 6，除 `npm ci` 外全程约 1 分钟

## 归档里有什么

| 路径 | 内容 | 备注 |
|------|------|------|
| `instance/database/db.db` | 163 MB / 23 张表 | **Flask 时代**的库：时间戳是 TEXT，迁移归 Alembic 管 |
| `instance/avatars/` | 483 个 PNG | 用户头像 |
| `instance/images/` | 988 个文件 | 图床 |
| `instance/stories/` | 8 个合集 / 289 个文件 | `.md` / `.cattca` / `info.json` |
| `instance/blogs/` | 6195 个文件 | 历史遗留目录，当前无写入 |
| `instance/app.db` | 0 字节 | 空壳，忽略 |

归档里的库离「可用」差两件事，也正是下面第 2、3 步要做的：

1. **时间戳是 TEXT**（`"2025-08-09 20:48:45.776483"`）—— Prisma 解析即抛 `Conversion failed`（登录 500）；
2. **没有 `_raricy_migrations`** —— schema 停在 Flask 的最后一版，缺**基线之后的全部迁移**
   （OAuth / 账本 / 聊天 / 评论附件…）。**具体条数以 `npm run migrate -- status` 为准**，
   别照抄某个数字 —— 每加一个迁移它就会变。

## 0. 前置

```bash
npm ci                          # 严格按 lockfile（不要 npm install）
cp .env.example .env            # DATABASE_URL="file:../instance/database/dev.db"
npm run prisma:generate
```

## 1. 解压

```bash
unzip -q instance.zip -d .
node scripts/check-instance.mjs # 幂等：补齐 instance/{avatars,database,images,stories,blogs}
```

## 2. 规整时间戳（TEXT → INTEGER 毫秒）

```bash
npm run db:normalize
# 等价于 node scripts/normalize-datetimes.mjs \
#   --source ./instance/database/db.db --dest ./instance/database/dev.db
```

- 先把 `db.db` **复制**成 `dev.db`，再在副本上转换；**源库全程只读**（实测规整前后 md5 不变）
- 实测 313,101 个时间戳，1 秒；结束时把 `journal_mode` 切到 WAL
- 幂等：只转 `typeof='text'` 的值，重复跑安全

> 为什么不转成 ISO 文本：SQLite 跨存储类型比较**按类型序**（INTEGER < TEXT），文本会让 `gte` 恒真、`lt` 恒假 —— 曾导致历史文章全被算成「今天发的」，用户永久触发发帖上限。

## 3. 迁移：基线 + 应用

```bash
npm run migrate -- mark 0_init   # 表已存在 → 只登记，不执行 SQL
npm run migrate -- up            # 应用基线之后的全部迁移（现为 1_oauth … 11_comment_attachments）
```

`0_init` 是从 Flask 库反向生成的建表 SQL。**跳过 `mark` 直接 `up` 会在第一条 `CREATE TABLE "users"` 上失败**（表已存在）；失败不会留下半截 —— 第一条就炸，跟踪表也无记录。

实测约 23 秒（撰写时为 9 个迁移；现已增至 11 个，耗时会略增）。

## 4. 验证

```bash
npm run migrate -- status   # Pending 空；Applied = 迁移总数（当前 12 条 = 0_init + 11 个后续迁移）
npm run migrate -- verify   # checksum 一致
npm run diagnose            # 段 2/3 绿；段 4 需生产 SECRET_KEY
```

产出库实测：

| 项 | 值 |
|----|-----|
| 表 | 31（30 业务表 + `sqlite_sequence`），与既有 `dev.db` 的表/索引定义**逐字节一致** |
| 行数 | users 465 / blogs 6193 / comments 63231 / notifications 90174 |
| 时间戳 | 全部 INTEGER 毫秒；Prisma 可读且日期比较正确 |
| 结构变化 | `photo_wall_items` 已删（`6_drop_photowall`）；新增 oauth×3 / chat×3 / 账本 / 跟踪表；`users.notify_chat` 已删（`10_drop_notify_chat`）；`blog_comments` +`image_id`/`quote_blog_id`（`11_comment_attachments`） |

最后一道是起服务读真页：

```bash
npm run dev     # 打开 /u/<用户 uuid>
```

实测 `/u/e43de295-…` 渲染出「文章 ( 122 )」，与库内 `blogs where author_id=…` 的 122 一致。

## 5. 坑

| 坑 | 现象 | 处理 |
|----|------|------|
| 不基线化直接 `up` | `table "users" already exists` | 先 `mark 0_init` |
| `SECRET_KEY` 用开发值 | diagnose 段 4：抽查 5 条解开 0 条 | 从生产 `.env` **原样**搬 —— 唯一不可逆的一步 |
| 直接 `cp` 库文件 | WAL 下可能拷到不一致快照 | 用 `db:normalize` / `sqlite3 .backup` |
| 源库不存在 | 脚本抛「源库不存在」 | 没有空库兜底分支；空库起步请走 `npm run migrate -- up`（deploy.md §4「全新部署」） |
| `file:` 相对路径 | 基点相对 `prisma/`，不是项目根 | 用绝对路径最稳 |
| `chat_channels` lobby 种子 | `created_at` 是 ISO 文本 | `4_chat` 写死的固定值，无比较用途，忽略 |
| 手滑 `prisma migrate dev` / `db push` | 无视 `_raricy_migrations` 直接动 schema | 永远不要 |

## 6. 生产路径的差异

- 生产库是 `instance/database/db.db`（不是 `dev.db`），`DATABASE_URL` 用**绝对路径**
- 一键版：`npm run prepare:cutover -- --source <db.db> --dest <新库>` —— 备份 → 规整 → 33 个时间列全量墙上时间核对 → 补偿未翻牌签到 → diagnose；源库只读并在结束时比对 SHA-256。**需要系统 `sqlite3` CLI**
- 未翻牌签到补偿：`npm run db:compensate-fortunes -- --apply`
- 头像 / 图床 / 故事不需要任何处理，按目录结构放好即可

## 7. 回滚

源库 `db.db` 全程只读，规整产物是新文件。删掉 `dev.db`（含 `-wal` / `-shm`）即回到起点。
