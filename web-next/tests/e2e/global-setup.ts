// E2E 全局准备：从零建一个独立的 SQLite 测试库并灌入种子数据。
//
// 【与 tests/setup.ts（vitest）的分工】那边每个 vitest **进程**一个
// test-<pid>-<rand>.db；这边 Playwright 只有一个 webServer + workers:1，
// 全套用例共用 tests/.tmp/e2e.db。库名与 vitest 的 test-* 前缀不重叠，
// 两套 runner 同时跑也不会互相 rmSync。
//
// 【绝不碰真实数据】.env 里的 DATABASE_URL 指向 prisma/prod.db（真实数据的规整副本），
// AVATARS_DIR / IMAGE_UPLOAD_FOLDER 指向 data/。这些在 playwright.config.ts 的
// webServer.env 里被全部改指到 tests/.tmp。下方 assertTestDb() 再兜一道硬校验：
// 路径不在 tests/.tmp 下就直接抛，绝不让 db push 打到真实库上。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../src/lib/password';
import { nowForDb } from '../../src/lib/db-time';
import { SEED_PASSWORD, SEED_USERS, SEED_CATEGORY, SEED_BLOG, SEED_LOG } from './seed';

// __dirname 而非 import.meta.dirname：Playwright 把本文件转成 CJS 加载，import.meta 在那里会炸。
const E2E_DB = path.resolve(__dirname, '../.tmp/e2e.db');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** 硬校验：只允许在 tests/.tmp 下建库（对齐 tests/helpers/db.ts 的同款保险）。 */
function assertTestDb(dbPath: string) {
  if (!dbPath.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非测试库上运行：${dbPath}（必须位于 tests/.tmp/ 下）`);
  }
}

export default async function globalSetup() {
  assertTestDb(E2E_DB);

  fs.mkdirSync(path.dirname(E2E_DB), { recursive: true });
  // 每轮从零开始：上轮残留的用户会让「注册重名」「今天已签到」这类用例莫名其妙地挂
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(E2E_DB + suffix, { force: true });
  }

  const url = `file:${E2E_DB}`;
  // 用 db push 而非 migrate：本库的 schema 是从 Flask 建好的库 introspect 出来的，
  // 没有 migration 历史，migrate 会要求先 baseline。
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  // 显式传 url：本进程的 .env 指向 prod.db，不能靠环境变量兜底
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    // 密码哈希必须真算：登录用例走的是真实的 verifyPassword（werkzeug scrypt），
    // 塞占位串会让「登录成功」这条主链路根本跑不起来。
    const passwordHash = await hashPassword(SEED_PASSWORD);

    for (const u of Object.values(SEED_USERS)) {
      await prisma.user.create({
        data: {
          id: u.id,
          username: u.username,
          email: u.email,
          passwordHash,
          role: u.role,
          sessionVersion: 0,
          isBanned: false,
          driedFish: 0,
          totalFortune: 0,
          createdAt: nowForDb(), // 全库时间戳语义 = UTC+8 墙上时间，见 src/lib/db-time.ts
        },
      });
    }

    const category = await prisma.category.create({
      data: {
        name: SEED_CATEGORY.name,
        slug: SEED_CATEGORY.slug,
        isActive: true,
        adminOnlyPosting: false,
        // 必须 false：exclude_from_all 的栏目不会出现在「全部文章」列表里，
        // 列表页用例就会对着空列表断言失败
        excludeFromAll: false,
        parentId: null,
        createdAt: nowForDb(),
      },
    });

    await prisma.blog.create({
      data: {
        id: SEED_BLOG.id,
        authorId: SEED_USERS.core.id,
        title: SEED_BLOG.title,
        description: SEED_BLOG.description,
        categoryId: category.id,
        ignore: false,
        createdAt: nowForDb(),
      },
    });
    await prisma.blogContent.create({
      data: { blogId: SEED_BLOG.id, content: SEED_BLOG.content, updatedAt: nowForDb() },
    });

    // 一条公示日志 —— /audit 列表页与 /audit/[id] 详情页的用例都靠它。
    // 没有它，那些用例只会静默 skip（跳过 ≠ 通过）。
    await prisma.adminActionLog.create({
      data: {
        id: SEED_LOG.id,
        action: SEED_LOG.action,
        adminId: SEED_USERS.admin.id,
        targetUserId: SEED_USERS.plain.id,
        objectType: SEED_LOG.objectType,
        objectId: SEED_LOG.objectId,
        reason: SEED_LOG.reason,
        visibility: 'public',
        createdAt: nowForDb(),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
