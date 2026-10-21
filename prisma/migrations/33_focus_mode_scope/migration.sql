-- 专注模式自定义作用范围
--
--   users.focus_hide_categories —— 用户自选要屏蔽的博客栏目 id（JSON 数组文本）
--     NULL  = 未自定义 → 沿用站长在 categories.focus_hidden 标记的默认集合；
--     '[]'  = 明确选择「一个都不屏蔽」。
--     两种状态**不可合并**：把 NULL 当成空数组会让存量用户突然看到全部水区。
--
--   users.focus_block_lobby / focus_block_games / focus_block_fish_trade
--     —— 三个可关的干扰源（默认全开）。默认值刻意等于改版前的行为：
--     存量的 focus_mode=true 用户升级后看到的东西与升级前完全一致。
--
-- 本次只加列，不做任何存量 UPDATE —— 用户的自定义从下一次保存开始产生。

ALTER TABLE "users" ADD COLUMN "focus_hide_categories" TEXT;
ALTER TABLE "users" ADD COLUMN "focus_block_lobby" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "focus_block_games" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "focus_block_fish_trade" BOOLEAN NOT NULL DEFAULT true;
