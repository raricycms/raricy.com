import { describe, it, expect, vi } from 'vitest';
import { resolvePublicClipRefs } from '@/lib/clipboard-service';
import { prisma } from '../helpers/db';

describe('访客剪贴板边界', () => {
  it('任意 token 均不查询资源、不下发正文或元数据', async () => {
    const read = vi.spyOn(prisma.clipBoard, 'findUnique');
    try {
      expect(await resolvePublicClipRefs('[@AbCd1234] [@missing0] [@deleted0]')).toEqual({});
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
});
