// favorite-refs.ts —— 收藏夹引用语法 `[@六位ID]` 的纯逻辑
//
// 【为什么这么测】
//   · **id 白名单**：分流是按长度做的，`[@abcdef]`（6 位字母）必须落回字面量 ——
//     一旦被判成收藏夹，每次渲染都会去请求一次根本不存在的资源，而且用户看不出
//     为什么「写了没用」。
//   · **不重扫插入内容**：卡片 HTML 里含博客标题（不可信输入），标题里若正好有
//     `[@…]` 字样，用 `String.replace` 实现的话会命中**插入内容里的那处** ——
//     等于给用户一个「让自己的标题被解释成引用」的口子。这是 content-refs.ts
//     记过的 bug 类型，这里用同样的用例钉死。
//   · **转义**：卡片是净化**之前**拼进 Markdown 的，DOMPurify 还没上场。

import { describe, it, expect } from 'vitest';
import {
  FAVORITE_ID_LEN,
  FAVORITE_ID_RE,
  MAX_FAVORITE_REFS,
  MAX_CARD_ITEMS,
  isFavoriteId,
  escapeHtml,
  favoriteFailureText,
  buildFavoriteCardHtml,
  replaceFavoriteRefs,
  collectFavoriteRefs,
  type FavoriteRefSlot,
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

  it('拒绝长度不对的', () => {
    expect(isFavoriteId('12345')).toBe(false);
    expect(isFavoriteId('1234567')).toBe(false);
    expect(isFavoriteId('')).toBe(false);
  });

  it('拒绝非字符串', () => {
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

describe('escapeHtml —— 卡片文本在净化之前就要自己转义', () => {
  it('转掉 5 个 HTML 元字符', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('& 先转，避免二次转义（&lt; 不能变成 &amp;lt;）', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('普通文本原样', () => {
    expect(escapeHtml('我的收藏夹 v2')).toBe('我的收藏夹 v2');
  });

  it('挡住「标题里写标签逃出容器」', () => {
    const html = buildFavoriteCardHtml({
      id: '123456',
      title: `</div><script>alert(1)</script>`,
      count: 0,
      blogs: [],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('buildFavoriteCardHtml', () => {
  const base = { id: '123456', title: '好书', count: 2 };

  it('列出条目，链接指向 /blog/<id>', () => {
    const html = buildFavoriteCardHtml({
      ...base,
      blogs: [
        { id: 'b-1', title: '甲' },
        { id: 'b-2', title: '乙' },
      ],
    });
    expect(html).toContain('href="/blog/b-1"');
    expect(html).toContain('href="/blog/b-2"');
    expect(html).toContain('共 2 篇');
  });

  it('列全了就不给「查看全部」（没有去的理由）', () => {
    const html = buildFavoriteCardHtml({
      ...base,
      blogs: [
        { id: 'b-1', title: '甲' },
        { id: 'b-2', title: '乙' },
      ],
    });
    expect(html).not.toContain('favorite-embed__more');
  });

  it('还有更多时才给「查看全部」，且带上总数', () => {
    const html = buildFavoriteCardHtml({
      id: '123456',
      title: '好书',
      count: 99,
      blogs: [{ id: 'b-1', title: '甲' }],
    });
    expect(html).toContain('favorite-embed__more');
    expect(html).toContain('href="/favorite/123456"');
    expect(html).toContain('99');
  });

  it('有作者才渲染作者', () => {
    expect(buildFavoriteCardHtml({ ...base, blogs: [], author: 'alice' })).toContain('@alice');
    expect(buildFavoriteCardHtml({ ...base, blogs: [] })).not.toContain('favorite-embed__author');
  });

  it('空收藏夹不渲染空列表', () => {
    const html = buildFavoriteCardHtml({ ...base, count: 0, blogs: [] });
    expect(html).not.toContain('<ul');
    expect(html).toContain('共 0 篇');
  });

  it('条目标题里的标签被转义', () => {
    const html = buildFavoriteCardHtml({
      ...base,
      count: 1,
      blogs: [{ id: 'b-1', title: '<img src=x onerror=1>' }],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('MAX_CARD_ITEMS 是给调用方（服务端截断）用的常量，取正数', () => {
    expect(MAX_CARD_ITEMS).toBeGreaterThan(0);
  });
});

describe('replaceFavoriteRefs —— 按区间切片，绝不重扫', () => {
  /** 用一个假的正则模拟 MarkdownRenderer 的分流结果，构造 slot。 */
  function slotsOf(text: string): FavoriteRefSlot[] {
    const out: FavoriteRefSlot[] = [];
    for (const m of text.matchAll(/\[@\s*(\w+)\s*\]/g)) {
      out.push({ id: m[1], match: m[0], start: m.index ?? 0 });
    }
    return out;
  }

  it('替换命中，未命中的保留字面量', () => {
    const text = '前 [@111111] 后 [@999999] 尾';
    const html = new Map([['111111', '<div class="favorite-embed">卡片</div>']]);
    const out = replaceFavoriteRefs(text, slotsOf(text), html);
    expect(out).toBe('前 <div class="favorite-embed">卡片</div> 后 [@999999] 尾');
  });

  it('容忍内部空白（与博客侧同口径）', () => {
    const text = '[@ 111111 ]';
    const html = new Map([['111111', 'X']]);
    expect(replaceFavoriteRefs(text, slotsOf(text), html)).toBe('X');
  });

  it('超出上限的引用既不替换也不丢失', () => {
    const text = '[@111111] [@222222] [@333333]';
    const html = new Map([
      ['111111', 'A'],
      ['222222', 'B'],
      ['333333', 'C'],
    ]);
    const out = replaceFavoriteRefs(text, slotsOf(text), html, 2);
    expect(out).toBe('A B [@333333]');
  });

  it('同一个 id 出现两次时每处都替换，且各占一个名额', () => {
    const text = '[@111111] 与 [@111111]';
    const html = new Map([['111111', 'A']]);
    expect(replaceFavoriteRefs(text, slotsOf(text), html, 2)).toBe('A 与 A');
    // 名额只有 1 时第二处保留字面量
    expect(replaceFavoriteRefs(text, slotsOf(text), html, 1)).toBe('A 与 [@111111]');
  });

  it('★ 插入内容里的 [@id] 不会再被展开（replace 实现会踩的坑）', () => {
    const text = '[@111111]';
    // 卡片里含一个「看起来像引用」的字面量（真实来源：博客标题就叫 [@222222]）
    const html = new Map([
      ['111111', '<div>[@222222]</div>'],
      ['222222', '<div>不该出现</div>'],
    ]);
    const out = replaceFavoriteRefs(text, slotsOf(text), html, MAX_FAVORITE_REFS);
    expect(out).toBe('<div>[@222222]</div>');
    expect(out).not.toContain('不该出现');
  });

  it('没有引用时原样返回', () => {
    expect(replaceFavoriteRefs('纯文本', [], new Map())).toBe('纯文本');
  });

  it('空 html map 时全部保留字面量（fail-closed）', () => {
    const text = '[@111111]';
    expect(replaceFavoriteRefs(text, slotsOf(text), new Map())).toBe('[@111111]');
  });

  it('失败文案会被替换进去（调用方把它塞进 map）', () => {
    const text = '[@111111]';
    const html = new Map([['111111', favoriteFailureText('111111')]]);
    expect(replaceFavoriteRefs(text, slotsOf(text), html)).toBe('[收藏夹 111111 加载失败]');
  });
});

describe('favoriteFailureText', () => {
  it('与剪贴板的失败文案同构', () => {
    expect(favoriteFailureText('123456')).toBe('[收藏夹 123456 加载失败]');
  });
});

describe('collectFavoriteRefs —— 扫出正文里的所有引用', () => {
  it('给出 id / match / start（位置用于切片）', () => {
    const text = '前 [@111111] 后';
    const slots = collectFavoriteRefs(text);
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe('111111');
    expect(slots[0].match).toBe('[@111111]');
    expect(text.slice(slots[0].start, slots[0].start + slots[0].match.length)).toBe('[@111111]');
  });

  it('容忍内部空白（match 要含空白，否则切不干净）', () => {
    const text = '[@ 111111 ]';
    const slots = collectFavoriteRefs(text);
    expect(slots).toHaveLength(1);
    expect(slots[0].match).toBe('[@ 111111 ]');
    expect(slots[0].start).toBe(0);
  });

  it('6 位字母 / 其它长度都不算（与主循环的白名单判定一致）', () => {
    expect(collectFavoriteRefs('[@abcdef]')).toHaveLength(0);
    expect(collectFavoriteRefs('[@12345]')).toHaveLength(0);
    expect(collectFavoriteRefs('[@1234567]')).toHaveLength(0);
    // 8 位剪贴板 token 里恰好含 6 位数字也不该被切出来
    expect(collectFavoriteRefs('[@12345678]')).toHaveLength(0);
  });

  it('多次调用互不干扰（全局正则的 lastIndex 不能残留）', () => {
    const text = '[@111111] 与 [@222222]';
    expect(collectFavoriteRefs(text)).toHaveLength(2);
    expect(collectFavoriteRefs(text)).toHaveLength(2); // 第二次仍是 2 而不是 0/1
  });

  it('扫出来的 slot 直接喂给 replaceFavoriteRefs 就能用', () => {
    const text = '看 [@111111] 和 [@222222]';
    const html = new Map([
      ['111111', 'A'],
      ['222222', 'B'],
    ]);
    expect(replaceFavoriteRefs(text, collectFavoriteRefs(text), html)).toBe('看 A 和 B');
  });
});

describe('代码块与行内代码里的引用不算（对外承诺：代码里写的就是字面量）', () => {
  it('行内代码里的不扫', () => {
    expect(collectFavoriteRefs('看 `[@111111]` 这个样子')).toHaveLength(0);
    // 码外的照扫
    const mixed = collectFavoriteRefs('外面 [@111111] 里面 `[@222222]`');
    expect(mixed.map((s) => s.id)).toEqual(['111111']);
  });

  it('围栏代码块里的不扫（``` 与 ~~~ 都算）', () => {
    expect(collectFavoriteRefs('```\n[@111111]\n```')).toHaveLength(0);
    expect(collectFavoriteRefs('~~~\n[@111111]\n~~~')).toHaveLength(0);
    // 更长围栏（````）也要能被自己那对认出来
    expect(collectFavoriteRefs('````\n[@111111]\n````')).toHaveLength(0);
  });

  it('围栏块之后的内容照扫', () => {
    const text = '```\n[@111111]\n```\n\n正文 [@222222]';
    expect(collectFavoriteRefs(text).map((s) => s.id)).toEqual(['222222']);
  });

  it('★ 盖码是等长的：码外引用的 start 仍指向原文正确位置', () => {
    const text = '`[@000000]` 然后 [@111111] 结尾';
    const slots = collectFavoriteRefs(text);
    expect(slots).toHaveLength(1);
    expect(text.slice(slots[0].start, slots[0].start + slots[0].match.length)).toBe('[@111111]');
  });

  it('★ 端到端：码里的引用原样留着，码外的换成卡片（卡片不会跑进 <code>）', () => {
    const text = '外面 [@111111]\n\n代码里 `[@111111]`';
    const html = new Map([['111111', '<div class="favorite-embed">卡片</div>']]);
    const out = replaceFavoriteRefs(text, collectFavoriteRefs(text), html);
    expect(out).toBe('外面 <div class="favorite-embed">卡片</div>\n\n代码里 `[@111111]`');
  });

  it('嵌套/跨行的行内代码不会误盖后面的正文', () => {
    // 行内代码不跨行，所以第二行的引用不该被它吃掉
    const text = '`未闭合的\n[@111111]';
    expect(collectFavoriteRefs(text).map((s) => s.id)).toEqual(['111111']);
  });
});

describe('MAX_FAVORITE_REFS', () => {
  it('是个小正数（卡片是块级的，插十几张会把正文冲成卡片墙）', () => {
    expect(MAX_FAVORITE_REFS).toBeGreaterThan(0);
    expect(MAX_FAVORITE_REFS).toBeLessThanOrEqual(10);
  });
});
