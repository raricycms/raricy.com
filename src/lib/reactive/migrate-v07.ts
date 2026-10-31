import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import { prisma } from '../db';
import {
  findDynamicConstraintActivations,
  findStaleVersionDeclaration,
  migrateLocalSourceWithSiteBudget,
} from './source-migration';
import { isoWithOffset, nowForDb } from '../db-time';
import { runAsBackendOps } from '../audit-context';
import { buildReactiveSnapshotForWrite } from './publish';
import type { ReactiveSnapshotRow, SnapshotKind } from './snapshot-store';

const MIGRATION_NAME = 'reactive-md-local-draft-3';
const OLD_SYNTAX = 'local-draft-2';

interface SourceRow {
  kind: SnapshotKind;
  id: string;
  source: string;
  syntaxVersion: string | null;
}

interface PreparedRow extends SourceRow {
  migratedSource: string;
  snapshot: ReactiveSnapshotRow;
}

export interface MigrationBlocker {
  kind: SnapshotKind;
  id: string;
  codes: string[];
}

export interface ReactiveV07Plan {
  alreadyApplied: boolean;
  rows: PreparedRow[];
  blockers: MigrationBlocker[];
}

/** 只读取并编译：不写正文、不输出正文；所有文章通过后才能提交。 */
export async function planReactiveV07Migration(): Promise<ReactiveV07Plan> {
  return runAsBackendOps(async () => {
    const alreadyApplied = !!(await prisma.reactiveSourceMigration.findUnique({ where: { name: MIGRATION_NAME } }));
    const [blogs, clips] = await Promise.all([
      prisma.blogContent.findMany({ where: { format: 'reactive' }, select: { blogId: true, content: true, syntaxVersion: true } }),
      prisma.clipText.findMany({ where: { format: 'reactive' }, select: { clipId: true, content: true, syntaxVersion: true } }),
    ]);
    const sources: SourceRow[] = [
      ...blogs.map((row) => ({ kind: 'blog' as const, id: row.blogId, source: row.content, syntaxVersion: row.syntaxVersion })),
      ...clips.map((row) => ({ kind: 'clipboard' as const, id: row.clipId, source: row.content, syntaxVersion: row.syntaxVersion })),
    ];
    const rows: PreparedRow[] = [];
    const blockers: MigrationBlocker[] = [];
    for (const item of sources) {
      if (item.syntaxVersion === LOCAL_SYNTAX_VERSION) {
        // 列已是当前版本，正文却仍声明旧版本：一次性标记不能掩盖它。
        const stale = findStaleVersionDeclaration(item.source);
        if (stale.length > 0) {
          blockers.push({ kind: item.kind, id: item.id, codes: stale.map((d) => d.code) });
        }
        continue;
      }
      if (alreadyApplied || item.syntaxVersion !== OLD_SYNTAX) {
        blockers.push({ kind: item.kind, id: item.id, codes: [alreadyApplied ? 'site.migration.legacy-after-completion' : 'site.migration.unknown-syntax'] });
        continue;
      }
      // 0.7.0 的 draft-3 还会让动态 min/max/required 从字面量变成约束。上游迁移器
      // 不检查这一类，站点必须在**所有** draft-2 行上做一次，短文档也不例外。
      const dynamic = findDynamicConstraintActivations(item.source);
      if (dynamic.length > 0) {
        blockers.push({ kind: item.kind, id: item.id, codes: dynamic.map((d) => d.code) });
        continue;
      }
      // 站点预算适配层：上游 migrateLocalSource 内置 10,000 节点预算，低于站点
      // 配置。只有「上游只因预算失败」时才按站点选项复核并继续；其余阻塞原样返回。
      const migrated = migrateLocalSourceWithSiteBudget(item.source, OLD_SYNTAX);
      if (!migrated.ok) {
        blockers.push({ kind: item.kind, id: item.id, codes: migrated.diagnostics.map((d) => d.code) });
        continue;
      }
      const snapshot = await buildReactiveSnapshotForWrite({ kind: item.kind, contentId: item.id, content: migrated.source, format: 'reactive' });
      if (!snapshot.ok) {
        blockers.push({ kind: item.kind, id: item.id, codes: snapshot.codes });
        continue;
      }
      rows.push({ ...item, migratedSource: migrated.source, snapshot: snapshot.row });
    }
    return { alreadyApplied, rows, blockers };
  });
}

/** 调用前须停写并备份数据库。正文、快照和一次性标记在同一事务提交。 */
export async function applyReactiveV07Migration(plan: ReactiveV07Plan): Promise<void> {
  if (plan.alreadyApplied || plan.blockers.length) throw new Error('Migration already applied or blocked');
  await runAsBackendOps(() => prisma.$transaction(async (tx) => {
    if (await tx.reactiveSourceMigration.findUnique({ where: { name: MIGRATION_NAME } })) {
      throw new Error('Migration already applied');
    }
    for (const row of plan.rows) {
      const predicate = { format: 'reactive', syntaxVersion: row.syntaxVersion, content: row.source };
      const updated = row.kind === 'blog'
        ? await tx.blogContent.updateMany({ where: { blogId: row.id, ...predicate }, data: { content: row.migratedSource, syntaxVersion: LOCAL_SYNTAX_VERSION } })
        : await tx.clipText.updateMany({ where: { clipId: row.id, ...predicate }, data: { content: row.migratedSource, syntaxVersion: LOCAL_SYNTAX_VERSION } });
      if (updated.count !== 1) throw new Error(`Source changed during migration: ${row.kind}:${row.id}`);
      const { id, kind, contentId, contentVersion, ...snapshotData } = row.snapshot;
      await tx.reactiveSnapshot.upsert({
        where: { uq_reactive_snapshot_version: { kind, contentId, contentVersion } },
        create: row.snapshot,
        update: snapshotData,
      });
    }
    // 捕获准备之后新增或被修改成旧版本的正文，避免留下未迁移的行。
    const old = { format: 'reactive', OR: [{ syntaxVersion: null }, { syntaxVersion: { not: LOCAL_SYNTAX_VERSION } }] };
    if (await tx.blogContent.findFirst({ where: old, select: { blogId: true } }) ||
        await tx.clipText.findFirst({ where: old, select: { clipId: true } })) {
      throw new Error('Unmigrated reactive source appeared during migration');
    }
    // 列已是当前版本、正文却仍声明旧版本的行同样不能留到标记之后。
    const [currentBlogs, currentClips] = await Promise.all([
      tx.blogContent.findMany({
        where: { format: 'reactive', syntaxVersion: LOCAL_SYNTAX_VERSION, content: { contains: 'reactive-md:' } },
        select: { blogId: true, content: true },
      }),
      tx.clipText.findMany({
        where: { format: 'reactive', syntaxVersion: LOCAL_SYNTAX_VERSION, content: { contains: 'reactive-md:' } },
        select: { clipId: true, content: true },
      }),
    ]);
    for (const row of currentBlogs) {
      if (findStaleVersionDeclaration(row.content).length > 0) {
        throw new Error(`Stale reactive source declaration: blog:${row.blogId}`);
      }
    }
    for (const row of currentClips) {
      if (findStaleVersionDeclaration(row.content).length > 0) {
        throw new Error(`Stale reactive source declaration: clipboard:${row.clipId}`);
      }
    }
    await tx.reactiveSourceMigration.create({ data: { name: MIGRATION_NAME, completedAt: isoWithOffset(nowForDb()) ?? '' } });
  }, { timeout: 120_000 }));
}
