// page-window.ts —— 站内分页的页码窗口（首尾常驻 + 当前页 ±window，其余折成 …）。
//
// 【为什么值得钉】这段算术原先在四个页面各抄了一份（博客 / 通知 / 对外目录 /
// 小鱼干流水），而另外两个页面（图床管理、音频床管理）干脆没抄 —— 它们直接
// `Array.from({ length: pages })` 把**全部页码**平铺出来，页数一多就挤成满满一排
// 方块、窄屏还要横向滚。现在它只有一处实现，由 `src/app/components/SitePager.tsx`
// 统一渲染；「没有第二份手写分页标记」由 `site-pager-guard.test.ts` 盯着。
//
// 这里锁的是**形状**：首尾页一定在、当前页一定在、页数多时一定出现省略号
// （而不是全量），且渲染出来的格数是窗口的常数级 —— 不随总页数膨胀。

import { describe, it, expect } from 'vitest';

import { pageWindow } from '@/lib/page-window';

describe('pageWindow', () => {
  it('页数装得下整个窗口时给全部页码，不出现省略号', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    // 贴边的极端：窗口从当前页向后溢出到末页，前面只剩 1 页缺口 —— 仍按「缺口处折成 …」
    // 处理（不会为了省一个省略号把窗口内的排版改成另一种形状）。这条是现状，
    // 与博客 / 通知的观感一致；改窗口算术前先看 §5.4 定的样子。
    expect(pageWindow(6, 7)).toEqual([1, null, 3, 4, 5, 6, 7]);
  });

  it('中段：首尾页常驻，缺口处各一个省略号', () => {
    expect(pageWindow(5, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, null, 12]);
    expect(pageWindow(6, 12)).toEqual([1, null, 3, 4, 5, 6, 7, 8, 9, null, 12]);
    expect(pageWindow(8, 12)).toEqual([1, null, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('页数多时只给窗口内的页码 —— 绝不把全部页码堆出来', () => {
    const out = pageWindow(20, 200);
    // 页码数量是窗口的常数级（此处 1 + 7 + 1 = 9），与总页数 200 无关 ——
    // 这条就是「不要把所有页码堆出来」的判据。
    expect(out.filter((p) => p !== null)).toHaveLength(9);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out).toContain(null);
    // 首尾与当前页一个都不能少，否则「回首页 / 回末页 / 看我在哪」会缺一块。
    expect(out).toContain(1);
    expect(out).toContain(200);
    expect(out).toContain(20);
  });

  it('窗口宽度可调（默认 3 = 当前页左右各 3 页）', () => {
    expect(pageWindow(5, 20, 1)).toEqual([1, null, 4, 5, 6, null, 20]);
    expect(pageWindow(5, 20, 0)).toEqual([1, null, 5, null, 20]);
  });

  it('当前页超出总页数时仍收敛到首尾（不抛异常，也不画出一片空白）', () => {
    expect(pageWindow(99, 5)).toEqual([1, 5]);
  });
});
