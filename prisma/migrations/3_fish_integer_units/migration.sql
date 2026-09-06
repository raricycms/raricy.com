-- 3_fish_integer_units — 鱼干账目从 Float(REAL) 整数化：单位 = 0.1 鱼干。
--
-- 背景：dried_fish / fish_transactions.amount / blog_feeds.amount 原为 Float，
-- 类货币账目逐笔 IEEE754 累加有舍入漂移（0.1+0.2=0.30000000000000004），对账不稳。
-- 整数化后：1 鱼干 = 10 存储单位；应用层换算见 src/lib/fish-units.ts。
--
-- ⚠️ 本迁移**只能执行一次**（由 _raricy_migrations 保证）：重复手工执行会再 ×10。
-- 迁移前确认：三列不存在超过 1 位小数的值（×10 无损）；存在则 ROUND 按银家算法
-- 收敛到 1 位小数（业务上不应出现）。
--
-- SQLite 列保持 REAL 亲和（动态类型）：整数值在 REAL 列上存取无损，Prisma 以 Int
-- 读写正常。因此不做建表重建（users 被十余张表外键引用，重建风险远大于收益）。
-- 注意：此后 `prisma db pull` 会把这三列显示为 Float —— 以 schema.prisma 的 Int
-- 声明与 src/lib/fish-units.ts 的约定为准（schema 是手维护的目标态）。

UPDATE users SET dried_fish = CAST(ROUND(dried_fish * 10) AS INTEGER) WHERE dried_fish IS NOT NULL;
UPDATE fish_transactions SET amount = CAST(ROUND(amount * 10) AS INTEGER) WHERE amount IS NOT NULL;
UPDATE blog_feeds SET amount = CAST(ROUND(amount * 10) AS INTEGER) WHERE amount IS NOT NULL;
