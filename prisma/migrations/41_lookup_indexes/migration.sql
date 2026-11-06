-- 41_lookup_indexes —— 两条热点查询的索引（R3-015）。
--
-- 1) notifications：列表 / 未读数 / 批量已读写全部是 `where recipient_id …`
--    （src/lib/notification-service.ts:165/221/295/311/326），此前 schema 只有
--    timestamp 索引 → 通知是高频页面（顶栏铃铛 + 心跳），每次都扫全表再过滤。
--    组合列取 (recipient_id, read, timestamp)：列表按 recipient 过滤后按 timestamp
--    排序可直接走索引；未读数用前两列。
-- 2) market_positions：强平扫描是 `where status='open' AND liquidation_price > 0`
--    （src/lib/market-liquidator.ts:266-272），此前只有 (user_id, status)，
--    这个谓词用不上。组合 (status, liquidation_price) 让「未结仓位」这一段连续、
--    范围条件直接落在索引上。
--
-- 索引名沿用 schema.prisma 的显式 `map:`，与 db push 的物理名一致 —— 否则
-- migrate diff 会报 RedefineIndex（见 26_blog_anonymous_comments 头部）。
CREATE INDEX IF NOT EXISTS "ix_notifications_recipient_read"
  ON "notifications" ("recipient_id", "read", "timestamp");

CREATE INDEX IF NOT EXISTS "ix_market_positions_open"
  ON "market_positions" ("status", "liquidation_price");
