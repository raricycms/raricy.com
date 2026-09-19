// json-ld.ts —— 注入 <script type="application/ld+json"> 的唯一出口。
//
// 【为什么这些用例是这个形状】本站**没有任何 CSP**（next.config.mjs 与
// src/middleware.ts 都查过），所以转义写错时没有任何响应头兜底：一个含 `</script>`
// 的**文章标题**就能提前闭合脚本块，把后面的内容变成页面上的 HTML —— 而文章页恰恰是
// 对外可索引的，等于把一发 XSS 印在公网上。标题是用户输入，库里实打实有 XSS 演示内容。
//
// 所以这里的断言不是「转义函数行为正确」这种泛泛的话，而是**攻击载荷过不去**。

import { describe, it, expect } from 'vitest';
import { jsonLdScript } from '@/lib/json-ld';

describe('jsonLdScript / 注入防线', () => {
  it('★ 标题里的 </script> 被吃掉 —— 这是唯一的兜底', () => {
    const out = jsonLdScript({ headline: 'a</script><img src=x onerror=alert(1)>b' });
    expect(out, '产物里不许出现能闭合脚本块的序列').not.toContain('</script');
    expect(out, '一个裸 < 都不该剩').not.toContain('<');
  });

  it('大小写与空白变体也不放过（HTML 解析器不区分大小写）', () => {
    for (const payload of ['</SCRIPT>', '</Script>', '</script >', '</script\t>', '<!--<script']) {
      expect(jsonLdScript({ t: payload }).includes('<'), `${payload} 漏了`).toBe(false);
    }
  });

  it('转义**不改变语义**：JSON.parse 回来等于原对象', () => {
    const evil = { headline: '</script><b>&"\'', nested: { s: 'a<b', n: [1, 'x<y'] } };
    expect(JSON.parse(jsonLdScript(evil))).toEqual(evil);
  });

  it('U+2028 / U+2029 被转义（在 JSON 里合法，但被当 JS 字面量解析时会断行）', () => {
    const raw = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const out = jsonLdScript({ t: raw });
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(JSON.parse(out).t, '转义后必须还读得回原值').toBe(raw);
  });
});

describe('jsonLdScript / 不过度转义（转义太多会让产物难读且难比对）', () => {
  it('中文、emoji、换行、引号照旧可读', () => {
    const ok = { t: '中文标题', e: '🎉', n: 'a\nb', q: '"引号"' };
    const out = jsonLdScript(ok);
    expect(JSON.parse(out)).toEqual(ok);
    expect(out).toContain('中文标题');
    expect(out).toContain('🎉');
  });

  it('`&` 不必转义 —— 它关不掉脚本块，转了只是噪音', () => {
    const out = jsonLdScript({ t: 'a & b' });
    expect(out).toContain('a & b');
    expect(JSON.parse(out).t).toBe('a & b');
  });
});

describe('jsonLdScript / 签名的承诺要兜住', () => {
  it('传 undefined / null / 数组都不抛（JSON.stringify 对 undefined 返回的是 undefined 本身）', () => {
    // JSON.stringify(undefined) === undefined（不是字符串），直接 .replace 会 TypeError。
    // 调用方传的永远是对象，但签名写的是 unknown —— 那就是承诺。
    expect(() => jsonLdScript(undefined)).not.toThrow();
    expect(jsonLdScript(undefined)).toBe('null');
    expect(jsonLdScript(null)).toBe('null');
    expect(jsonLdScript([1, 2])).toBe('[1,2]');
    expect(jsonLdScript({ a: 1 })).toBe('{"a":1}');
  });
});

describe('jsonLdScript / 与真实 BlogPosting 形状的联测', () => {
  it('一篇标题带攻击载荷的文章，产出的脚本块里没有任何裸 <', () => {
    const posting = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: '</script><script>alert(1)</script>',
      datePublished: '2026-09-19T18:00:00.000+08:00',
      author: { '@type': 'Person', name: 'a<b' },
      image: ['https://raricy.com/api/og/blog/x'],
    };
    const out = jsonLdScript(posting);
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual(posting);
    // 顺带确认这个形状是合法 JSON-LD 的对象（@context / @type 都在）
    expect(JSON.parse(out)['@type']).toBe('BlogPosting');
  });
});
