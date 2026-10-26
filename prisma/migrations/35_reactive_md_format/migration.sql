-- 35_reactive_md_format —— 内容语言与逐篇渲染路径（ReactiveMD 接入前置，M0/P1）。
--
-- 六列，两类语义，**互不替代**：
--
--   1. `blog_contents.format` / `clip_text.format` —— 内容**本身**说的是什么语言。
--      'markdown' | 'reactive'，存量一律 markdown，本迁移**不改写任何正文**。
--      reactive 的写入闸门当前关闭（见 src/lib/content-format.ts 的
--      resolveContentWriteFormat）——列先建好，等同版本静态快照可生成再开放。
--
--   2. `blog_contents.syntax_version` / `clip_text.syntax_version` —— 仅 reactive
--      有值，写的是 LOCAL_SYNTAX_VERSION。它只服务升级审计与迁移提示，
--      **不是渲染开关**：别拿它决定走哪条管线。
--
--   3. `blogs.renderer_override` / `clipboards.renderer_override` —— 逐篇覆盖
--      兼容渲染路径：NULL（跟随全局开关）/ 'legacy' / 'reactive'。
--      它**不改变内容格式**；format='reactive' 禁止设 'legacy'（脏值只能报警并
--      静态降级，绝不把 reactive 源码交给旧解析器）。
--
-- 【为什么默认值写 'markdown'】不能留 NULL：NULL 会被调用方猜成各种默认，
--   而「猜成 markdown」正是本计划反复警告的静默错账。列上直接给出确定值，
--   读取端就只需要处理白名单内的两种。
--
-- 【形态必须与 prisma db push 生成的一致】测试库由 schema.prisma 经 db push 生成，
--   从不跑本目录。类型映射：String → TEXT，String? → TEXT。
--
-- ── 幂等与崩溃自愈 ──────────────────────────────────────────────────────────
-- ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS（SQLite 不支持），六条语句里任何一条
-- 半途失败都会让重跑撞上 `duplicate column`。所以显式 BEGIN IMMEDIATE 让六条要么
-- 全成、要么全不成（同 26_blog_anonymous_comments / 21_fish_units_1e4 的理由：
-- prisma db execute 把整份脚本当一条命令发送，SQLite 在 autocommit 下**逐条**提交，
-- 不是一个事务）。文件末尾那条哨兵与上面同一事务：COMMIT 之后跟踪行已在库里，
-- 下次 migrate up 整份跳过。

BEGIN IMMEDIATE;

ALTER TABLE "blog_contents" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE "blog_contents" ADD COLUMN "syntax_version" TEXT;
ALTER TABLE "clip_text" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE "clip_text" ADD COLUMN "syntax_version" TEXT;
ALTER TABLE "blogs" ADD COLUMN "renderer_override" TEXT;
ALTER TABLE "clipboards" ADD COLUMN "renderer_override" TEXT;

-- 哨兵：与上面几条同一事务。checksum 由 migrate.mjs 的 markApplied 随后 upsert 成真值。
INSERT INTO _raricy_migrations (name, applied_at, checksum)
  SELECT '35_reactive_md_format', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending'
  WHERE NOT EXISTS (SELECT 1 FROM _raricy_migrations WHERE name = '35_reactive_md_format');

COMMIT;
