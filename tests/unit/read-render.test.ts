import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/reactive/compile-content', () => ({ compileContent: vi.fn() }));
import { compileContent } from '@/lib/reactive/compile-content';
import { resolveReadRender, type ReadRenderInput } from '@/lib/reactive/read-render';
const compileMock = vi.mocked(compileContent);
afterEach(() => { vi.resetAllMocks(); });
const input: ReadRenderInput = { source: '正文', format: 'markdown', viewer: null, mode: 'external' };
function compiled(ok = true) {
  return { outcome: { result: ok ? { ok: true, document: { nodes: [] }, diagnostics: [] } : { ok: false, diagnostics: [{ code: 'local.structure.children' }] }, hostData: {}, compileMs: 3, cacheHit: false } } as never;
}
describe('按需渲染源码（reactive 是唯一正文渲染路径）', () => {
  it.each(['markdown', 'reactive'])('%s 源文都按当前编译器编译出可交互正文', async (format) => {
    compileMock.mockResolvedValue(compiled());
    const result = await resolveReadRender({ ...input, format });
    expect(result.choice.renderer).toBe('reactive');
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(result.bundle?.result.ok).toBe(true);
  });
  it('每次把当前查看者和引用权限交给编译入口', async () => {
    compileMock.mockResolvedValue(compiled());
    await resolveReadRender({ ...input, mode: 'expand', viewer: { id: 'alice' } });
    await resolveReadRender({ ...input, viewer: null });
    expect(compileMock.mock.calls[0][0]).toMatchObject({ mode: 'expand', viewer: { id: 'alice' } });
    expect(compileMock.mock.calls[1][0]).toMatchObject({ mode: 'external', viewer: null });
  });
  it('数据库里的语法版本传入解释入口，不改源文', async () => {
    compileMock.mockResolvedValue(compiled());
    await resolveReadRender({ ...input, format: 'reactive', syntaxVersion: 'local-draft-2' });
    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({ source: input.source, syntaxVersion: 'local-draft-2' }));
  });
  it('未知格式不读取或编译源码', async () => {
    expect((await resolveReadRender({ ...input, format: 'oops' })).failure).toBe('invalid-format');
    expect(compileMock).not.toHaveBeenCalled();
  });
  it('坏文章只返回 unavailable，不影响其它文章', async () => {
    compileMock.mockResolvedValueOnce(compiled(false)).mockResolvedValueOnce(compiled());
    const broken = await resolveReadRender({ ...input, format: 'reactive' });
    expect(broken.choice).toEqual({ renderer: 'unavailable', reason: 'compile' });
    expect(broken.failure).toBe('compile');
    expect((await resolveReadRender({ ...input, source: '另一篇' })).choice.renderer).toBe('reactive');
  });
  it('编译抛错只返回当前文档不可用', async () => {
    compileMock.mockRejectedValue(new Error('compile failed'));
    expect((await resolveReadRender(input)).failure).toBe('compile');
  });
});
