import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { getCollection, getStory, resolvePath } from '@/lib/story-service';

afterEach(() => vi.restoreAllMocks());
it.each(['C:secret', 'article.md:stream', 'article%3Astream', '..', '%2e%2e', 'a/b', 'a\\b', '\0'])('路径段 %s 在读盘前拒绝', (segment) => {
  const reads = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  expect(getCollection([segment])).toBeNull();
  expect(getStory([segment])).toBeNull();
  expect(resolvePath([segment])).toEqual({ kind: 'notfound' });
  expect(reads).not.toHaveBeenCalled();
});
it('中文与普通故事名仍参与正常读盘', () => {
  const reads = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  resolvePath(['合集', '故事']);
  expect(reads).toHaveBeenCalled();
});
