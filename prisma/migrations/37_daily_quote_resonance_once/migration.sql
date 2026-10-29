-- 每日一言「每人每句一生一次」共鸣资格表。
--
-- 【为什么需要新表】旧规则是 (quote_id, user_id, day) 三元去重：换日、取消收藏、
-- 90 天后再次入选都能再共鸣一次。同一个人因此可以反复贡献共鸣人数，并按次重复扣款。
-- 新规则是 (quote_id, user_id) 一生最多一次，这张表就是**资格与人数**的唯一依据，
-- 日期只作为明细保留在 daily_quote_resonances 里。
--
-- 【为什么不给明细表直接加二元唯一索引】存量里可能存在跨日的重复组合（旧规则明确
-- 允许），加唯一索引会让迁移直接失败；而删掉重复明细会丢掉真实发生过的行为记录，
-- 并破坏它们与历史鱼干流水的对应。所以明细表**一行不删、一字不改**。
--
-- 【回填】每个 (quote_id, user_id) 取最早一条明细的 created_at。`INSERT OR IGNORE`
-- 让本迁移可重复执行（重复执行不会产生额外身份行、不会改动历史记账）。
-- **不改鱼干余额、不改流水、不删任何行。**
-- 回填包含已归档用户的旧记录：账号恢复后不应重新获得共鸣资格。
-- （普通人数统计走 `activeSubmitter` / 归档边界是另一回事，见服务头。）

CREATE TABLE IF NOT EXISTS "daily_quote_resonance_once" (
  "quote_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "first_resonated_at" DATETIME NOT NULL,
  PRIMARY KEY ("quote_id", "user_id"),
  FOREIGN KEY ("quote_id") REFERENCES "daily_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ix_daily_quote_resonance_once_user"
  ON "daily_quote_resonance_once"("user_id");

INSERT OR IGNORE INTO "daily_quote_resonance_once" ("quote_id", "user_id", "first_resonated_at")
SELECT "quote_id", "user_id", MIN("created_at")
FROM "daily_quote_resonances"
GROUP BY "quote_id", "user_id";
