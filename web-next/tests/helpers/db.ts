// 测试数据库工具：在临时 SQLite 上建表 / 清表 / 造种子数据。
//
// 安全保证：DATABASE_URL 由 tests/setup.ts 指向 tests/.tmp/test.db，
// 且下方 assertTestDb() 会硬校验，绝不会连到真实库。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '@/lib/db';

// 测试库路径由 tests/setup.ts 生成为 tests/.tmp/test-<pid>-<rand>.db —— 每进程独立，
// 避免多个 vitest 进程共用一个文件、互相 rmSync 重建（会随机报 no such table /
// readonly database，看起来像被测代码不稳，实为测试基建自伤）。故此处按**前缀**校验。
const TEST_DB_PREFIX = 'tests/.tmp/test-';

/** 硬校验：连的必须是测试库，否则直接抛错（防止误伤真实数据）。 */
function assertTestDb() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes(TEST_DB_PREFIX)) {
    throw new Error(
      `拒绝在非测试库上运行：DATABASE_URL=${url}（期望包含 ${TEST_DB_PREFIX}）`
    );
  }
}

let schemaReady = false;

/** 首次调用时用 prisma db push 建表（幂等）。 */
export function ensureSchema() {
  assertTestDb();
  if (schemaReady) return;
  const dbPath = process.env.DATABASE_URL!.replace(/^file:/, '').split('?')[0];
  // 每轮从零开始，避免上次残留
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: 'pipe',
    }
  );
  schemaReady = true;
}

/** 清空所有业务表（保留结构）。每个用例前调用，保证互不干扰。 */
export async function resetDb() {
  assertTestDb();
  ensureSchema();
  // 顺序：先删子表再删父表，避免外键约束
  const tables = [
    'comment_likes', 'blog_comments', 'blog_likes', 'blog_feeds',
    'blog_contents', 'blogs', 'categories',
    'vote_records', 'vote_options', 'votes',
    'clip_text', 'clipboards', 'image_hosting', 'photo_wall_items',
    'daily_checkins', 'fish_transactions', 'notifications',
    'admin_action_appeals', 'admin_action_logs',
    'user_bans', 'invite_codes', 'users',
  ];
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t}`).catch(() => {
      /* 表不存在则跳过 */
    });
  }
}

// ── 种子数据 ────────────────────────────────────────────────────────────────

let seq = 0;
// 不用 Date.now()：用例常用 vi.useFakeTimers 冻结时钟（签到的 UTC+8 边界测试必须冻），
// 冻结后 Date.now() 恒定，唯一性只剩 seq 扛着，很脆。用随机串 + 单调计数更稳。
const runTag = Math.random().toString(36).slice(2, 8);
const uid = () => `test-${runTag}-${++seq}`;

export type Role = 'user' | 'core' | 'admin' | 'owner';

/** 造一个用户。passwordHash 默认给个占位（需要真实校验的用例自己传）。 */
export async function makeUser(opts: Partial<{
  id: string;
  username: string;
  email: string;
  role: Role;
  passwordHash: string;
  sessionVersion: number;
  isBanned: boolean;
  banUntil: Date | null;
  banReason: string | null;
  driedFish: number;
  totalFortune: number;
}> = {}) {
  const id = opts.id ?? uid();
  return prisma.user.create({
    data: {
      id,
      username: opts.username ?? `u_${id}`,
      email: opts.email ?? `${id}@test.local`,
      passwordHash: opts.passwordHash ?? 'placeholder',
      role: opts.role ?? 'user',
      sessionVersion: opts.sessionVersion ?? 0,
      isBanned: opts.isBanned ?? false,
      banUntil: opts.banUntil ?? null,
      banReason: opts.banReason ?? null,
      driedFish: opts.driedFish ?? 0,
      totalFortune: opts.totalFortune ?? 0,
      createdAt: new Date(),
    },
  });
}

export async function makeCategory(opts: Partial<{
  name: string;
  slug: string;
  isActive: boolean;
  /** 对应 schema 的 adminOnlyPosting（栏目仅管理员可发文） */
  adminOnlyPosting: boolean;
  excludeFromAll: boolean;
  parentId: number | null;
}> = {}) {
  const n = ++seq;
  return prisma.category.create({
    data: {
      name: opts.name ?? `cat_${n}`,
      // slug 是 @unique 且非空、无默认值 —— 必须显式给，否则 Prisma 直接抛
      slug: opts.slug ?? `cat-${runTag}-${n}`,
      isActive: opts.isActive ?? true,
      adminOnlyPosting: opts.adminOnlyPosting ?? false,
      excludeFromAll: opts.excludeFromAll ?? false,
      parentId: opts.parentId ?? null,
      createdAt: new Date(),
    },
  });
}

/** 造一篇博客（含正文分表）。 */
export async function makeBlog(opts: Partial<{
  id: string;
  authorId: string;
  title: string;
  description: string;
  content: string;
  categoryId: number | null;
  ignore: boolean;
  createdAt: Date;
}> = {}) {
  const id = opts.id ?? uid();
  const author = opts.authorId ?? (await makeUser()).id;
  const blog = await prisma.blog.create({
    data: {
      id,
      authorId: author,
      title: opts.title ?? `t_${id}`,
      description: opts.description ?? 'desc',
      categoryId: opts.categoryId ?? null,
      ignore: opts.ignore ?? false,
      createdAt: opts.createdAt ?? new Date(),
    },
  });
  await prisma.blogContent.create({
    data: { blogId: id, content: opts.content ?? '# hello', updatedAt: new Date() },
  });
  return blog;
}

export { prisma };
