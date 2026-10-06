// 测试数据库工具：在临时 SQLite 上建表 / 清表 / 造种子数据。
//
// 安全保证：DATABASE_URL 由 tests/setup.ts 指向 tests/.tmp/test.db，
// 且下方 assertTestDb() 会硬校验，绝不会连到真实库。

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { fishToUnits } from '@/lib/fish-units';
import { TEMPLATE_DB } from './db-template';

// 测试库路径由 tests/setup.ts 生成为 tests/.tmp/test-<pid>-<rand>.db —— 每进程独立，
// 避免多个 vitest 进程共用一个文件、互相 rmSync 重建（会随机报 no such table /
// readonly database，看起来像被测代码不稳，实为测试基建自伤）。故此处按**前缀**校验。
const TEST_DB_PREFIX = 'tests/.tmp/test-';

/** 硬校验（第一道，查**配置**）：连的必须是测试库，否则直接抛错（防止误伤真实数据）。 */
function assertTestDb() {
  const url = process.env.DATABASE_URL || '';
  // Windows 上 setup.ts 的 path.join 产出反斜杠（file:C:\...\tests\.tmp\...），
  // 归一化成 / 再按前缀校验，避免「期望包含 tests/.tmp/test-」在 Windows 误报。
  if (!url.replace(/\\/g, '/').includes(TEST_DB_PREFIX)) {
    throw new Error(
      `拒绝在非测试库上运行：DATABASE_URL=${url}（期望包含 ${TEST_DB_PREFIX}）`
    );
  }
}

/**
 * 硬校验（第二道，查**实际连接**）：这个 PrismaClient 真正打开的文件必须是测试库。
 *
 * ★ 为什么上面那道不够 —— 2026-09 出过一次真事故 ★
 * 有人在 `tests/setup.ts` **顶部 import** 了一个会拖进 `@/lib/db` 的模块。而
 * **setup 文件的 import 早于它自己的模块体执行** —— 于是 PrismaClient 在
 * `process.env.DATABASE_URL = …` 那一行**之前**就用 `.env` 里的真库建好了实例。
 * 此后环境变量是对的（所以上面那道闸一路放行），而每一次 `resetDb()` 的 deleteMany
 * 都打在**开发库**上：**465 个用户被清空**（靠前一天的备份才救回来）。
 * 那道闸查的是「配置」，这里查的是「连接」—— 配置对了而连接错了，只有后者看得见。
 *
 * `PRAGMA database_list` 返回该连接真正打开的文件路径。
 * 每次 `resetDb()` 前跑一次（一条 PRAGMA，开销可忽略）。
 */
async function assertConnectedTestDb() {
  const rows = await prisma.$queryRawUnsafe<{ file?: unknown }[]>('PRAGMA database_list');
  const files = rows
    .map((r) => String(r.file ?? ''))
    .join(' ')
    .replace(/\\/g, '/');
  if (!files.includes(TEST_DB_PREFIX)) {
    throw new Error(
      `拒绝在非测试库上运行：这个 PrismaClient 实际连的是 ` +
        `「${files || '(内存库)'}」，而期望包含 ${TEST_DB_PREFIX}。\n` +
        `  ⚠️ 多半是某个 setup / 辅助模块在 tests/setup.ts 执行 DATABASE_URL 赋值**之前**\n` +
        `     就 import 了 @/lib/db —— import 先于模块体执行，客户端于是用 .env 连上了真库。\n` +
        `     逐个检查 setupFiles 的顶层 import 链里有没有 @/lib/db（含间接的）。`
    );
  }
}

let schemaReady = false;

/**
 * 首次调用时准备本测试文件的库（幂等）。
 *
 * 从 tests/global-setup.ts 建好的模板库**复制**一份，而不是自己再 `prisma db push`
 * 一遍 —— 后者单次要 3s（prisma CLI 启动 + 引擎加载占 2.5s），每个测试文件都付一次
 * 就是全量 38% 的开销。详见 tests/global-setup.ts 的注解。
 */
export function ensureSchema() {
  assertTestDb();
  if (schemaReady) return;
  const dbPath = process.env.DATABASE_URL!.replace(/^file:/, '').split('?')[0];
  // 每轮从零开始，避免同进程内上一个文件的残留（文件名带随机串，正常不重名）
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  if (fs.existsSync(TEMPLATE_DB)) {
    fs.copyFileSync(TEMPLATE_DB, dbPath);
  } else {
    fs.writeFileSync(dbPath, ''); // 同 global-setup：Windows 引擎需要已存在的空 SQLite 文件。
    // 兜底：globalSetup 没跑成（比如模板被手工删掉、或有人在跳过 config 的场景下
    // 单独 import 本模块）时退回自建，保证用例仍能跑。
    // Windows 下 npm 可执行名是 npx.cmd（批处理），execFileSync 无法直接拉起
    // （ENOENT / EINVAL）。execSync 默认走 shell（POSIX /bin/sh、Windows cmd.exe），
    // 跨平台都能解析 npx。命令参数全是固定字面量，无注入面。
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: 'pipe',
    });
  }
  schemaReady = true;
}

/** 清空所有业务表（保留结构）。每个用例前调用，保证互不干扰。 */
export async function resetDb() {
  assertTestDb();
  ensureSchema();
  // 查**实际连接**（不是环境变量）—— 见 assertConnectedTestDb 的注释：
  // 配置对而连接错，是清空真实库的那条路径。放在任何 deleteMany 之前。
  await assertConnectedTestDb();
  // 顺序：先删子表再删父表，避免外键约束
  const tables = [
    'chat_messages', 'chat_members', 'chat_channels',
    'comment_likes', 'blog_comments', 'blog_likes', 'blog_feeds',
    // 匿名化名分配表引用 blogs 与 users —— 必须排在两者之前删。
    // ⚠️ 漏登记**不报错**（下面那条 DELETE 的 catch 会吞掉），表现为化名序号在用例间残留。
    'blog_anon_identities',
    // 收藏夹引用 favorites 与 blogs，favorites 引用 users —— 都必须先于它们删
    'favorite_items', 'favorites',
    // 可见性变更记录引用 blogs 与 users —— 必须排在两者之前删
    // （见 migrations/19_blog_visibility_logs 头部：漏登记不报错，只表现为数据残留）
    'blog_visibility_logs',
    'blog_contents', 'blogs', 'categories',
    'vote_records', 'vote_options', 'votes',
    'clip_text', 'clipboards', 'image_hosting',
    // 音频床与图床同形，同样只引用 users —— 必须排在 users 之前。
    // ⚠️ 漏登记不报错（下面的 catch 会吞掉），表现为数据在用例间残留。
    'audio_hosting',
    'daily_checkins', 'fish_transactions', 'notifications',
    'admin_action_appeals', 'admin_action_logs',
    'user_bans', 'invite_codes',
    // OAuth 三表引用 users / oauth_applications —— 必须排在它们前面删，
    // 否则 DELETE users 撞外键（被下面的 catch 吞掉，表现为刷屏的 FK 报错）
    'oauth_access_tokens', 'oauth_authorization_codes', 'oauth_applications',
    // 鱼干只读凭据 / 回调都引用 users —— 同样必须先于 users 删。
    // deliveries 与 endpoints 之间**刻意没有外键**（理由见 migrations/16_fish_webhooks
    // 头部），所以两者之间的顺序无所谓；它们相对 users 的顺序才是有意义的。
    'fish_api_tokens',
    'fish_webhook_deliveries', 'fish_webhook_endpoints',
    // 练手盘持仓引用 users —— 同样必须排在 users 之前。
    // ⚠️ 漏登记**不报错**（下面那条 DELETE 的 catch 会吞掉），表现为数据在用例间残留。
    'market_positions',
    // 头像框持有账引用 users —— 同样必须排在 users 之前（见 migrations/20_user_frames
    // 头部）。⚠️ 同上：漏登记不报错，只表现为数据残留。
    'user_frames',
    'users',
    'account_sync_ledger',
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
  focusMode: boolean;
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
      driedFish: fishToUnits(opts.driedFish ?? 0), // 存储单位 = 0.1 鱼干（fish-units.ts）
      focusMode: opts.focusMode ?? false,
      // 与生产写路径同钟：本库时间戳语义是「UTC+8 墙上时间贴 Z」（db-time.ts），
      // 种子数据也必须走 nowForDb()，否则冻结时钟的用例里两把钟不一致。
      createdAt: nowForDb(),
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
  /** 专注模式隐藏（开启专注模式的用户看不到此栏目） */
  focusHidden: boolean;
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
      focusHidden: opts.focusHidden ?? false,
      parentId: opts.parentId ?? null,
      createdAt: nowForDb(),
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
  contentUpdatedAt: Date;
  allowAnonymousComments: boolean;
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
      // 不传就交给列默认值（true = 允许匿名评论），与真实建文路径一致
      ...(opts.allowAnonymousComments !== undefined
        ? { allowAnonymousComments: opts.allowAnonymousComments }
        : {}),
      createdAt: opts.createdAt ?? nowForDb(),
    },
  });
  await prisma.blogContent.create({
    data: {
      blogId: id,
      content: opts.content ?? '# hello',
      updatedAt: opts.contentUpdatedAt ?? nowForDb(),
    },
  });
  return blog;
}

export { prisma };
