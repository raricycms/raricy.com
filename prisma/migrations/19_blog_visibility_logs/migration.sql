-- 19_blog_visibility_logs —— 文章可见性变更记录
--
-- 【为什么值得一张表】`public` 是**不可逆**的（搜索引擎与第三方存档会抓走副本，改回来
-- 收不回那些副本），而在此之前「作者把自己的文章放出去」**不留任何痕迹**：
--   · 那条进通知的 changesDetail 只在「管理员编辑他人文章」时才发；
--   · 而 PUT / PATCH 都只认作者本人（档位 vs 归属，见 blog-service 文件头不变量【4】），
--     所以那条路径对可见性**根本不可达**。
-- 于是「这篇什么时候被放出去的、改过几次」无处可查。不可逆的动作该有账。
--
-- 【只记变更，不记创建】新文章落 `internal` 是默认档、不是「变更」—— 记它等于给每次
-- 发文都写一行噪音。存量文章在本表建立之前也没有行，同理。所以这张表回答的是
-- 「改过几次、什么时候」，不是「前世今生」。
--
-- 【actor_id 今天恒等于作者，为什么还留着】PUT / PATCH 都只认作者本人，所以这一列现在
-- 是冗余的。但账不该依赖「将来也不会有人代改」这个假设 —— 那个假设一旦破（比如哪天开了
-- 管理端代改），缺的那段历史**补不回来**。一列 TEXT 换这个，划算。
--
-- 【形态必须与 prisma db push 生成的一字不差】测试库由 schema.prisma 经 db push 生成，
-- 会建出外键；手写 SQL 少了 REFERENCES 的话，表现为「测试里外键生效、生产上不生效」。
-- 下面的 DDL 是从 db push 的产物里原样抄出来的（`SELECT sql FROM sqlite_master`），
-- 只加了 IF NOT EXISTS 保持幂等。
--
-- ⚠️ 排期注意：本表引用 blogs 与 users，所以 tests/helpers/db.ts 的 resetDb() 必须把它
--    排在 blogs / users **之前**删。**漏登记不报错**（那里 DELETE 的 catch 会吞掉
--    「表不存在」），表现为数据在用例间残留 —— 那种失败看起来像业务 bug。
--
-- 本迁移**不含数据变换**，也没有任何时间戳写入（创建时间由应用层 nowForDb() 给）。

CREATE TABLE IF NOT EXISTS "blog_visibility_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blog_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "from_value" TEXT NOT NULL,
    "to_value" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "blog_visibility_logs_blog_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blogs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "blog_visibility_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ix_blog_visibility_logs_blog" ON "blog_visibility_logs"("blog_id", "created_at");
