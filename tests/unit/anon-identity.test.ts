// anon-identity.ts —— 化名表与发号
//
// 【为什么值得单独钉】化名是纯函数推出来的，而它的**边界**是站长许过的承诺
// （「第一个是 Alice… 排到 ZZ，之后就叫 You Win #703」）。表长、前缀与名字的对应、
// 702/703 那一格，任何一处偏一格都不会报错 —— 只会让第 703 个人叫成别的，
// 而且平时看不见（要真有 702 个人在同一篇文章下匿名评论才会露出来）。

import { describe, it, expect } from 'vitest';
import {
  PSEUDONYM_NAMES,
  PSEUDONYM_PREFIXES,
  PSEUDONYM_VARIANTS,
  pseudonymForSeq,
  pseudonymAvatarUrl,
} from '@/lib/anon-identity';

describe('化名表', () => {
  it('前缀表比名字表多一个（长度不对会拼出「undefined Alice」而不报错）', () => {
    expect(PSEUDONYM_NAMES.length).toBe(26);
    expect(PSEUDONYM_PREFIXES.length).toBe(27);
  });

  it('常规档总数 = 27×26 = 702（`You Win #703` 那个 703 的来处）', () => {
    expect(PSEUDONYM_VARIANTS).toBe(702);
  });
});

describe('pseudonymForSeq：序号 → 化名', () => {
  it('关键边界：首个 Alice、第 27 个起加前缀、702 是最后一个常规化名、703 起彩蛋档', () => {
    expect(pseudonymForSeq(1)).toBe('Alice');
    expect(pseudonymForSeq(26)).toBe('Zach');
    expect(pseudonymForSeq(27)).toBe('Angry Alice');
    expect(pseudonymForSeq(702)).toBe('Zealous Zach');
    expect(pseudonymForSeq(703)).toBe('You Win #703');
    expect(pseudonymForSeq(9999)).toBe('You Win #9999');
  });
  it('1..702 全不重复（重号 = 两个人同名）', () => {
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
    for (const name of ['Alice', 'Angry Alice', 'You Win #703']) {
      expect(pseudonymAvatarUrl(name)).toMatch(/^\/api\/avatar\/[A-Za-z0-9~-]+$/);
    }
  });
});
