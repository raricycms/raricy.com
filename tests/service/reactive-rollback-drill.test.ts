// ─────────────────────────────────────────────────────────────────────────────
// reactive-rollback-drill.test.ts —— 代码 + SQLite 成对回滚的隔离演练
//
// 只在本进程的测试库（tests/.tmp/test-*.db）上做：
//   1. 造一条 local-draft-2 正文，做一致备份（WAL checkpoint 后拷文件）；
//   2. 跑完整迁移（正文 + 快照 + 一次性标记）；
//   3. 按发布演练的还原步骤把数据库文件换回备份；
//   4. 断言库里回到迁移前：旧正文 / 旧语法版本 / 没有标记 / 没有多出来的快照。
//
// 这证明「只回滚代码、不回滚数据」之外的另一半：数据文件本身可恢复。
// 生产演练还要求把代码恢复到同一时点（见 docs/deploy.md「回滚」）。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { makeUser, prisma, resetDb } from '../helpers/db';
import { createBlog } from '@/lib/blog-service';
import { applyReactiveV07Migration, planReactiveV07Migration } from '@/lib/reactive/migrate-v07';

const OLD = '<!-- reactive-md: local-draft-2 -->\n\n旧正文';

function databaseFile(): string {
  const url = process.env.DATABASE_URL ?? '';
  const file = url.replace(/^file:/, '').split('?')[0];
  if (!file.replace(/\\/g, '/').includes('tests/.tmp/test-')) {
    throw new Error(`拒绝在非测试库上演练：${url}`);
  }
  return file;
}

let backup: string | null = null;

beforeEach(async () => {
  await resetDb();
  await prisma.reactiveSourceMigration.deleteMany();
});

afterEach(async () => {
  if (backup && fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  backup = null;
});

describe('代码 + SQLite 成对回滚演练', () => {
  it('迁移后还原数据库备份，正文 / 版本 / 标记 / 快照都回到迁移前', async () => {
    const user = await makeUser();
    const blogId = await createBlog(user.id, {
      title: '回滚演练',
      content: '初始',
      description: '',
      visibility: 'internal',
      categoryId: null,
    });
    await prisma.blogContent.update({
      where: { blogId },
      data: { format: 'reactive', syntaxVersion: 'local-draft-2', content: OLD },
    });
    await prisma.reactiveSnapshot.deleteMany();
    const beforeCounts = {
      snapshots: await prisma.reactiveSnapshot.count(),
      markers: await prisma.reactiveSourceMigration.count(),
    };

    const file = databaseFile();
    // WAL 一致性：先把 WAL 并进主文件，再拷一份“停写后”的备份。
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    await prisma.$disconnect();
    backup = `${file}.rollback-drill-${process.pid}.bak`;
    fs.copyFileSync(file, backup);
    await prisma.$connect();

    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual([]);
    await applyReactiveV07Migration(plan);
    const migrated = await prisma.blogContent.findUniqueOrThrow({ where: { blogId } });
    expect(migrated.syntaxVersion).toBe('local-draft-3');
    expect(migrated.content).toContain('local-draft-3');
    expect(await prisma.reactiveSourceMigration.count()).toBe(beforeCounts.markers + 1);
    const migratedSnapshots = await prisma.reactiveSnapshot.count();
    expect(migratedSnapshots).toBeGreaterThan(beforeCounts.snapshots);

    // 还原：断开连接 → 换回主文件并清掉 WAL/SHM → 重连。
    await prisma.$disconnect();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    fs.copyFileSync(backup, file);
    await prisma.$connect();

    const restored = await prisma.blogContent.findUniqueOrThrow({ where: { blogId } });
    expect(restored.content).toBe(OLD);
    expect(restored.syntaxVersion).toBe('local-draft-2');
    expect(await prisma.reactiveSourceMigration.count()).toBe(beforeCounts.markers);
    expect(await prisma.reactiveSnapshot.count()).toBe(beforeCounts.snapshots);
  }, 60_000);
});
