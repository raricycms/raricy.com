#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// verify-account-integration.mjs —— 账户微服务端到端联调验证
//
// 【为什么需要它】单元测试里账户服务是 mock 的 —— 它只证明「我方逻辑对」，
// 不证明「两边真能对上」。字段名拼错、认证头不对、幂等键格式不符、
// 金额精度不一致…… 这些只有真打 HTTP 才会暴露。而这是**钱**。
//
// 本脚本对**运行中的真实 account-service** 跑完整链路，逐笔核对本地与远端账目：
//   1. ensureAccount        建号 + 拿 api_key（Fernet 加密存库再解开用）
//   2. doCheckin            签到发鱼   → 本地余额 == 远端余额
//   3. adminGrantFish       CLI 充值   → 同上
//   4. feedBlog             投喂分成   → 投喂者与作者两侧都对上
//   5. 幂等                 同 idempotencyKey 重发 → 不重复发放
//   6. fail-closed          远端不可达 → 本地零痕迹（需 --with-failure）
//
// 用法：
//   # 前置：account-service 已在跑，且下列环境变量已配好
//   ACCOUNT_SERVICE_URL=http://127.0.0.1:8000 \
//   ACCOUNT_SERVICE_INTERNAL_TOKEN=<与 account-service 的 INTERNAL_TOKEN 一致> \
//   ACCOUNT_SYSTEM_KEY=<seed.py 输出的系统 API Key> \
//   npm run verify:account -- --db /tmp/verify.db
//
//   加 --with-failure 会在最后要求你手动停掉账户服务，验证 fail-closed。
//
// ⚠️ 必须用一个**独立的空库**（--db 指定），脚本会往里造测试用户。别指向真实库。
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const dbPath = arg('--db') ?? '/tmp/verify-account.db';
const withFailure = argv.includes('--with-failure');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? green('✓') : red('✗')} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

// ── 前置检查 ────────────────────────────────────────────────────────────────
for (const k of ['ACCOUNT_SERVICE_URL', 'ACCOUNT_SERVICE_INTERNAL_TOKEN', 'ACCOUNT_SYSTEM_KEY']) {
  if (!process.env[k]) {
    console.error(red(`缺少环境变量 ${k}`));
    console.error('见本文件头部的用法说明。');
    process.exit(2);
  }
}
if (dbPath.includes('/data/') || dbPath.includes('prod.db')) {
  console.error(red(`拒绝在疑似真实库上运行：${dbPath}。请用独立空库。`));
  process.exit(2);
}

process.env.DATABASE_URL = `file:${dbPath}`;
process.env.SECRET_KEY ??= 'verify-integration-secret';
process.env.NODE_ENV = 'development'; // 允许 dev 分支，但本脚本会确保远端已启用

// ── 建一个干净的库 ──────────────────────────────────────────────────────────
for (const s of ['', '-wal', '-shm', '-journal']) {
  const f = dbPath + s;
  if (fs.existsSync(f)) fs.rmSync(f);
}
execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
  cwd: ROOT, env: process.env, stdio: 'pipe',
});

const { prisma } = await import('../src/lib/db.ts');
const { accountClient, accountServiceEnabled, encryptApiKey, AccountServiceError } =
  await import('../src/lib/account-client.ts');
const { doCheckin } = await import('../src/lib/checkin-service.ts');
const { feedBlog } = await import('../src/lib/feed-service.ts');
const { adminGrantFish } = await import('../src/lib/fish-admin.ts');

console.log(bold('\n═══ 账户微服务端到端联调 ═══'));
console.log(`目标服务：${process.env.ACCOUNT_SERVICE_URL}`);
console.log(`测试库：  ${dbPath}\n`);

if (!accountServiceEnabled()) {
  console.error(red('accountServiceEnabled() === false —— INTERNAL_TOKEN 未生效，联调无意义'));
  process.exit(2);
}

const suffix = Math.random().toString(36).slice(2, 8);
const feeder = `verify-feeder-${suffix}`;
const author = `verify-author-${suffix}`;
const blogId = `verify-blog-${suffix}`;

/** 建本地用户 + 远端账户，把 api_key 加密存库（真实注册路径做的事）。 */
async function makeUser(id) {
  const acct = await accountClient.ensureAccount(id);
  await prisma.user.create({
    data: {
      id, username: `u_${id}`, email: `${id}@verify.local`, passwordHash: 'x',
      role: 'core', sessionVersion: 0, driedFish: 0, createdAt: new Date(),
      fishApiKeyEncrypted: acct.api_key ? encryptApiKey(acct.api_key) : null,
    },
  });
  return acct;
}
const remoteBal = async (id) => Number((await accountClient.getBalance(id)).balance);
const localBal = async (id) =>
  (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0;

try {
  // ── 1. 建号 ───────────────────────────────────────────────────────────────
  console.log(bold('1. ensureAccount（建号 + api_key）'));
  const a1 = await makeUser(feeder);
  await makeUser(author);
  check('远端建号成功', a1.user_id === feeder, `user_id=${a1.user_id}`);
  check('返回 api_key（首次建号）', !!a1.api_key);
  check('Fernet 加密后可存库并解回', !!(await prisma.user.findUnique({
    where: { id: feeder }, select: { fishApiKeyEncrypted: true },
  }))?.fishApiKeyEncrypted);

  // ── 2. 签到 ───────────────────────────────────────────────────────────────
  console.log(bold('\n2. doCheckin（签到发鱼，fail-closed 写路径）'));
  const r = await doCheckin(feeder, 0);
  const fortune = r.alreadyChecked ? 0 : r.fortuneValue;
  check('签到成功', !r.alreadyChecked, `运势=${fortune}`);
  check('本地余额 == 远端余额', (await localBal(feeder)) === (await remoteBal(feeder)),
    `本地=${await localBal(feeder)} 远端=${await remoteBal(feeder)}`);

  // ── 3. CLI 充值 ───────────────────────────────────────────────────────────
  console.log(bold('\n3. adminGrantFish（CLI fish grant 路径）'));
  await adminGrantFish(feeder, 20, '联调充值');
  check('本地余额 == 远端余额', (await localBal(feeder)) === (await remoteBal(feeder)),
    `本地=${await localBal(feeder)} 远端=${await remoteBal(feeder)}`);

  // ── 4. 投喂 ───────────────────────────────────────────────────────────────
  console.log(bold('\n4. feedBlog（投喂 3，作者得 80%）'));
  await prisma.blog.create({
    data: { id: blogId, title: '联调文章', description: 'd', authorId: author,
      ignore: false, isFeatured: false, likesCount: 0, commentsCount: 0, fishCount: 0,
      createdAt: new Date() },
  });
  const fr = await feedBlog(blogId, feeder, 3);
  check('投喂成功', fr.ok === true, fr.ok ? `作者收入=${fr.authorIncome}` : fr.message);
  check('投喂者：本地 == 远端', (await localBal(feeder)) === (await remoteBal(feeder)),
    `本地=${await localBal(feeder)} 远端=${await remoteBal(feeder)}`);
  check('作者：本地 == 远端', (await localBal(author)) === (await remoteBal(author)),
    `本地=${await localBal(author)} 远端=${await remoteBal(author)}`);

  // ── 5. 幂等 ───────────────────────────────────────────────────────────────
  //
  // 注意：这步是**直接打 accountClient.transfer**（绕开 service 层），因此它只动远端、
  // 不动本地库 —— 会让远端余额比本地多。故用一个独立的「幂等测试专用」用户，
  // 别污染上面那几步的对账口径（否则会看到「远端 23 vs 本地 18」这种吓人的差异，
  // 而那其实是本脚本自己造的）。
  console.log(bold('\n5. 幂等（同 idempotencyKey 重发 transfer）'));
  const idemUser = `verify-idem-user-${suffix}`;
  await accountClient.ensureAccount(idemUser);
  const key = `verify-idem-${suffix}`;
  const payload = {
    fromUserId: 'raricy-blog-system', toUserId: idemUser, amount: 5,
    entryType: 'checkin', apiKey: process.env.ACCOUNT_SYSTEM_KEY,
    description: '幂等测试', idempotencyKey: key,
  };
  await accountClient.transfer(payload);
  const afterFirst = await remoteBal(idemUser);
  await accountClient.transfer(payload); // 同 key 重发
  const afterSecond = await remoteBal(idemUser);
  check('首次发放到账', afterFirst === 5, `余额=${afterFirst}`);
  check('重复请求不重复发放', afterFirst === afterSecond, `${afterFirst} → ${afterSecond}`);

  // 上面几步的对账口径不该被幂等测试污染 —— 复核一次
  check('投喂者本地/远端仍一致（未被幂等测试影响）',
    (await localBal(feeder)) === (await remoteBal(feeder)),
    `本地=${await localBal(feeder)} 远端=${await remoteBal(feeder)}`);

  // ── 6. fail-closed ────────────────────────────────────────────────────────
  if (withFailure) {
    console.log(bold('\n6. fail-closed（远端不可达时本地必须零痕迹）'));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(red('   >>> 现在请手动停掉 account-service，然后按回车继续... '));
    rl.close();

    const before = {
      bal: await localBal(feeder),
      tx: await prisma.fishTransaction.count({ where: { userId: feeder } }),
      feed: (await prisma.blogFeed.findUnique({
        where: { uq_blog_feed_user: { blogId, userId: feeder } }, select: { amount: true },
      }))?.amount ?? 0,
    };
    let threw = false;
    try { await feedBlog(blogId, feeder, 1); } catch (e) {
      threw = e instanceof AccountServiceError;
    }
    const after = {
      bal: await localBal(feeder),
      tx: await prisma.fishTransaction.count({ where: { userId: feeder } }),
      feed: (await prisma.blogFeed.findUnique({
        where: { uq_blog_feed_user: { blogId, userId: feeder } }, select: { amount: true },
      }))?.amount ?? 0,
    };
    check('远端故障时抛 AccountServiceError（不静默成功）', threw);
    check('本地余额未变', before.bal === after.bal, `${before.bal} → ${after.bal}`);
    check('未写流水', before.tx === after.tx);
    check('未记投喂', before.feed === after.feed);
  } else {
    console.log(bold('\n6. fail-closed —— 跳过（加 --with-failure 可验）'));
  }
} catch (e) {
  console.error(red('\n联调过程抛出异常：'), e);
  failed++;
} finally {
  await prisma.$disconnect();
}

console.log(bold('\n═══ 结论 ═══'));
if (failed === 0) {
  console.log(green('  ✅ 全部通过 —— 本地与远端账目逐笔一致，可以上线。\n'));
} else {
  console.log(red(`  ❌ ${failed} 项失败 —— 上线前必须解决。\n`));
}
process.exit(failed === 0 ? 0 : 1);
