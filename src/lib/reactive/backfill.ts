// ─────────────────────────────────────────────────────────────────────────────
// backfill.ts — 历史正文的编译快照回填（运维脚本与隔离测试共用）
//
// 统一管线后 Markdown 也走编译。历史 Markdown 没有快照时，读取路径会现编译
// （有 LRU，但冷启动 / 多实例仍会付成本）。发布前在停写窗口回填，把冷编译
// 移出用户请求路径。
//
// 三条纪律：
//   · 默认 dry-run：只读、不写；显式 `apply` 才写。
//   · 逐篇顺序执行、可中断重跑：已有同内容版本快照的行直接跳过（幂等）。
//   · Reactive 旧语法版本（含 `syntaxVersion = null`）先阻塞，不在这里擅自
//     生成“当前版本”的快照 —— 必须先跑 `reactive:migrate-v07`。否则库里会
//     出现一条标着当前版本、正文却还是旧语法的快照。
//
// 报告只有 ID / 类别 / 状态 / 诊断码，不含正文 / 标题 / 作者。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import { parseContentFormat } from '../content-format';
import { buildReactiveSnapshotForWrite } from './publish';
import { reactiveContentVersion } from './snapshot-store';

export type BackfillKind = 'blog' | 'clipboard';

export interface BackfillBlocker {
  kind: string;
  id: string;
  codes: string[];
}

export interface BackfillSummary {
  scanned: number;
  skipped: number;
  written: number;
  blocked: number;
  failed: number;
}

export interface BackfillResult {
  apply: boolean;
  limit: number | null;
  summary: BackfillSummary;
  blockers: BackfillBlocker[];
}

export interface BackfillOptions {
  /** 默认 false（dry-run）。 */
  apply?: boolean;
  /** 只处理前 N 行（试跑）。 */
  limit?: number;
}

interface Row {
  kind: BackfillKind;
  id: string;
  content: string;
  format: string;
  syntaxVersion: string | null;
}

/**
 * 回填缺失的编译快照。
 *
 * 调用方负责传入目标库的 Prisma client；不要在业务库上直接跑 `apply`。
 */
export async function backfillSnapshots(
  db: PrismaClient,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const apply = options.apply === true;
  const limit = options.limit ?? 0;

  const [blogs, clips] = await Promise.all([
    db.blog.findMany({
      where: { ignore: false },
      select: { id: true, content: { select: { content: true, format: true, syntaxVersion: true } } },
    }),
    db.clipBoard.findMany({
      where: { ignore: false },
      select: { id: true, content: { select: { content: true, format: true, syntaxVersion: true } } },
    }),
  ]);

  const rows: Row[] = [
    ...blogs
      .filter((row) => row.content)
      .map((row) => ({
        kind: 'blog' as const,
        id: row.id,
        content: row.content!.content,
        format: row.content!.format,
        syntaxVersion: row.content!.syntaxVersion,
      })),
    ...clips
      .filter((row) => row.content)
      .map((row) => ({
        kind: 'clipboard' as const,
        id: row.id,
        content: row.content!.content,
        format: row.content!.format,
        syntaxVersion: row.content!.syntaxVersion,
      })),
  ];

  const summary: BackfillSummary = { scanned: 0, skipped: 0, written: 0, blocked: 0, failed: 0 };
  const blockers: BackfillBlocker[] = [];

  for (const row of rows) {
    if (limit && summary.scanned >= limit) break;
    summary.scanned += 1;

    const format = parseContentFormat(row.format);
    if (!format) {
      summary.blocked += 1;
      blockers.push({ kind: row.kind, id: row.id, codes: ['invalid_content_format'] });
      continue;
    }
    // 旧语法版本不能在这里打当前版本快照：先跑 reactive:migrate-v07。
    if (format === 'reactive' && row.syntaxVersion !== LOCAL_SYNTAX_VERSION) {
      summary.blocked += 1;
      blockers.push({ kind: row.kind, id: row.id, codes: ['site.backfill.legacy-syntax'] });
      continue;
    }

    const syntaxVersion = format === 'reactive' ? LOCAL_SYNTAX_VERSION : null;
    const contentVersion = reactiveContentVersion(format, syntaxVersion, row.content);
    const existing = await db.reactiveSnapshot.findUnique({
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

    let snapshot: Awaited<ReturnType<typeof buildReactiveSnapshotForWrite>>;
    try {
      snapshot = await buildReactiveSnapshotForWrite({
        kind: row.kind,
        contentId: row.id,
        content: row.content,
        format,
      });
    } catch (error) {
      summary.failed += 1;
      blockers.push({
        kind: row.kind,
        id: row.id,
        codes: [`site.backfill.${error instanceof Error ? error.name || 'Error' : 'UnknownError'}`],
      });
      continue;
    }
    if (!snapshot.ok) {
      summary.blocked += 1;
      blockers.push({ kind: row.kind, id: row.id, codes: snapshot.codes });
      continue;
    }
    if (!apply) continue;

    const { kind, contentId, contentVersion: version, ...update } = snapshot.row;
    await db.reactiveSnapshot.upsert({
      where: { uq_reactive_snapshot_version: { kind, contentId, contentVersion: version } },
      create: snapshot.row,
      update,
    });
    summary.written += 1;
  }

  return { apply, limit: limit || null, summary, blockers };
}
