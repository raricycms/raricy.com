// ─────────────────────────────────────────────────────────────────────────────
// reactive-backfill.test.ts —— 历史快照回填的隔离库回归
//
// 线上发布前会对业务库跑 `reactive:backfill`；这里在本测试库里钉住：
//   · 默认 dry-run 不写；`apply` 才写，重复执行幂等（可中断重跑）；
//   · Markdown 与当前版本 Reactive 都补；
//   · Reactive 旧语法版本（含 null）先阻塞，绝不生成“当前版本”快照。
// 报告只含 ID / 类别 / 诊断码 —— 断言不泄露正文。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import { createBlog } from '@/lib/blog-service';
import { createClip } from '@/lib/clipboard-service';
import { backfillSnapshots } from '@/lib/reactive/backfill';

const SECRET = '正文不得出现在回填报告里';

beforeEach(async () => {
  await resetDb();
  await prisma.reactiveSnapshot.deleteMany();
});

async function sources() {
  const user = await makeUser();
  const blogId = await createBlog(user.id, {
    title: '回填博客',
    content: `${SECRET}\n\n普通 Markdown`,
    description: '',
    visibility: 'internal',
    categoryId: null,
  });
  const clip = await createClip(user.id, {
    title: '回填剪贴板',
    content: `${SECRET}\n\n普通 Markdown`,
  });
  if (!clip.ok) throw new Error('clip fixture failed');
  // 发布路径自己会写快照；回填测试要从「历史正文没有快照」起跑。
  await prisma.reactiveSnapshot.deleteMany();
  return { user, blogId, clipId: clip.id };
}

describe('backfillSnapshots', () => {
  it('默认 dry-run 不写；apply 写入后可重复执行（幂等）', async () => {
    const { blogId, clipId } = await sources();
    expect(await prisma.reactiveSnapshot.count()).toBe(0);

    const dry = await backfillSnapshots(prisma, {});
    expect(dry.apply).toBe(false);
    expect(dry.summary).toEqual({ scanned: 2, skipped: 0, written: 0, blocked: 0, failed: 0 });
    expect(await prisma.reactiveSnapshot.count()).toBe(0);
    expect(JSON.stringify(dry)).not.toContain(SECRET);

    const first = await backfillSnapshots(prisma, { apply: true });
    expect(first.summary).toEqual({ scanned: 2, skipped: 0, written: 2, blocked: 0, failed: 0 });
    expect(await prisma.reactiveSnapshot.count()).toBe(2);
    const rows = await prisma.reactiveSnapshot.findMany({ where: { contentId: { in: [blogId, clipId] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.format === 'markdown')).toBe(true);

    const second = await backfillSnapshots(prisma, { apply: true });
    expect(second.summary).toEqual({ scanned: 2, skipped: 2, written: 0, blocked: 0, failed: 0 });
    expect(await prisma.reactiveSnapshot.count()).toBe(2);
  });

  it('Reactive 旧语法版本（含 null）先阻塞，不生成当前版本快照', async () => {
    const user = await makeUser();
    const clip = await createClip(user.id, {
      title: '旧版本',
      content: '<panel title="x">可见</panel>',
      format: 'reactive',
    });
    if (!clip.ok) throw new Error('clip fixture failed');
    await prisma.reactiveSnapshot.deleteMany();
    await prisma.clipText.update({
      where: { clipId: clip.id },
      data: { syntaxVersion: 'local-draft-2' },
    });

    const legacy = await backfillSnapshots(prisma, { apply: true });
    expect(legacy.summary.blocked).toBe(1);
    expect(legacy.blockers).toEqual([
      { kind: 'clipboard', id: clip.id, codes: ['site.backfill.legacy-syntax'] },
    ]);
    expect(await prisma.reactiveSnapshot.count()).toBe(0);

    await prisma.clipText.update({ where: { clipId: clip.id }, data: { syntaxVersion: null } });
    const missingVersion = await backfillSnapshots(prisma, { apply: true });
    expect(missingVersion.summary.blocked).toBe(1);
    expect(await prisma.reactiveSnapshot.count()).toBe(0);
  });

  it('--limit 只处理前 N 行', async () => {
    await sources();
    const limited = await backfillSnapshots(prisma, { apply: true, limit: 1 });
    expect(limited.summary.scanned).toBe(1);
    expect(limited.summary.written).toBe(1);
    expect(await prisma.reactiveSnapshot.count()).toBe(1);
  });
});
