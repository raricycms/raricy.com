-- 21_fish_units_1e4 — 鱼干存储单位从 0.1 抬到 0.0001 条（×1000）。
--
-- 背景：3_fish_integer_units 把鱼干账目整数化时，粒度定在 0.1 条（1 鱼干 = 10 单位）。
-- 那个粒度对签到、投喂够用，但对**练手盘结算**是个陷阱 —— 结算是
--   payout_units = floor(stake_units × 平仓价 / 开仓价 × (1 − MARKET_FEE_RATE))
-- floor 刻意朝系统一侧，代价是每次结算丢零头；粒度 0.1 条时那一「点」最大 0.1 条，
-- 投 1 条、价格不涨过 0.1% 就必然结算成 0。提到 0.0001 条后零头上界变成 0.0001 条，
-- **损耗降 1000 倍**。换算口径见 src/lib/fish-units.ts（那是活的权威）。
--
-- ⚠️ 本迁移**只能执行一次**（由 _raricy_migrations 保证）：重复手工执行会再 ×1000。
--    与 3_fish_integer_units 同款纪律，但因为本文件带下面的哨兵，重跑本身是安全的 ——
--    真正的风险是「有人把哨兵删了再重跑」。
--
-- ── 覆盖五列，别只改 3_fish_integer_units 里那三列 ────────────────────────────
-- market_positions 的 stake_units / payout_units 也是 0.1 鱼干单位，但那张表由
-- 18_market_positions 建，**晚于** 3_fish_integer_units —— 那两列从来没被 ×10 碰过。
-- 漏掉它们的症状：持仓金额比余额小 1000 倍，且没有任何断言会当场报错。
--
-- ⚠️ 别顺手把 entry_price / exit_price "归一化" 成整数单位：那是**价格**不是金额，
--    从不累加进账本，REAL 是刻意的（理由见 18_market_positions 头部）。
--
-- ── 为什么用 BEGIN IMMEDIATE + 哨兵 ──────────────────────────────────────────
-- scripts/migrate.mjs 走 `prisma db execute --file`，而「整个脚本作为单条命令发送」
-- **不等于**「一个事务」（SQLite 在 autocommit 下逐条提交）。实测过：显式 BEGIN/COMMIT
-- 是被尊重的，且中途报错会整体回滚。没有它的话有两个洞：
--   1. 跑到一半崩 → 已翻倍的列留在新标度、其余留在旧标度，账目撕裂；
--   2. 跑完了但 markApplied 之前进程死掉 → 跟踪表没有记录 → 下次 migrate up 从头
--      再跑一遍 → **翻倍成 ×10^6**。这个洞更隐蔽，因为上一次看起来是「成功」的。
-- 哨兵（本文件自己写 _raricy_migrations 行）堵的是第 2 个：下次 cmdUp 见到这行就
-- 直接判定「已应用」并跳过。
--   代价：那一瞬间 checksum 是占位值 'pending'（文件自己的 sha256 无法在 SQL 里算），
--   此时跑 `migrate -- verify` 会报漂移 —— **这是响亮的报错，不是静默的**，
--   跑一次 `npm run migrate -- mark 21_fish_units_1e4` 即刷新成正确值。
--
-- ── ROUND 不是装饰，别省 ────────────────────────────────────────────────────
-- 裸 CAST(x * 1000 AS INTEGER) 是**截断（朝零）**，实测会在部分值上少 1 单位
-- （32.3→32299、128.2→128199）。本次数据全是整数、乘法精确，所以 ROUND 是纯保险 ——
-- 正因为「省掉也不会当场炸」，才更要留着。
-- 另注：SQLite 的 ROUND 是「.5 远离零」，与 JS 的 Math.round（「.5 向 +∞」）在负数上
-- 语义不同。本次没有 .5 值，且三列里只有 fish_transactions.amount 有负数。
--
-- 别给 payout_units 加 COALESCE(..., 0)：那会把**未平仓**的 NULL 变成 0，
-- 看起来像「已平仓、实发 0」。CAST(ROUND(NULL * 1000)) → NULL 天然安全。
-- 也别加 `WHERE ... IS NOT NULL`：这五列除 payout_units 外都是 NOT NULL。
--
-- ── 迁移后的量程（Prisma Int 是 32 位有符号）────────────────────────────────
-- 上界 2^31−1 = 2,147,483,647 单位 = 单账户 214,748.3647 条。⚠️ 别只按余额推算 ——
-- fish_transactions.amount 是**历史累计成交量**（练手盘可反复买卖放大），同一个上界。
-- 实测 dev 库迁移后最大约 2.0×10^7 单位，余量约 105×。详见 fish-units.ts 头部。
--
-- 本迁移**不含 DDL**，也不写任何时间戳到业务表。

BEGIN IMMEDIATE;

UPDATE users SET dried_fish = CAST(ROUND(dried_fish * 1000) AS INTEGER)
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '21_fish_units_1e4');

UPDATE fish_transactions SET amount = CAST(ROUND(amount * 1000) AS INTEGER)
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '21_fish_units_1e4');

UPDATE blog_feeds SET amount = CAST(ROUND(amount * 1000) AS INTEGER)
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '21_fish_units_1e4');

UPDATE market_positions SET stake_units = CAST(ROUND(stake_units * 1000) AS INTEGER)
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '21_fish_units_1e4');

UPDATE market_positions SET payout_units = CAST(ROUND(payout_units * 1000) AS INTEGER)
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '21_fish_units_1e4');

-- 哨兵：与上面五条同一事务。checksum 由 migrate.mjs 的 markApplied 随后 upsert 成真值。
INSERT INTO _raricy_migrations (name, applied_at, checksum)
  SELECT '21_fish_units_1e4', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending'
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '21_fish_units_1e4');

COMMIT;
