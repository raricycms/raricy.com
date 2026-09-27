-- 24_drop_fortune_columns —— 删掉签到「运势值」机制的三列。
--
-- 为什么删：签到已于 2026-09 改成**一步式固定发鱼**（建记录 + 发 3 条鱼干 + 写流水，
-- 同一个事务，见 src/lib/checkin-service.ts 头部）。原先的两步式是「签到 → 翻牌定命」：
-- 五张牌 1–5 各一张，用户点选的那张决定他拿多少鱼干；下面这三列都是那套机制的产物：
--   • daily_checkins.fortune_value —— 翻出来的那个数（签到当时留 NULL）
--   • daily_checkins.fortune_pool  —— 签到那刻洗好的那副牌
--   • users.total_fortune          —— 历次 fortune_value 之和（从未对外展示）
-- 机制废除后三列再无写者与读者。
--
-- ⚠️ **不可逆**：删掉之后，存量的累计运势值与历史牌池数据就没了。这是站长的决定
--    （那套数值从未对外展示过，也没有任何结算依赖它）。
--
-- ── 为什么加 BEGIN IMMEDIATE ────────────────────────────────────────────────
-- `prisma db execute --file` 把整个脚本作为一条命令发送，**不等于**一个事务
-- （SQLite 在 autocommit 下逐条提交，见 21_fish_units_1e4 头部）。
-- 三条 DROP 若在中途失败，库里会留下「删了一半」的状态 —— 而 DROP COLUMN 写不出
-- IF EXISTS，重跑会在第一条已经删掉的列上直接报 `no such column`，把一次本可自愈的
-- 重试变成人工介入。显式事务让三条要么全成、要么全不成，重跑永远干净。
-- （10_drop_notify_chat 没加，是因为它只有一条语句，本身即原子。）
--
-- ── 幂等：DDL 不可重复，但崩溃能自愈 ────────────────────────────────────────
-- DROP COLUMN 没有 IF EXISTS，**手工重跑本文件会失败**（`no such column`），
-- 保护来自 _raricy_migrations 跟踪表（对齐 10_drop_notify_chat 的写法）。
-- 唯一的崩溃窗口是「COMMIT 成功、但 migrate.mjs 还来不及写跟踪行」—— 文件末尾那条
-- 哨兵（与 21_fish_units_1e4 同款）把这个窗口关掉了：COMMIT 之后跟踪行已经在库里，
-- 下次 `migrate up` 见到它就整份跳过，不需要人工 `mark`。
-- 代价与 21 一样：那一瞬间 checksum 是占位值 'pending'，此时 `migrate -- verify`
-- 会报漂移 —— **那是响亮的报错**，跑一次 `npm run migrate -- mark 24_drop_fortune_columns`
-- 即刷新成真值。
-- ⚠️ 除这条恢复路径之外，别手工重跑本文件。
--
-- ── 为什么用 DROP COLUMN 而不是重建表 ───────────────────────────────────────
-- SQLite 3.35+ 原生支持（Prisma 6 自带的是 3.46），且本仓已有先例：10_drop_notify_chat
-- 删的就是 users 的列，而 users 被十几张表用外键指着（「不能删被外键用到的列」说的是
-- 被引用方如 users.id，不是父表上的普通列）。重建表（CREATE/INSERT/DROP/RENAME）要把
-- 那些外键与四个索引一起重来一遍，风险远大于收益。
--
-- ── 上真库前的自检（DROP COLUMN 会重解析整个 schema）────────────────────────
-- 它改完 CREATE TABLE 原文后要把整个 schema 重新解析一遍，于是**任何**遗留的
-- 坏对象（Alembic 时代留下的 view / trigger / 引用了不存在对象的 index）都会在这里
-- 变成失败。跑之前先看一眼，有输出就得先处理掉：
--   sqlite3 <db> "SELECT type, name, sql FROM sqlite_master
--                  WHERE type IN ('view','trigger') AND sql LIKE '%fortune%';"
--   sqlite3 <db> "SELECT type, name FROM sqlite_master
--                  WHERE type IN ('view','trigger');"
--
-- ⚠️ 本迁移属于**停服迁移**：列一删，旧代码的每一次 users 查询都会 `no such column`。
--    顺序必须是 停服 → migrate up → 换代码 → 起服务（docs/deploy.md）。

BEGIN IMMEDIATE;

ALTER TABLE "daily_checkins" DROP COLUMN "fortune_value";
ALTER TABLE "daily_checkins" DROP COLUMN "fortune_pool";
ALTER TABLE "users" DROP COLUMN "total_fortune";

-- 哨兵：与上面三条同一事务。checksum 由 migrate.mjs 的 markApplied 随后 upsert 成真值。
INSERT INTO _raricy_migrations (name, applied_at, checksum)
  SELECT '24_drop_fortune_columns', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending'
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '24_drop_fortune_columns');

COMMIT;
