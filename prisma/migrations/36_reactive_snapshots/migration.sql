-- reactive 正文的**同版本静态快照**（存储的是可信编译产物，不是作者 HTML）
--
-- 为什么是 JSON 而不是 HTML：服务端静态渲染要被 `react-dom/server` 带进 RSC 编译图，
-- Next 会直接拒绝（构建期失败）。把 `LocalDocument` 与 hostData 原样存下来，
-- 阅读页用上游组件的 `mode="static"` 渲染，得到的静态首屏与快照生成时完全一致，
-- 同时不需要在服务端再跑一遍 React 渲染。
--
-- 一致性：一行对应（kind, content_id, content_version）唯一版本；正文与快照在**同一个
-- 事务**里写入。编译签名（语法 / 包 / 适配器 / 选项键）不一致的旧行在读取时按 stale
-- 处理，绝不拿它冒充当前正文。
CREATE TABLE IF NOT EXISTS "reactive_snapshots" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "content_version" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'reactive',
  "scope" TEXT NOT NULL DEFAULT 'external',
  "syntax_version" TEXT NOT NULL,
  "compiler_version" TEXT NOT NULL,
  "adapter_version" TEXT NOT NULL,
  "options_key" TEXT NOT NULL,
  "document_json" TEXT NOT NULL,
  "host_data_json" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "generated_at" TEXT NOT NULL
);

-- ⚠️ 唯一索引名必须是 **Prisma 的派生名** `<表>_<列...>_key`，不是 `uq_*`。
--
-- `schema.prisma` 里写的是 `@@unique([kind, contentId, contentVersion], name: ...)`，
-- 但 **Prisma 在 SQLite 上忽略 `@@unique` 的 `name:`**，`prisma db push` 建出来的物理名
-- 是派生的 `reactive_snapshots_kind_content_id_content_version_key`。两边名字不一致的话，
-- `migrate diff` 会把它们判成漂移（RedefineIndex：DROP 再 CREATE），每次比对都报。
--
-- 仓库既有 4 个唯一索引全部照派生名手写，理由在 `26_blog_anonymous_comments` 的文件头；
-- 这里跟它们保持一致（那条纪律的原话：「写成 uq_* 就会与 db push 漂移」）。
CREATE UNIQUE INDEX IF NOT EXISTS "reactive_snapshots_kind_content_id_content_version_key"
  ON "reactive_snapshots" ("kind", "content_id", "content_version");
CREATE INDEX IF NOT EXISTS "idx_reactive_snapshot_content"
  ON "reactive_snapshots" ("kind", "content_id");
