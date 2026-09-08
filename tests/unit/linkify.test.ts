// linkify.ts —— 聊天正文里的 URL 识别
//
// 【为什么测这些】它直接决定「哪些文本会被渲染成 <a href>」，写宽了等于给自己开
// 一个注入面（虽然正则只认 http(s)），写窄了用户发的链接点不动。边界全在这里钉死：
//   · 伪协议（javascript: / data:）绝不产出 link；
//   · 中文句读、英文句点、多余右括号要剥掉，成对括号要保留；
//   · 片段拼回去必须与原文完全一致（渲染端按片段顺序输出，丢字符就是内容损坏）。

import { describe, it, expect } from 'vitest';
import { linkify, type LinkifyPart } from '@/lib/linkify';

const links = (parts: LinkifyPart[]) => parts.filter((p) => p.type === 'link');
const join = (parts: LinkifyPart[]) => parts.map((p) => p.text).join('');

describe('linkify：基本切分', () => {
  it('无链接 → 单个文本片段', () => {
    const parts = linkify('今天天气不错');
    expect(parts).toEqual([{ type: 'text', text: '今天天气不错' }]);
    expect(links(parts)).toHaveLength(0);
  });

  it('空串 → 空数组', () => {
    expect(linkify('')).toEqual([]);
  });

  it('纯链接 → 一个 link 片段', () => {
    const parts = linkify('https://example.com/a?b=1');
    expect(parts).toEqual([
      { type: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
    ]);
  });

  it('前后有文字 → 三段，且拼回去与原文一致', () => {
    const src = '看这个 https://example.com/x 很有意思';
    const parts = linkify(src);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '看这个 ' });
    expect(parts[2]).toEqual({ type: 'text', text: ' 很有意思' });
    expect(join(parts)).toBe(src);
  });

  it('多个链接都能识别', () => {
    const src = 'https://a.com 和 https://b.com';
    const parts = linkify(src);
    expect(links(parts).map((l) => l.href)).toEqual(['https://a.com', 'https://b.com']);
    expect(join(parts)).toBe(src);
  });
});

describe('linkify：伪协议与安全', () => {
  it('javascript: / data: 不产出链接', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//example.com',
      'ftp://example.com',
    ]) {
      const parts = linkify(bad);
      expect(links(parts), bad).toHaveLength(0);
      expect(join(parts)).toBe(bad);
    }
  });

  it('http 与 https 都认', () => {
    expect(links(linkify('http://a.com'))[0].href).toBe('http://a.com');
    expect(links(linkify('HTTPS://A.COM')).length).toBe(1); // 大小写不敏感
  });
});

describe('linkify：尾部标点剥离', () => {
  it('中文句读不算 URL 的一部分', () => {
    const parts = linkify('见 https://a.com/x。');
    expect(links(parts)[0].href).toBe('https://a.com/x');
    expect(join(parts)).toBe('见 https://a.com/x。');
  });

  it('英文句点 / 逗号 / 感叹号剥离', () => {
    expect(links(linkify('https://a.com/x.'))[0].href).toBe('https://a.com/x');
    expect(links(linkify('https://a.com/x, and'))[0].href).toBe('https://a.com/x');
    expect(links(linkify('https://a.com/x!'))[0].href).toBe('https://a.com/x');
  });

  it('多余的右括号剥掉，成对括号保留', () => {
    expect(links(linkify('(见 https://a.com/x)'))[0].href).toBe('https://a.com/x');
    expect(links(linkify('https://en.wikipedia.org/wiki/Foo_(bar)'))[0].href).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    );
  });

  it('多个尾标点连续剥离（。）， 这类组合）', () => {
    expect(links(linkify('https://a.com/x。）'))[0].href).toBe('https://a.com/x');
  });

  it('剥离后不会把标点吞掉：仍以文本形式出现在片段里', () => {
    const src = 'https://a.com/x。';
    expect(join(linkify(src))).toBe(src);
  });
});

describe('linkify：与其他文本混排', () => {
  it('链接紧跟 @提及 / 换行也能正确切分', () => {
    const src = '@alice 看\nhttps://a.com/x\n谢谢';
    const parts = linkify(src);
    expect(links(parts)).toHaveLength(1);
    expect(join(parts)).toBe(src);
  });

  it('尖括号 / 引号内的链接不被吞（正则排除这些字符）', () => {
    expect(links(linkify('<https://a.com/x>'))[0].href).toBe('https://a.com/x');
  });
});
