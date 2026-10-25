import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clip: vi.fn(), vote: vi.fn(), favorite: vi.fn() }));
vi.mock('@/lib/clipboard-service', () => ({ getClip: mocks.clip }));
vi.mock('@/lib/vote-service', () => ({ getVoteDetail: mocks.vote }));
vi.mock('@/lib/favorite-service', () => ({ getPublicFavorite: mocks.favorite }));
vi.mock('@/lib/auth', () => ({
  isCoreUser: (v: { role: string; archivedAt?: unknown } | null) => !!v && !v.archivedAt && ['core', 'admin', 'owner'].includes(v.role),
  isOwner: (v: { role: string; archivedAt?: unknown } | null) => !!v && !v.archivedAt && v.role === 'owner',
}));
import { createServiceReferenceReader } from '@/lib/reactive/ref-reader';
import type { ReferenceKind } from '@/lib/reactive/ref-types';

const slot = (kind: ReferenceKind, ref: string) => ({ kind, ref, token: `[@${ref}]`, start: 0, end: ref.length + 3 });
beforeEach(() => vi.clearAllMocks());

describe('request-scoped reference permissions', () => {
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
    expect(mocks.clip).toHaveBeenCalledWith('AbCd1234', undefined, false);
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
