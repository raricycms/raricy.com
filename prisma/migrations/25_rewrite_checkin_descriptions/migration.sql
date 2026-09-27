-- 25_rewrite_checkin_descriptions —— 把存量签到流水描述里的「运势值」抹掉。
--
-- 背景：签到流水原先写作 `每日签到（运势值 3）`，那个数字就是翻牌翻出来的值、也就是
-- 当时发的鱼干数。机制已于 2026-09 下线（见 24_drop_fortune_columns 头部），新写入
-- 一律是 `每日签到`。但**存量行还带着那三个字**，而 /fish/transactions 是用户能翻到的
-- 页面 —— 不清掉就等于「站上仍有运势值表述」。
--
-- 只改 description 一列，**不碰 amount / created_at / 任何余额**：账目不变式
-- （users.dried_fish == 该用户全部 fish_transactions.amount 之和）逐字不受影响。
--
-- ── 为什么新描述里不写金额 ──────────────────────────────────────────────────
-- 历史行的金额是 1–5 各不相同的。把描述统一写成 `每日签到（3 小鱼干）` 会与同一行的
-- amount 列自相矛盾 —— 描述必须与任何单次奖励数额无关，才经得起「奖励以后调成别的数」。
-- 金额本来就有一列，读者看那一列。
--
-- ── 幂等 ────────────────────────────────────────────────────────────────────
-- 天然的：跑第二遍时 0 行命中 `LIKE '每日签到（运势值%'`，故不需要 21_fish_units_1e4
-- 那种自写哨兵（那条 ×1000 是非幂等的，重跑会再乘一次）。
-- WHERE 里 type 与前缀两个条件都要：只碰这一类行，别人手工塞的 checkin 流水描述原样留着。
--
-- ── 跑完请自查（SET 0 rows 是不出声的）──────────────────────────────────────
--   sqlite3 <db> "SELECT COUNT(*) FROM fish_transactions
--                  WHERE type='checkin' AND (description IS NULL OR description LIKE '%运势%');"
-- 期望 0。非 0 说明有描述长得不一样的历史行（比如更早年代写下的别的措辞）没被命中，
-- 那时人工看一眼再补一条迁移 —— 别把 LIKE 放宽成「所有 checkin 行」，那会连
-- 别人手工塞的备注一起改掉。
-- 另：`account_sync_ledger.payload` 是历史幂等登记的自由 JSON，理论上可能嵌过这句描述。
-- 它不对外显示（不是「站上的表述」），但想彻底干净就顺带查一次：
--   sqlite3 <db> "SELECT COUNT(*) FROM account_sync_ledger WHERE payload LIKE '%运势%';"
--
-- 本迁移不含 DDL，也不写任何时间戳。与 24 同批应用 —— 删列之后旧代码已经起不来了，
-- 两条一起跑完再换代码。

BEGIN IMMEDIATE;

UPDATE fish_transactions
   SET description = '每日签到'
 WHERE type = 'checkin'
   AND description LIKE '每日签到（运势值%';

COMMIT;
