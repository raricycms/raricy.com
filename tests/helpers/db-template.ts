// 测试库模板的路径定义，由 tests/global-setup.ts（负责建）与 tests/helpers/db.ts
// （负责拷）共用 —— 一处定义，避免两边漂移。
//
// 模板 = 用 prisma db push 从 schema.prisma 建的**空结构**库，不含任何用例数据。
// 各测试文件在 ensureSchema() 里 copyFile 复制一份自己的，互不干扰。

import path from 'node:path';

/** 临时目录：测试库 / 头像 / 图床都落在这里，整个目录已 gitignore。 */
export const TMP_DIR = path.resolve(import.meta.dirname, '..', '.tmp');

/** 模板库路径。由 global-setup 一次性建好，只读复用。 */
export const TEMPLATE_DB = path.join(TMP_DIR, 'template.db');

/** SQLite 的伴生文件后缀（写事务期间存在）。 */
export const SQLITE_SIDECARS = ['-wal', '-shm'];
