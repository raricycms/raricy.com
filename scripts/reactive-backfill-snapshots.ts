// ─────────────────────────────────────────────────────────────────────────────
// reactive-backfill-snapshots.ts — 历史正文的编译快照回填（部署运维，显式库）
//
// 用法：
//   DATABASE_URL="file:/绝对路径/db.db" npm run reactive:backfill -- [--apply] [--limit N]
//
// 默认 dry-run：只预检，不写任何行。`--apply` 才写入快照；逐篇顺序执行、可中断重跑，
// 已存在同内容版本快照的行直接跳过（幂等）。报告只输出 ID、格式、状态与诊断码，
// 不含正文 / 标题 / 作者。
//
// 为什么需要：统一管线后 Markdown 也走编译。历史 Markdown 没有快照时，读取路径会
// 现编译（有 LRU，但冷启动 / 多实例仍会付成本）。发布前在停写窗口回填，把冷编译
// 移出用户请求路径。Reactive 旧语法版本行若未先执行 `reactive:migrate-v07`，这里会
// 报 blocker，不会擅自迁移。
//
// 逻辑本体在 `src/lib/reactive/backfill.ts`（隔离库测试直接调它）；这里只负责
// 参数、默认库与退出码。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../src/lib/db';
import { backfillSnapshots } from '../src/lib/reactive/backfill';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 0;
if (args.some((arg) => arg !== '--apply' && arg !== '--limit' && arg !== String(limit))) {
  throw new Error('Usage: npm run reactive:backfill -- [--apply] [--limit N]');
}
if (limitIndex >= 0 && (!Number.isSafeInteger(limit) || limit < 1)) {
  throw new Error('--limit 必须是正整数');
}

try {
  const result = await backfillSnapshots(prisma, { apply, limit: limit || undefined });
  console.log(JSON.stringify(result, null, 2));
  if (result.blockers.length > 0 || result.summary.failed > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
