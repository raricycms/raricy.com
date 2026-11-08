import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clip: vi.fn(), vote: vi.fn(), favorite: vi.fn() }));
// 引用读取走只读查询模块（与写用例分开，见 clipboard-query.ts 文件头）。
vi.mock('@/lib/clipboard-query', () => ({ getClip: mocks.clip }));
vi.mock('@/lib/vote-service', () => ({ getVoteDetail: mocks.vote }));
vi.mock('@/lib/favorite-service', () => ({ getPublicFavorite: mocks.favorite }));
// R3-161：角色判据**不手抄**成 mock。用 importActual 保留 auth.ts 的真实实现
// （isCoreUser / isOwner 的「user < core < admin < owner」逐档包含关系），
// 只替换依赖 cookies() / 会话表的 getCurrentUser。
// 原先手写的 `['core','admin','owner'].includes(role)` 是 mock 里的第二份角色表 ——
// 真实包含关系变化（例如 core 被摘掉）时用例仍绿，权限真值从没被验证。
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => null };
});
import { createServiceReferenceReader } from '@/lib/reactive/ref-reader';
import { prepareReactiveDocument } from '@/lib/reactive/prepare';
import type { ReferenceKind } from '@/lib/reactive/ref-types';

const slot = (kind: ReferenceKind, ref: string) => ({ kind, ref, token: `[@${ref}]`, start: 0, end: ref.length + 3 });
beforeEach(() => vi.clearAllMocks());

describe('request-scoped reference permissions', () => {
  it('prepares external payloads without probing member resources', async () => {
    const source = '[@AbCd1234] [@AbCdEf123] [@123456]';
    const result = await prepareReactiveDocument(source, { mode: 'external', format: 'reactive', viewer: null });
    expect(result.hostData).toEqual({});
    expect(result.adaptedSource).toBe(source);
    expect(result.adaptedSource).toContain('[@AbCdEf123]');
    // 同一输入再准备一次，适配产出必须一致（快照/哈希机制已退出，见 R3-106）。
    const again = await prepareReactiveDocument(source, { mode: 'external', format: 'reactive', viewer: null });
    expect(again.adaptedSource).toBe(result.adaptedSource);
    expect(mocks.clip).not.toHaveBeenCalled();
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(mocks.favorite).not.toHaveBeenCalled();
  });
  it('does not bypass the core gate for any member reference', async () => {
    for (const viewer of [null, { id: 'u', role: 'user' }]) {
      const read = createServiceReferenceReader('expand', viewer);
      expect(await read(slot('vote', 'AbCdEf123'))).toEqual({ status: 'forbidden' });
      expect(await read(slot('clipboard', 'AbCd1234'))).toEqual({ status: 'forbidden' });
    }
    expect(mocks.clip).not.toHaveBeenCalled();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
  it('external reads only public clips and never probes votes or favorites', async () => {
    const read = createServiceReferenceReader('external', { id: 'owner', role: 'owner' });
    expect(await read(slot('vote', 'AbCdEf123'))).toBeUndefined();
    expect(await read(slot('favorite', '123456'))).toBeUndefined();
    mocks.clip.mockResolvedValue({ ok: false, reason: 'forbidden' });
    expect(await read(slot('clipboard', 'AbCd1234'))).toBeUndefined();
    expect(mocks.clip).not.toHaveBeenCalled();
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(mocks.favorite).not.toHaveBeenCalled();
  });
  it('passes member identity, preserves format and turns failures into local states', async () => {
    const read = createServiceReferenceReader('expand', { id: 'owner', role: 'owner' });
    mocks.clip.mockResolvedValue({ ok: true, clip: { title: 'Example', content: '{{secret}}', format: 'reactive', publicity: false } });
    expect(await read(slot('clipboard', 'AbCd1234'))).toMatchObject({ status: 'ready', format: 'reactive' });
    expect(mocks.clip).toHaveBeenCalledWith('AbCd1234', 'owner', true);
    mocks.vote.mockRejectedValue(new Error('private database error'));
    expect(await read(slot('vote', 'AbCdEf123'))).toEqual({ status: 'error' });
  });
});

// R3-161 的「mock 不得自带第二份角色表」不再单独成组（R4）：上面那条 importActual 写法
// 已经让角色判定直接落在 auth.ts 的真实实现上，而「user < core < admin < owner 逐档包含
// 关系 + archivedAt」的真实角色矩阵在 tests/unit/auth-roles.test.ts:12-72 全量覆盖 ——
// 那条断言「mock 里的函数就是实际导出的函数」只是在测测试自己的 mock（§3A 自指断言）。
