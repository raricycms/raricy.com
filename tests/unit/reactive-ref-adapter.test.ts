import { describe, expect, it, vi } from 'vitest';
import type { LocalNode } from 'reactive-md';
import { compileSource } from '@/lib/reactive/compile-source';
import { expandDocumentReferences, prepareInlineMarkdownDocument } from '@/lib/reactive/ref-adapter';
import type { ReferenceSlot } from '@/lib/reactive/ref-types';

function compile(source: string) {
  const result = compileSource(source);
  if (!result.ok) throw new Error(result.diagnostics.map(({ code }) => code).join(', '));
  return result.document;
}

const flatten = (nodes: LocalNode[]): LocalNode[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);

describe('编译后展开站内引用', () => {
  it('展开五种引用，块卡片与正文分开，并保留原 AST', async () => {
    const original = compile('前文 **[@AbCd1234] 后文** [@1234567890]\n\n[@AbCdEf123] [@123456] [@音频/abcdefghij]');
    const before = JSON.stringify(original);
    const resolve = vi.fn(async () => ({ status: 'ready' as const, title: '站内资源' }));
    const { document, hostData } = await expandDocumentReferences(original, { mode: 'expand', resolve });
    expect(JSON.stringify(original)).toBe(before);
    expect(document.nodes.slice(0, 3).map(({ type }) => type)).toEqual(['paragraph', 'hostComponent', 'paragraph']);
    expect(flatten(document.nodes)).toContainEqual(expect.objectContaining({
      type: 'image', url: '/api/images/1234567890/raw',
    }));
    expect(Object.keys(hostData)).toEqual(['clipboard:AbCd1234', 'vote:AbCdEf123', 'favorite:123456', 'audio:abcdefghij']);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('访客不取成员资源，代码、链接和伪造宿主标签不触发取数', async () => {
    const examples = '\x60[@AbCd1234]\x60\n\n[@AbCd1234](https://example.com)\n\n<site-embed kind="clipboard" ref="AbCd1234" />';
    const original = compile('[@AbCd1234] [@AbCdEf123] [@123456]\n\n' + examples);
    const resolve = vi.fn();
    const { document, hostData } = await expandDocumentReferences(original, { mode: 'external', resolve });
    expect(document).toEqual(original);
    expect(hostData).toEqual({});
    await expandDocumentReferences(compile(examples), { mode: 'expand', resolve });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('同一成员引用只取一次，Markdown 子剪贴板只内联一层', async () => {
    const original = compile('[@AbCd1234] [@AbCd1234]');
    const resolve = vi.fn(async () => ({
      status: 'ready' as const, format: 'markdown' as const, content: '子正文 [@AbCd5678] [@1234567890]',
    }));
    const { document, hostData } = await expandDocumentReferences(original, { mode: 'expand', resolve });
    expect(document.nodes.filter(({ type }) => type === 'hostComponent')).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(1);
    const clip = hostData['clipboard:AbCd1234'];
    expect(clip.content).toBeUndefined();
    expect(clip.hostData).toEqual({});
    expect(JSON.stringify(clip.document?.nodes)).toContain('[@AbCd5678]');
    expect(JSON.stringify(clip.document?.nodes)).toContain('/api/images/1234567890/raw');
  });

  it('资源缺失时保留字面量，声音和收藏夹分别限制展开数', async () => {
    const original = compile('[@AbCd1234] ' + '[@音频/abcdefghij] [@123456] '.repeat(5));
    const resolve = vi.fn(async ({ kind }: ReferenceSlot) => kind === 'favorite' ? { status: 'ready' as const } : undefined);
    const { document } = await expandDocumentReferences(original, { mode: 'expand', resolve });
    const embeds = document.nodes.filter(({ type }) => type === 'hostComponent');
    expect(embeds.filter(({ attrs }) => attrs?.kind === 'audio')).toHaveLength(3);
    expect(embeds.filter(({ attrs }) => attrs?.kind === 'favorite')).toHaveLength(3);
    expect(JSON.stringify(document.nodes)).toContain('[@AbCd1234]');
  });

  it('无效子正文回退卡片，成功的子文档可复用', async () => {
    expect(await prepareInlineMarkdownDocument('{{ missing }}')).toBeNull();
    const first = await prepareInlineMarkdownDocument('子正文');
    expect(first?.document.nodes.length).toBeGreaterThan(0);
    expect(await prepareInlineMarkdownDocument('子正文')).toBe(first);
  });
});
