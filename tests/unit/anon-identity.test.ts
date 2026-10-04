// anon-identity.ts —— 化名表与发号
//
// 【为什么值得单独钉】化名是纯函数推出来的，而它的**边界**是站长许过的承诺
// （「第一个是 Alice… 到 677 就叫 You Win #677」）。表长、前缀与名字的对应、
// 676/677 那一格，任何一处偏一格都不会报错 —— 只会让第 677 个人叫成别的，
// 而且平时看不见（要真有 676 个人在同一篇文章下匿名评论才会露出来）。

import { describe, it, expect } from 'vitest';
import {
  PSEUDONYM_NAMES,
  PSEUDONYM_PREFIXES,
  PSEUDONYM_VARIANTS,
  pseudonymForSeq,
  pseudonymAvatarUrl,
} from '@/lib/anon-identity';

describe('化名表', () => {
  it('两张表同长（不同长会拼出「undefined Alice」而不报错）', () => {
    expect(PSEUDONYM_NAMES.length).toBe(26);
    expect(PSEUDONYM_PREFIXES.length).toBe(26);
  });

  it('首轮不带前缀（第 0 个前缀是空串），其余 25 个以 A–Y 打头', () => {
    expect(PSEUDONYM_PREFIXES[0]).toBe('');
    for (let i = 1; i < PSEUDONYM_PREFIXES.length; i++) {
      expect(PSEUDONYM_PREFIXES[i][0]).toBe(String.fromCharCode('A'.charCodeAt(0) + i - 1));
    }
  });

  it('名字按 A–Z 打头，站长的两个例子在表里（Alice / Bob / Carol）', () => {
    expect(PSEUDONYM_NAMES[0]).toBe('Alice');
    expect(PSEUDONYM_NAMES[1]).toBe('Bob');
    expect(PSEUDONYM_NAMES[2]).toBe('Carol');
    for (let i = 0; i < PSEUDONYM_NAMES.length; i++) {
      expect(PSEUDONYM_NAMES[i][0]).toBe(String.fromCharCode('A'.charCodeAt(0) + i));
    }
  });

  it('常规档总数 = 26×26 = 676（`You Win #677` 那个 677 的来处）', () => {
    expect(PSEUDONYM_VARIANTS).toBe(676);
  });
});

describe('pseudonymForSeq：序号 → 化名', () => {
  it('首个是 Alice，第二个 Bob，第三个 Carol', () => {
    expect(pseudonymForSeq(1)).toBe('Alice');
    expect(pseudonymForSeq(2)).toBe('Bob');
    expect(pseudonymForSeq(3)).toBe('Carol');
  });

  it('第 26 个是最后一个裸名', () => {
    expect(pseudonymForSeq(26)).toBe('Zach');
  });

  it('第 27 个起加前缀：Angry Alice / Angry Bob', () => {
    expect(pseudonymForSeq(27)).toBe('Angry Alice');
    expect(pseudonymForSeq(28)).toBe('Angry Bob');
  });

  it('第二轮整轮 26 个，第三轮换前缀', () => {
    expect(pseudonymForSeq(52)).toBe('Angry Zach');
    expect(pseudonymForSeq(53)).toBe('Bashful Alice');
  });

  it('676 是最后一个常规化名', () => {
    expect(pseudonymForSeq(676)).toBe('Yawning Zach');
  });

  it('677 起走彩蛋档，序号即编号（#677 是第一个）', () => {
    expect(pseudonymForSeq(677)).toBe('You Win #677');
    expect(pseudonymForSeq(678)).toBe('You Win #678');
    expect(pseudonymForSeq(9999)).toBe('You Win #9999');
  });

  it('1..676 全不重复（重号 = 两个人同名）', () => {
    const seen = new Set<string>();
    for (let seq = 1; seq <= PSEUDONYM_VARIANTS; seq++) seen.add(pseudonymForSeq(seq));
    expect(seen.size).toBe(PSEUDONYM_VARIANTS);
  });

  it('越界不抛（渲染层不该被一条脏数据炸掉整棵树）', () => {
    expect(pseudonymForSeq(0)).toBe('Alice');
    expect(pseudonymForSeq(-5)).toBe('Alice');
    expect(pseudonymForSeq(1.9)).toBe('Alice');
  });
});

describe('pseudonymAvatarUrl：按化名哈希出头像', () => {
  it('确定性：同一个化名永远同一个地址', () => {
    expect(pseudonymAvatarUrl('Alice')).toBe(pseudonymAvatarUrl('Alice'));
  });

  it('不同化名不同地址（否则两个人的头像一样）', () => {
    expect(pseudonymAvatarUrl('Alice')).not.toBe(pseudonymAvatarUrl('Bob'));
  });

  it('走 avatarUrl 的唯一出口，且种子落在文件名字符集之外', () => {
    const url = pseudonymAvatarUrl('Angry Alice');
    expect(url.startsWith('/api/avatar/')).toBe(true);
    // 种子里那枚 `~` 让 resolveAvatar 的正则不匹配 —— 于是这张图**必然**是现算的
    // identicon，绝不会去读 instance/avatars/<种子>.png（否则站长放个同名文件就盖掉了）。
    const seed = url.slice('/api/avatar/'.length);
    expect(/^[a-zA-Z0-9_-]+$/.test(seed)).toBe(false);
    expect(seed).toContain('~');
  });

  it('地址里没有空格与中文（带空格的化名也要能直接进 href）', () => {
    for (const name of ['Alice', 'Angry Alice', 'You Win #677']) {
      expect(pseudonymAvatarUrl(name)).toMatch(/^\/api\/avatar\/[A-Za-z0-9~-]+$/);
    }
  });
});
