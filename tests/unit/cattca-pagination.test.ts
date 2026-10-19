// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// cattca-pagination.test.ts —— 阅读器分页 / 页码换算的单元测试。
//
// 分页依赖真实 DOM 量高度；jsdom 的 scrollHeight 恒为 0，所以这里用一个
// 「1 个字符 = 10px」的假测量覆盖它，专门验证：
//   · 块级元素在页边界处被切开；
//   · 单个超长段落会按字符继续切；
//   · 列表在条目之间切；
//   · 切页不丢文字。
// ─────────────────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clampPage,
  movePage,
  paginateHtml,
  spreadStart,
  visiblePageIndexes,
} from '@/app/components/cattca/paginate';

const proto = window.Element.prototype;
const originalScrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');

function plain(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').replace(/\s+/g, '');
}

beforeEach(() => {
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      // 只用于测试：文字越多越高，让分页逻辑有可比较的量。
      return (this.textContent ?? '').length * 10;
    },
  });
});

afterAll(() => {
  if (originalScrollHeight) {
    Object.defineProperty(proto, 'scrollHeight', originalScrollHeight);
  } else {
    delete (proto as unknown as { scrollHeight?: number }).scrollHeight;
  }
});

describe('页码换算', () => {
  it('clampPage 夹在 [0, total-1]', () => {
    expect(clampPage(-3, 10)).toBe(0);
    expect(clampPage(99, 10)).toBe(9);
    expect(clampPage(4, 10)).toBe(4);
    expect(clampPage(4, 0)).toBe(0);
  });

  it('书页模式保留当前页作为左侧页（不强行偶数对齐）', () => {
    expect(spreadStart(0, true)).toBe(0);
    expect(spreadStart(3, true)).toBe(3);
    expect(spreadStart(3, false)).toBe(3);
  });

  it('翻页步长：单页 1，书页 2', () => {
    expect(movePage(0, 1, 10, false)).toBe(1);
    expect(movePage(0, 1, 10, true)).toBe(2);
    expect(movePage(2, -1, 10, true)).toBe(0);
    expect(movePage(0, -1, 10, false)).toBe(0);
    expect(movePage(8, 1, 10, true)).toBe(9);
    expect(movePage(9, 1, 10, false)).toBe(9);
  });

  it('可见页：书页模式最多两页，末页单独显示', () => {
    expect(visiblePageIndexes(3, 10, true)).toEqual([3, 4]);
    expect(visiblePageIndexes(9, 10, true)).toEqual([9]);
    expect(visiblePageIndexes(9, 10, false)).toEqual([9]);
    expect(visiblePageIndexes(0, 0, true)).toEqual([]);
  });
});

describe('paginateHtml', () => {
  it('在块边界处分页，且不丢文字', () => {
    const long = '字'.repeat(80);
    const html = `<p>${long}</p><h2>标题</h2><p>短段</p>`;
    const pages = paginateHtml(html, { width: 600, height: 500 });

    expect(pages.length).toBeGreaterThan(1);
    const all = plain(pages.join(''));
    expect(all).toContain(long);
    expect(all).toContain('标题');
    expect(all).toContain('短段');
  });

  it('单个超长段落会按字符继续切页', () => {
    const long = '长'.repeat(160);
    const pages = paginateHtml(`<p>${long}</p>`, { width: 600, height: 500 });

    expect(pages.length).toBeGreaterThan(1);
    expect(plain(pages.join(''))).toBe(long);
    for (const page of pages) {
      expect(plain(page).length).toBeLessThanOrEqual(50);
    }
  });

  it('列表在条目之间分页，条目不丢', () => {
    const items = Array.from({ length: 8 }, (_, index) => `第${index}条`);
    const html = `<ul>${items.map((item) => `<li>${item}${'字'.repeat(12)}</li>`).join('')}</ul>`;
    const pages = paginateHtml(html, { width: 600, height: 500 });

    expect(pages.length).toBeGreaterThan(1);
    const all = plain(pages.join(''));
    for (const item of items) expect(all).toContain(item);
  });

  it('有序列表跨页后保持 1、2、3… 的连续编号', () => {
    const items = Array.from({ length: 8 }, (_, index) => `第${index + 1}项`);
    const html = `<ol>${items.map((item) => `<li>${item}${'字'.repeat(12)}</li>`).join('')}</ol>`;
    const pages = paginateHtml(html, { width: 600, height: 500 });

    expect(pages.length).toBeGreaterThan(1);
    const starts = pages.flatMap((page) => {
      const div = document.createElement('div');
      div.innerHTML = page;
      return Array.from(div.querySelectorAll('ol')).map((ol) => Number(ol.getAttribute('start')));
    });
    expect(starts).toEqual(Array.from({ length: 8 }, (_, index) => index + 1));
  });

  it('空 HTML 返回一页空串', () => {
    expect(paginateHtml('', { width: 600, height: 500 })).toEqual(['']);
    expect(paginateHtml('   ', { width: 600, height: 500 })).toEqual(['']);
  });
});
