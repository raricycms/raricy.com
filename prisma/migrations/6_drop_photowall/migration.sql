-- 下线照片墙（photowall）功能：仅删除 photo_wall_items 表与其索引。
-- image_hosting（图床）/ users 表不受影响 —— photo_wall_items 是纯子表，
-- 图上架（0_init）时创建，索引随表删除时被 SQLite 一并回收。
-- 幂等：DROP ... IF EXISTS，重复执行不报错。

DROP TABLE IF EXISTS "photo_wall_items";
