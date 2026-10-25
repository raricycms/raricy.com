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

CREATE UNIQUE INDEX IF NOT EXISTS "uq_reactive_snapshot_version"
  ON "reactive_snapshots" ("kind", "content_id", "content_version");
CREATE INDEX IF NOT EXISTS "idx_reactive_snapshot_content"
  ON "reactive_snapshots" ("kind", "content_id");
