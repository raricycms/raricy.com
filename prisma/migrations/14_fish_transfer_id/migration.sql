-- 共享单号 transfer_id：**同一笔用户间转账的两条流水**（发送方 transfer 负、
-- 接收方 transfer_receive 正）写上同一个值，让双方能对上同一笔钱。
--
-- 为什么需要它：在此之前两条流水互相只指向**对方**（reference_id / related_user_id），
-- 各自的自增 id 也不在同一序列里。付款人拿自己的流水号来找商户核对，商户在自己账上
-- 查不到 —— 第三方「鱼干银行」因此只能靠金额 + 时间 + 备注文本去猜，而备注是谁都能
-- 写的自由文本。有了共享单号，商户可以直接按它对上账。
--
-- ★ 只覆盖**用户间转账**，不覆盖投喂（feed / feed_receive）★
--   投喂那对流水仍是老样子。将来若要统一口径，另起一条迁移，别回头改这里。
--
-- ★ 存量行保持 NULL，且**刻意不回填** ★
--   旧数据里没有任何可靠的配对依据：同金额、同秒的两笔转账会互相混淆，按
--   「金额 + 时间窗 + 双方 id」反推出来的配对是**猜的**，而猜错意味着把两笔钱
--   认成一笔。空值在这里是诚实的，猜一个比留空更糟。读取方要把 NULL 当作
--   「这笔早于该功能」处理，不要拿它当「数据损坏」。
--
-- 非空 vs 可空：可空。绝大多数流水（签到、投喂、管理员赠送、系统补偿）本来就
-- 没有对手方，硬塞一个单号等于给一个只对转账成立的概念编造全域语义。
--
-- 不需要**保密**：本迁移不新增任何「按单号查」的接口，单号只出现在转账双方
-- 各自的流水里，所以枚举它没有意义。它是个对账句柄，不是凭证。
--
-- 值 = sha256(幂等键)[:16]（16 位十六进制，64 bit），在 fish-market-service 里与
-- 幂等键同点算出。**派生而非随机**：这样同键重放（resolveDuplicate 的两条路径）
-- 无需任何额外状态就能回报原单的单号，也就没有第二份会漂移的副本。
--
-- 幂等：SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS（重复执行会报
-- duplicate column），一次性的保证来自 _raricy_migrations 跟踪表
--（同 11_comment_attachments 与 13_blog_visibility 头部所记）。
--
-- 本迁移**不含数据变换**，也没有任何时间戳写入。

ALTER TABLE "fish_transactions" ADD COLUMN "transfer_id" TEXT;

CREATE INDEX IF NOT EXISTS "ix_fish_transactions_transfer_id" ON "fish_transactions"("transfer_id");
