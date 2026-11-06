import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import { createBlog, updateBlog } from '@/lib/blog-service';
import { createClip, updateClip } from '@/lib/clipboard-service';
import { resolveReadRender } from '@/lib/reactive/read-render';
import { sourceForCurrentCompiler } from '@/lib/reactive/source-migration';
import { resetReactiveCompileCacheForTests } from '@/lib/reactive/compile';

beforeEach(async () => { await resetDb(); resetReactiveCompileCacheForTests(); });
afterEach(() => vi.restoreAllMocks());

const source = '<radio-group bind="pace" label="节奏" initial="guided">\n<option value="guided">跟随</option>\n<option value="free">自由</option>\n</radio-group>';

describe('仅源码保存与按需渲染', () => {
  it('博客和剪贴板创建、更新、冷读取都不落快照（快照表已随 R3-018 退役）', async () => {
    const user = await makeUser();
    const data = { title: '源码文章', description: '', content: source, categoryId: null, visibility: 'internal' as const, format: 'reactive' as const };
    const blogId = await createBlog(user.id, data);
    const clip = await createClip(user.id, { title: '源码片段', content: source, format: 'reactive' });
    if (!clip.ok) throw new Error(clip.reason);
    const edited = source + '\n\n修改后的正文';
    expect((await updateBlog(blogId, { ...data, content: edited }, user.id)).error).toBeUndefined();
    expect((await updateClip(clip.id, user.id, { title: '源码片段', content: edited, publicity: true, format: 'reactive' })).ok).toBe(true);
    resetReactiveCompileCacheForTests();
    // 博客与剪贴板两条写入路径都只落源码；阅读时按当前源码编译出同一份文档。
    const result = await resolveReadRender({ source: edited, format: 'reactive', viewer: user, mode: 'expand' });
    expect(result.bundle?.result.ok).toBe(true);
    if (result.bundle?.result.ok) expect(result.bundle.result.document.bindings.pace).toBeDefined();
  });

  it('draft-2 在冷读时临时适配，存储原文和版本保持不变', async () => {
    const user = await makeUser();
    const id = await createBlog(user.id, { title: '旧文', description: '', content: '初始', visibility: 'internal', categoryId: null });
    const old = '<!-- reactive-md: local-draft-2 -->\n\n' + source;
    await prisma.blogContent.update({ where: { blogId: id }, data: { content: old, format: 'reactive', syntaxVersion: 'local-draft-2' } });
    const rendered = await resolveReadRender({ source: old, format: 'reactive', syntaxVersion: 'local-draft-2', viewer: user, mode: 'expand' });
    expect(rendered.bundle?.result.ok).toBe(true);
    expect(await prisma.blogContent.findUniqueOrThrow({ where: { blogId: id } })).toMatchObject({ content: old, syntaxVersion: 'local-draft-2' });
  });

  it('不安全旧修订的保存返回语法错误，不抛服务异常', async () => {
    const user = await makeUser();
    const result = await createClip(user.id, { title: '旧约束', format: 'reactive', content: '<!-- reactive-md: local-draft-2 -->\n<number bind="limit" initial="2">\n<number bind="n" initial="1" min="{{ limit }}">' });
    expect(result).toEqual({ ok: false, reason: 'reactive_invalid' });
  });

  it('隐式旧修订也不允许静默激活动态约束', () => {
    const unsafe = '<number bind="limit" initial="2">\n<number bind="n" initial="1" min="{{ limit }}">';
    expect(() => sourceForCurrentCompiler(unsafe, 'local-draft-2')).toThrow();
    expect(() => sourceForCurrentCompiler(source, 'unknown')).toThrow();
    expect(() => sourceForCurrentCompiler('<!-- reactive-md: local-draft-2 -->\n' + source, 'local-draft-3')).toThrow();
  });
});
