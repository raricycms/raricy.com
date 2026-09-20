-- 20_user_frames —— 头像框：持有账 + users 上的装备指针
--
-- 【背景】头像框 = 一张带透明通道的 PNG 叠在头像上（贴图，不是 CSS 描边）。
--   框的**定义**（key / 显示名 / 排序）住在代码白名单 src/lib/frame-refs.ts 的
--   FRAME_KEYS —— 照 src/lib/market-price.ts 的 MARKET_SYMBOLS 先例：不建定义表、
--   不做后台 CRUD。素材字节在 instance/frames/<key>.png（gitignored，站长手工拷）。
--   本迁移只建「谁持有」与「当前装备」两层存储。
--
-- ── 持有 vs 装备是两层，别混 ────────────────────────────────────────────────
--   user_frames  = 「我有没有资格戴」——发放是站长的事（`npm run cli -- frame grant`），
--                  第二版会加上鱼干购买
--   users 两列    = 「我现在戴哪个」——用户自己的事（/settings 的面板）
--   一个用户可以同时持有多个框、只戴一个；也可以持有一个却不戴。
--
-- ── 为什么装备放 users 的两个冗余列，而不是一张 1:1 表 ──────────────────────
--   1) 全站 15 处渲染头像（落点清单见 docs/frontend-styles.md §4.1）。其中 8 处的数据
--      来自一条**已经在读 users 行**的查询，加列 = 同一个查询加两个 select 字段，零 join；
--      1:1 表则每处都要 include，而 chat-service 是**按消息批量**取作者的
--      （要么 N+1，要么再加一次批量查询并合并）。
--      **漏加的后果不是报错，是那一处永远没有框** —— 静默。
--   2) 到期判定需要「装备的 key」+「那一刻的到期时刻」两个标量。放 users 上，判定就是
--      零依赖纯函数（frame-refs.ts 的 resolveFrameKey），任何 DTO 生产点都能无成本调用；
--      放 1:1 表，判定被推到一个 join 上，而渲染路径不查持有表 —— 每个渲染点要么自己
--      join，要么漏判。
--   3) 时间到期**不需要任何写入**：users 上留下的过期 key 是**惰性**的（判定恒 null）。
--      无 cron / 无 drainer / 无「读时顺手清一下」—— 少一条静默失效路径。
--   ⚠️ 代价是这两列**冗余**，靠三条写路径维持（见 frame-service.ts 的不变量 F1/F2）。
--      最危险的一种漂移是「grant 续期后没刷新 equipped_frame_expires_at」——
--      症状是用户续期后**框永远不出现**，看起来像浏览器缓存。测试里有专项用例。
--
-- ── 形态必须与 prisma db push 生成的一致 ────────────────────────────────────
--   测试库由 schema.prisma 经 db push 生成、**会**建物理外键；手写 SQL 少了 REFERENCES
--   的话，表现为「测试里外键生效、生产上不生效」。下面的表体与约束是从 db push 的产物
--   原样抄出来的（`SELECT sql FROM sqlite_master`），只加了 IF NOT EXISTS 保持幂等。
--
-- ⚠️ 【唯一索引的名字必须是 prisma db push 的那个派生名】
--   Prisma 在 SQLite 上**忽略 `@@unique(..., name: "…")` 的名字**，物理索引一律用
--   派生名 `<表>_<列…>_key`。名字只影响 Prisma Client 的 API 名，不落到库。
--   ⚠️ 别被「名字无所谓」骗了：`prisma migrate diff` **确实**会因为这个名不对而报差异
--     （它会 DROP 掉 uq_xxx 再 CREATE 派生名）。所以手写的名字就是 drift。
--       · `@unique(map: "…")`（**单列**）是另一回事 —— 那个会落库，两边同名
--         （例：market_positions_open_key_key）。区别在 @@unique 与 @unique。
--       · 本仓 12_favorites 写的 "uq_favorite_item" 就是这类 drift（既存，未修）。
--   所以本表用派生名 "user_frames_user_id_frame_key_key"，与 db push 一字不差。
--
-- ⚠️ 排期注意：user_frames 引用 users，所以 tests/helpers/db.ts 的 resetDb() 必须把它
--    排在 users **之前**删。**漏登记不报错**（那里的 .catch() 吞掉「表不存在」），
--     表现为数据在用例间残留 —— 那种失败看起来像业务 bug。
--
-- 本迁移**不含数据变换**，也没有任何时间戳写入（created_at 由应用层 nowForDb() 给）。

CREATE TABLE IF NOT EXISTS "user_frames" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id"    TEXT NOT NULL,
    -- 白名单 key，见 src/lib/frame-refs.ts 的 FRAME_KEYS。**刻意不是外键** ——
    -- 框的定义住代码、不住库，加新框不需要迁移。
    "frame_key"  TEXT NOT NULL,
    -- NULL = 永久。「到期」不是「撤销」：过期后行照旧 alive（deleted 仍为 false），
    -- 判定在 frame-service.ts 的 frameUrlFor()。
    "expires_at" DATETIME,
    -- 'cli'（站长用运维台发）/ 'purchase'（第二版鱼干购买）/ 'system'。
    -- 不留这列的话「站长发的」与「买的」永远分不出来，而那段历史补不回来。
    "source"     TEXT NOT NULL DEFAULT 'cli',
    "created_at" DATETIME,
    "deleted"    BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" DATETIME,
    CONSTRAINT "user_frames_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 唯一的粒度是 (用户, 框) —— 一个人对同一款框只持有一行。
-- ⚠️ 唯一约束是**物理**的、包含墓碑行，因此「收回后再授予」必须**复活旧行**
--（翻转 deleted），不能新插 —— 会撞唯一约束。见 frame-service 的不变量 F4。
CREATE UNIQUE INDEX IF NOT EXISTS "user_frames_user_id_frame_key_key"
    ON "user_frames"("user_id", "frame_key");
-- 页面唯一的查询是「我持有的框」（where user_id），一个索引就够
CREATE INDEX IF NOT EXISTS "ix_user_frames_user_id"
    ON "user_frames"("user_id");

-- users 上的两个冗余列（取舍见本文件头部）。取值口径与唯一写入者见
-- src/lib/frame-service.ts 的不变量 F1/F2。
--
-- ⚠️ ALTER TABLE ADD COLUMN **没有** IF NOT EXISTS（SQLite 不支持）—— 幂等由
--    _raricy_migrations 跟踪表保证（已应用的迁移不会重跑），写法与 5_focus_mode 一致。
ALTER TABLE "users" ADD COLUMN "equipped_frame_key" TEXT;
ALTER TABLE "users" ADD COLUMN "equipped_frame_expires_at" DATETIME;
