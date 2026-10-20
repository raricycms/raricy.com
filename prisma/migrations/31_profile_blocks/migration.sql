-- 31_profile_blocks —— 个人主页的「积木」（bento 沙盒主页）
--
-- 【它是什么】一块积木 = 用户亲手挑的一个展示单元。存的是**指针**不是快照：
--   config 里放 blogId / imageId / audioId，渲染时现查目标行。目标被删、文章档位
--   降回 internal、作者被归档时，整块不渲染。绝不把标题/正文抄进 config ——
--   抄了就会出现「文章已经改成私有、名片上还挂着它」的洞。
--
-- 【坐标】桌面 4 列网格上的 (x, y) + 尺寸 (w, h)。尺寸白名单只有
--   1×1 / 2×1 / 1×2 / 2×2（见 src/lib/profile-blocks.ts）。允许留白，不允许重叠。
--
-- 【形态】created_at / updated_at 无默认（写路径显式 nowForDb()），软删用非可选
--   deleted 布尔（全站永不物理删除）。id 是应用层生成的 12 位短 id。
--
-- 【保存 = 整页替换】旧的块翻 deleted 墓碑、新的块插入，所以表里会长出墓碑行；
--   查询一律带 deleted: false。
--
-- 本迁移**不含数据变换**。

CREATE TABLE IF NOT EXISTS "profile_blocks" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "user_id"    TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
    "x"          INTEGER NOT NULL DEFAULT 0,
    "y"          INTEGER NOT NULL DEFAULT 0,
    "w"          INTEGER NOT NULL DEFAULT 1,
    "h"          INTEGER NOT NULL DEFAULT 1,
    "config"     TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME,
    "updated_at" DATETIME,
    "deleted"    BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "profile_blocks_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ix_profile_blocks_user_id" ON "profile_blocks"("user_id");
