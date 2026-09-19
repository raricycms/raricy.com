-- 鱼干练手盘：持仓表。
--
-- 背景：鱼干在此之前只有签到一条获取渠道（core+，1–5 条/天）。练手盘是第二条 ——
-- 用户投鱼干买入一个**绑定真实加密价格**的仓位，价格涨跌直接决定他能拿回多少鱼干。
--
-- ── 这不是交易所，也不是庄家对赌 ────────────────────────────────────────────
-- 没有撮合、没有对手盘、没有敞口。系统账户 `raricy-blog-system` 是**无限水池**：
-- 用户赚了就从它 mint，亏了就 burn 回它（它只存在于远端账户服务，本地没有 users 行，
-- 所以本表的流水行 related_user_id 留空、信息进 description —— 与签到同款）。
--
-- ── 一行 = 一个批次（lot），不是聚合持仓 ────────────────────────────────────
-- 同一个用户同一个标的可以有多行：每次开仓插一行，平仓就地改成 closed。
-- 不做「一个标的一行、数量累加」是因为那样要引入均价与部分平仓，而部分平仓会把
-- 幂等做成一件难事（同一个请求重放时要认出「这是同一笔」，而不是「又一笔部分平仓」）。
-- 一批一行的代价只是页面上多几行；好处是**每一行都能独立结算、独立补偿**。
--
-- ── status 的取值与流转 ─────────────────────────────────────────────────────
--   open    持有中
--   closed  已平仓（exit_* / payout_units / closed_at 一并写上）
-- **绝不物理删除**（全站口径）：closed 行是用户与运维查证的依据。
-- 唯一的例外是**远端同步失败的补偿事务删掉它** —— 那笔开仓从未生效，等价于签到
-- 翻牌失败时删掉流水行（见 checkin-service 的补偿段）。
--
-- ── 为什么 entry_price / exit_price 是 REAL，而 dried_fish 那批是整数 ────────
-- 3_fish_integer_units 把鱼干金额整数化（存 0.1 鱼干为单位）是为了防 IEEE754
-- 累加漂移 —— 那个理由在这里**不成立**：价格是**比值输入**，从不累加进账本，
-- 每笔交易各算各的；唯一进账本的数字是 payout_units，它在落库前就已经
-- Math.floor 成整数单位（同 fish-units.ts 的口径）。
-- **别顺手把它「统一」成整数单位** —— 那会给价格引入一个没人需要的标度，
-- 且让「BTC = 81236.25」这种值在库里变成一个要来回换算的谜。
--
-- ── open_key 是开仓的幂等键 ─────────────────────────────────────────────────
-- 由调用方每次生成（带随机后缀），唯一约束就是幂等的实现：重复插入会撞约束，
-- 调用方据此认出「这单已经开过了」并返回既有结果，而不是再开一仓。
-- 幂等键**必须每次唯一**，否则远端会按 X-Idempotency-Key 静默去重、本地却记两笔
-- （账目无声分叉）—— 见 fish-admin.ts 里那条随机后缀的来由。
-- 平仓**不需要**键：平一个已经 closed 的仓位就是重放，天然幂等。
--
-- ── 幂等 ────────────────────────────────────────────────────────────────────
-- CREATE TABLE / CREATE INDEX 都带 IF NOT EXISTS。
--
-- ⚠️ 物理外键必须写：测试库由 prisma db push 从 schema.prisma 生成、**会**建出外键，
--    不写就会「测试里外键生效、生产上不生效」（同 12_favorites 头部记录的那类分歧）。
-- ⚠️ 本表引用 users，tests/helpers/db.ts 的 resetDb() 必须列在 users **之前**。
--
-- 【为什么 open_tx_id / close_tx_id 不对 fish_transactions 建外键】
--   补偿事务会**删掉**那条流水（那笔钱从未动过）。建 RESTRICT 会让补偿删不掉、
--   建 CASCADE 会让流水一删就把持仓行也带走 —— 两种都不是我们要的。
--   与 16_fish_webhooks 不对 endpoints 建外键是同一类判断：这两列是**审计线索**，
--   不是完整性约束。核对不上时应当能看出来，而不是被数据库悄悄处理掉。
--
-- 本迁移**不含数据变换**，也没有任何时间戳写入。

CREATE TABLE IF NOT EXISTS "market_positions" (
    "id"            TEXT     NOT NULL PRIMARY KEY,          -- UUID4（用户内容口径，同 User/Blog/Comment）
    "user_id"       TEXT     NOT NULL,
    "symbol"        TEXT     NOT NULL,                      -- 白名单见 src/lib/market-price.ts 的 MARKET_SYMBOLS
    -- 投入的鱼干，**存储单位 = 0.1 鱼干**（同 users.dried_fish / fish_transactions.amount）
    "stake_units"   INTEGER  NOT NULL,
    "entry_price"   REAL     NOT NULL,                      -- 是价格不是金额，不参与 fish-units 换算（见上）
    "entry_quote_at" DATETIME NOT NULL,                     -- 成交价的取价时刻（nowForDb()）—— 审计用
    "open_tx_id"    INTEGER,                                -- 开仓那条流水行；无外键，见上
    "open_key"      TEXT     NOT NULL,                      -- 幂等键
    "status"        TEXT     NOT NULL DEFAULT 'open',
    "exit_price"    REAL,
    "exit_quote_at" DATETIME,
    -- 结算那一刻算出来的实发单位数，**不是事后重算的** —— 账目争议时以它为准
    "payout_units"  INTEGER,
    "close_tx_id"   INTEGER,
    "closed_at"     DATETIME,
    "created_at"    DATETIME,
    -- ON DELETE RESTRICT = Prisma 对「必填关系」的默认值，即 prisma db push 建出来的那个。
    -- 这里**没有**照抄 16_fish_webhooks 的 CASCADE：那个（与 1_oauth 的）跟 db push 生成的
    -- RESTRICT 并不一致，是既存的 drift。本站从不物理删用户，两种写法行为完全相同 ——
    -- 正因如此更该对齐，否则「测试库与生产库同形」这条规矩就成了一句空话。
    CONSTRAINT "market_positions_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "market_positions_open_key_key"
    ON "market_positions"("open_key");
-- 页面唯一的查询是「我的持仓」（where user_id + status），一个组合索引就够
CREATE INDEX IF NOT EXISTS "ix_market_positions_user_status"
    ON "market_positions"("user_id", "status");
