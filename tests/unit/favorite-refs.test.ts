// favorite-refs.ts —— 收藏夹引用的 id 词汇与盖码工具（legacy 卡片 HTML 已随旧管线退役）
//
// 【为什么这么测】
//   · **id 白名单**：分流是按长度做的，`[@abcdef]`（6 位字母）必须落回字面量 ——
//     一旦被判成收藏夹，每次渲染都会去请求一次根本不存在的资源，而且用户看不出
//     为什么「写了没用」。
//   · **盖码**：reactive 适配器与版本指令扫描跑在盖码副本上；代码块里的 `[@id]`
//     不展开是已对外承诺的行为。等长填充是「下标仍指向原文」的前提。
import { describe, it, expect } from 'vitest';
import {
  FAVORITE_ID_LEN,
  FAVORITE_ID_RE,
  MAX_CARD_ITEMS,
  MAX_FAVORITE_REFS,
  favoriteRefToken,
  isFavoriteId,
  maskMarkdownCode,
} from '@/lib/favorite-refs';

describe('isFavoriteId —— 恰好 6 位数字', () => {
  it('接受 6 位数字（含前导零）', () => {
    expect(isFavoriteId('123456')).toBe(true);
    expect(isFavoriteId('000000')).toBe(true);
    expect(isFavoriteId('000123')).toBe(true);
  });

  it('拒绝长度对但字符不对的（6 位字母 / 下划线）', () => {
    // 这几种长度都等于 6，靠「长度 === 6」分流会全部漏进来
    expect(isFavoriteId('abcdef')).toBe(false);
    expect(isFavoriteId('______')).toBe(false);
    expect(isFavoriteId('12345a')).toBe(false);
    expect(isFavoriteId('12 456')).toBe(false);
    expect(isFavoriteId('+12345')).toBe(false);
    expect(isFavoriteId('１２３４５６')).toBe(false); // 全角数字
  });

  it('拒绝长度不对的 / 非字符串', () => {
    expect(isFavoriteId('12345')).toBe(false);
    expect(isFavoriteId('1234567')).toBe(false);
    expect(isFavoriteId('')).toBe(false);
    expect(isFavoriteId(123456)).toBe(false);
    expect(isFavoriteId(null)).toBe(false);
    expect(isFavoriteId(undefined)).toBe(false);
    expect(isFavoriteId({})).toBe(false);
  });

  it('常量与正则自洽（长度就是 FAVORITE_ID_LEN）', () => {
    expect(FAVORITE_ID_RE.source).toBe(`^[0-9]{${FAVORITE_ID_LEN}}$`);
    expect('1'.repeat(FAVORITE_ID_LEN)).toMatch(FAVORITE_ID_RE);
    expect('1'.repeat(FAVORITE_ID_LEN + 1)).not.toMatch(FAVORITE_ID_RE);
  });
});

describe('favoriteRefToken', () => {
  it('拼出插入用的 token', () => {
    expect(favoriteRefToken('123456')).toBe('[@123456]');
  });
});

describe('maskMarkdownCode —— 等长盖码，只用于扫描', () => {
  it('围栏代码块与行内代码被盖掉，且长度不变（下标一一对应）', () => {
    const text = '正文 [@123456]\n\n```\n[@111111]\n```\n\n行内 `[@222222]` 结束';
    const masked = maskMarkdownCode(text);
    expect(masked.length).toBe(text.length);
    expect(masked).not.toContain('[@111111]');
    expect(masked).not.toContain('[@222222]');
    // 码外的引用原样保留在盖码副本里（适配器就是在它上面扫）
    expect(masked).toContain('[@123456]');
  });

  it('围栏与行内代码的各种围法都盖得住', () => {
    for (const md of ['```\n[@111111]\n```', '~~~\n[@111111]\n~~~', '````\n[@111111]\n````']) {
      expect(maskMarkdownCode(md), md).not.toContain('[@111111]');
    }
    expect(maskMarkdownCode('`[@111111]`')).not.toContain('[@111111]');
  });

  it('缩进式代码块刻意不盖（列表续行也是 4 空格，误盖会吃掉正文引用）', () => {
    const text = '    [@111111]\n\n正文';
    expect(maskMarkdownCode(text)).toContain('[@111111]');
  });

  it('未闭合的行内反引号不会跨行吃掉后面的正文', () => {
    const text = '`未闭合的\n[@111111]';
    expect(maskMarkdownCode(text)).toContain('[@111111]');
  });
});

describe('预算常量', () => {
  it('MAX_FAVORITE_REFS 是个小正数（卡片是块级的，插十几张会把正文冲成卡片墙）', () => {
    expect(MAX_FAVORITE_REFS).toBeGreaterThan(0);
    expect(MAX_FAVORITE_REFS).toBeLessThanOrEqual(10);
  });

  it('MAX_CARD_ITEMS 是给调用方（服务端截断）用的常量，取正数', () => {
    expect(MAX_CARD_ITEMS).toBeGreaterThan(0);
  });
});
