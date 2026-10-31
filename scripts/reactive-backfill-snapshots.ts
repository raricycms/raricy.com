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
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../src/lib/db';
import { buildReactiveSnapshotForWrite } from '../src/lib/reactive/publish';
import { parseContentFormat } from '../src/lib/content-format';
import { reactiveContentVersion } from '../src/lib/reactive/snapshot-store';
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';

interface Row {
  kind: 'blog' | 'clipboard';
  id: string;
  content: string;
  format: string;
  syntaxVersion: string | null;
}

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

async function main(): Promise<void> {
  const [blogs, clips] = await Promise.all([
    prisma.blog.findMany({
      where: { ignore: false },
      select: { id: true, content: { select: { content: true, format: true, syntaxVersion: true } } },
    }),
    prisma.clipBoard.findMany({
      where: { ignore: false },
      select: { id: true, content: { select: { content: true, format: true, syntaxVersion: true } } },
    }),
  ]);

  const rows: Row[] = [
    ...blogs.filter((row) => row.content).map((row) => ({
      kind: 'blog' as const,
      id: row.id,
      content: row.content!.content,
      format: row.content!.format,
      syntaxVersion: row.content!.syntaxVersion,
    })),
    ...clips.filter((row) => row.content).map((row) => ({
      kind: 'clipboard' as const,
      id: row.id,
      content: row.content!.content,
      format: row.content!.format,
      syntaxVersion: row.content!.syntaxVersion,
    })),
  ];

  const summary = { scanned: 0, skipped: 0, written: 0, blocked: 0, failed: 0 };
  const blockers: { kind: string; id: string; codes: string[] }[] = [];

  for (const row of rows) {
    if (limit && summary.scanned >= limit) break;
    summary.scanned += 1;
    const format = parseContentFormat(row.format);
    if (!format) {
      summary.blocked += 1;
      blockers.push({ kind: row.kind, id: row.id, codes: ['invalid_content_format'] });
      continue;
    }
    const syntaxVersion = format === 'reactive' ? row.syntaxVersion ?? LOCAL_SYNTAX_VERSION : null;
    const contentVersion = reactiveContentVersion(format, syntaxVersion, row.content);
    const existing = await prisma.reactiveSnapshot.findUnique({
      where: {
        uq_reactive_snapshot_version: {
          kind: row.kind,
          contentId: row.id,
          contentVersion,
        },
      },
      select: { id: true },
    });
    if (existing) {
      summary.skipped += 1;
      continue;
    }

    const snapshot = await buildReactiveSnapshotForWrite({
      kind: row.kind,
      contentId: row.id,
      content: row.content,
      format,
    });
    if (!snapshot.ok) {
      summary.blocked += 1;
      blockers.push({ kind: row.kind, id: row.id, codes: snapshot.codes });
      continue;
    }
    if (!apply) continue;
    const { id, kind, contentId, contentVersion: version, ...update } = snapshot.row;
    await prisma.reactiveSnapshot.upsert({
      where: { uq_reactive_snapshot_version: { kind, contentId, contentVersion: version } },
      create: snapshot.row,
      update,
    });
    summary.written += 1;
  }

  console.log(JSON.stringify({ apply, limit: limit || null, summary, blockers }, null, 2));
  if (blockers.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
