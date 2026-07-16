// 全局测试环境：所有用例共用一份临时 SQLite（tests/.tmp/test.db），
// 由 tests/helpers/db.ts 在首次 import 时按 prisma schema 建表。
//
// 关键：DATABASE_URL 必须在任何 `@/lib/db` 被 import 之前设置好，
// 否则 PrismaClient 会连到 .env 里的真实库 —— 测试绝不能碰真实数据。

import path from 'node:path';
import fs from 'node:fs';

const TMP_DIR = path.resolve(import.meta.dirname, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const TEST_DB = path.join(TMP_DIR, 'test.db');

process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.SECRET_KEY = 'test-secret-key-do-not-use-in-prod';
// NODE_ENV 由 vitest 自动置为 'test'，无需（也不能，@types/node 标了 readonly）在此赋值。
// 账户服务默认不可达 —— 走 dev fallback 分支，用例里需要时再单独 mock
delete process.env.ACCOUNT_SERVICE_INTERNAL_TOKEN;
