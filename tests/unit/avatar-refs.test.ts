// avatar-refs.ts —— 头像地址的唯一出处。
//
// 【为什么值得钉】这条模板串以前散在 15 处各写各的，而拼错的症状是**静默**的：
// `/api/avatar/[id]` 永不 404（读不到文件就按 id 生成 identicon），所以拼错的 id
// 只会得到「一张长得像头像、但不是那个人的 identicon」，没有任何报错。
// 收敛到一处之后，这条用例锁住它的形状；「全仓不许再出现别处的模板串」由
// tests/unit/avatar-sites-guard.test.ts 负责。

import { describe, it, expect } from 'vitest';

import { AVATAR_URL_PREFIX, avatarUrl } from '@/lib/avatar-refs';

describe('avatarUrl', () => {
  it('形状 = 路由前缀 + id', () => {
    expect(avatarUrl('1f0c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8')).toBe(
      '/api/avatar/1f0c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8'
    );
  });

  it('前缀与路由实际挂载的位置一致（src/app/api/avatar/[id]）', () => {
    expect(AVATAR_URL_PREFIX).toBe('/api/avatar/');
    // 前缀自带结尾斜杠 —— 少了它 `avatarUrl('x')` 会拼出 /api/avatarx，
    // 而那条路径不存在，会落到 404 页面（不是 identicon 兜底）。
    expect(AVATAR_URL_PREFIX.endsWith('/')).toBe(true);
  });

  it('不做 URL 编码：id 是 UUID4，字符集 [0-9a-f-]，编码是恒等变换', () => {
    const id = 'aabbccdd-eeff-0011-2233-445566778899';
    expect(avatarUrl(id)).toBe(`${AVATAR_URL_PREFIX}${id}`);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it('空 id 不抛 —— 仍返回一个合法 URL，交给调用方的测试去抓「DTO 少带了 id」', () => {
    expect(() => avatarUrl('')).not.toThrow();
    expect(avatarUrl('')).toBe(AVATAR_URL_PREFIX);
  });
});
