import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import { createBlog } from '@/lib/blog-service';
import { createClip } from '@/lib/clipboard-service';
import { applyReactiveV07Migration, planReactiveV07Migration } from '@/lib/reactive/migrate-v07';
import { runAsBackendOps } from '@/lib/audit-context';
import { nowForDb } from '@/lib/db-time';

beforeEach(async () => {
  await resetDb();
  await prisma.reactiveSourceMigration.deleteMany();
});

async function oldSources() {
  const user = await makeUser();
  const blogId = await createBlog(user.id, { title: '旧博客', content: '初始', description: '', visibility: 'internal', categoryId: null });
  const clip = await createClip(user.id, { title: '旧剪贴板', content: '初始' });
  if (!clip.ok) throw new Error('clip fixture failed');
  await prisma.blogContent.update({ where: { blogId }, data: { format: 'reactive', syntaxVersion: 'local-draft-2', content: '<!-- reactive-md: local-draft-2 -->\n\n旧博客正文' } });
  await prisma.clipText.update({ where: { clipId: clip.id }, data: { format: 'reactive', syntaxVersion: 'local-draft-2', content: '旧剪贴板正文' } });
  return { user, blogId, clipId: clip.id };
}

describe('ReactiveMD 0.7 正文迁移', () => {
  it('示例的 radio-group 在博客和剪贴板迁移后仍保留选项，当前版本复检不误阻塞', async () => {
    const { blogId, clipId } = await oldSources();
    const source = [
      '<!-- reactive-md: local-draft-2 -->', '',
      '<radio-group bind="pace" label="节奏" initial="guided">',
      '<option value="guided">跟随</option>',
      '<option value="free">自由</option>',
      '</radio-group>',
    ].join('\n');
    await prisma.blogContent.update({ where: { blogId }, data: { content: source } });
    await prisma.clipText.update({ where: { clipId }, data: { content: source } });
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual([]);
    expect(plan.rows).toHaveLength(2);
    await applyReactiveV07Migration(plan);
    expect(await prisma.reactiveSnapshot.count({ where: { contentId: { in: [blogId, clipId] }, format: 'reactive' } })).toBe(2);
    const current = await planReactiveV07Migration();
    expect(current.alreadyApplied).toBe(true);
    expect(current.blockers).toEqual([]);
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId } })).content).toContain('<option value="guided">跟随</option>');
    expect((await prisma.clipText.findUniqueOrThrow({ where: { clipId } })).content).toContain('<option value="free">自由</option>');
  });

  it('同时迁移显式和隐式旧版本，生成同版本快照且只执行一次', async () => {
    const { blogId, clipId } = await oldSources();
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual([]);
    expect(plan.rows).toHaveLength(2);
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId } })).syntaxVersion).toBe('local-draft-2');
    await applyReactiveV07Migration(plan);
    const blog = await prisma.blogContent.findUniqueOrThrow({ where: { blogId } });
    const clip = await prisma.clipText.findUniqueOrThrow({ where: { clipId } });
    expect(blog.content).toBe('<!-- reactive-md: local-draft-3 -->\n\n旧博客正文');
    expect(clip.content).toContain('<!-- reactive-md: local-draft-3 -->');
    expect([blog.syntaxVersion, clip.syntaxVersion]).toEqual(['local-draft-3', 'local-draft-3']);
    const snapshots = await prisma.reactiveSnapshot.findMany({ where: { contentId: { in: [blogId, clipId] }, format: 'reactive' } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((row) => row.syntaxVersion === 'local-draft-3' && row.compilerVersion === 'reactive-md/0.7.0')).toBe(true);
    expect((await planReactiveV07Migration()).alreadyApplied).toBe(true);
    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('already applied');
  });

  it('含新激活标签或未知语法版本时整批停止', async () => {
    const { blogId, clipId } = await oldSources();
    await prisma.clipText.update({ where: { clipId }, data: { content: '<external name="foo" type="number">' } });
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: clipId, codes: expect.arrayContaining(['local.upgrade.tag']) })]));
    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('blocked');
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId } })).syntaxVersion).toBe('local-draft-2');
    expect(await prisma.reactiveSourceMigration.count()).toBe(0);
    await prisma.clipText.update({ where: { clipId }, data: { syntaxVersion: null } });
    expect((await planReactiveV07Migration()).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: clipId, codes: ['site.migration.unknown-syntax'] })]));
  });

  it('准备完成后正文发生变化时回滚整批写入', async () => {
    const { blogId, clipId } = await oldSources();
    const plan = await planReactiveV07Migration();
    await prisma.clipText.update({ where: { clipId }, data: { content: '并发修改' } });
    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('Source changed');
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId } })).syntaxVersion).toBe('local-draft-2');
    expect(await prisma.reactiveSnapshot.count({ where: { contentId: blogId, format: 'reactive' } })).toBe(0);
    expect(await prisma.reactiveSourceMigration.count()).toBe(0);
  });

  it('长文：站点预算内、上游默认预算外，仍能完整迁移并生成快照', async () => {
    const user = await makeUser();
    const blogId = await createBlog(user.id, {
      title: '长文', content: '初始', description: '', visibility: 'internal', categoryId: null,
    });
    const longSource = `<!-- reactive-md: local-draft-2 -->\n\n${Array.from(
      { length: 6000 },
      (_, index) => `第 ${index} 段`
    ).join('\n\n')}`;
    await prisma.blogContent.update({
      where: { blogId },
      data: { format: 'reactive', syntaxVersion: 'local-draft-2', content: longSource },
    });

    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual([]);
    expect(plan.rows).toHaveLength(1);
    await applyReactiveV07Migration(plan);
    const row = await prisma.blogContent.findUniqueOrThrow({ where: { blogId } });
    expect(row.syntaxVersion).toBe('local-draft-3');
    expect(row.content).toContain('<!-- reactive-md: local-draft-3 -->');
    expect(await prisma.reactiveSnapshot.count({ where: { kind: 'blog', contentId: blogId, format: 'reactive' } })).toBe(1);
  });

  it('空库也能完成一次性标记，重复应用被拒', async () => {
    const plan = await planReactiveV07Migration();
    expect(plan).toMatchObject({ alreadyApplied: false, rows: [], blockers: [] });
    await applyReactiveV07Migration(plan);
    expect(await prisma.reactiveSourceMigration.count()).toBe(1);
    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('already applied');
  });

  it('准备之后新出现的旧版本行会让整批回滚', async () => {
    const { blogId } = await oldSources();
    const plan = await planReactiveV07Migration();
    const user = await makeUser();
    const clip = await createClip(user.id, { title: '后新增', content: '后新增正文' });
    if (!clip.ok) throw new Error('clip fixture failed');
    await prisma.clipText.update({
      where: { clipId: clip.id },
      data: { format: 'reactive', syntaxVersion: 'local-draft-2', content: '后新增 reactive' },
    });

    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('Unmigrated reactive source');
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId } })).syntaxVersion).toBe('local-draft-2');
    expect(await prisma.reactiveSourceMigration.count()).toBe(0);
  });

  it('draft-2 的动态约束即使短文档也整批阻塞', async () => {
    const { clipId } = await oldSources();
    await prisma.clipText.update({
      where: { clipId },
      data: {
        content: `<!-- reactive-md: local-draft-2 -->

<number bind="b" label="B" initial="5" min="{{ b }}" max="10">`,
      },
    });
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: clipId, codes: expect.arrayContaining(['site.migration.dynamic-constraint']) }),
      ])
    );
    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('blocked');
    expect((await prisma.clipText.findUniqueOrThrow({ where: { clipId } })).syntaxVersion).toBe('local-draft-2');
  });

  it('列已是当前版本但正文仍声明旧版本时阻塞（一次性标记不能掩盖）', async () => {
    const { blogId } = await oldSources();
    await prisma.blogContent.update({
      where: { blogId },
      data: {
        syntaxVersion: 'local-draft-3',
        content: `<!-- reactive-md: local-draft-2 -->

旧正文`,
      },
    });
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: blogId, codes: expect.arrayContaining(['site.migration.stale-declaration']) }),
      ])
    );
    await expect(applyReactiveV07Migration(plan)).rejects.toThrow('blocked');
    expect(await prisma.reactiveSourceMigration.count()).toBe(0);
  });

  it('当前版本行的正文深处残留旧声明也会阻塞', async () => {
    const { blogId } = await oldSources();
    await prisma.blogContent.update({
      where: { blogId },
      data: {
        syntaxVersion: 'local-draft-3',
        content: `<panel title="x">正文</panel>

<!-- reactive-md: local-draft-2 -->

尾部`,
      },
    });
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: blogId, codes: expect.arrayContaining(['site.migration.stale-declaration']) }),
      ])
    );
  });

  it('当前版本行正文不可编译也会阻塞（一次性标记不能掩盖）', async () => {
    const { blogId } = await oldSources();
    await prisma.blogContent.update({
      where: { blogId },
      data: { syntaxVersion: 'local-draft-3', content: '<panel title="未闭合">' },
    });
    const plan = await planReactiveV07Migration();
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: blogId, codes: expect.arrayContaining(['site.migration.current-invalid']) }),
      ])
    );
  });

  it('后台迁移也覆盖归档作者的文章', async () => {
    const { user, blogId } = await oldSources();
    await prisma.user.update({ where: { id: user.id }, data: { archivedAt: nowForDb() } });
    const plan = await planReactiveV07Migration();
    expect(plan.rows.map((row) => row.id)).toContain(blogId);
    await applyReactiveV07Migration(plan);
    const blog = await runAsBackendOps(() => prisma.blogContent.findUniqueOrThrow({ where: { blogId } }));
    expect(blog.syntaxVersion).toBe('local-draft-3');
  });
});
