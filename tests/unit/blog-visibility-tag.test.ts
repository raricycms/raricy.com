// 可见性词汇的两张表（`VISIBILITY_BADGE` 短标记 / `VISIBILITY_LABEL` 短语）。
//
// 【为什么留这一条】两张表都是 `Record<BlogVisibility, string>`：加第四档时 tsc 会逼着
// 补键，但补一个**空串**同样能过类型检查 —— 界面上会出现一个空胶囊或空提示，不报错。
// 这里只断言「每一档都有非空的中文标签，且短标记彼此可区分」，防的是漏配。
//
// 标记怎么渲染（`/blog` 卡片上的 JSX 分支、胶囊尺寸）不在这里固定：那是页面与样式的事，
// 由页面检查覆盖。这里只钉词汇表本身。

import { describe, expect, it } from 'vitest';
import { BLOG_VISIBILITIES, VISIBILITY_BADGE, VISIBILITY_LABEL } from '@/lib/blog-visibility';

describe('可见性词汇的两张表', () => {
  it('每一档都有非空的中文短标记与短语标签（防漏配成空串）', () => {
    for (const v of BLOG_VISIBILITIES) {
      expect(VISIBILITY_BADGE[v], `${v} 缺短标记`).toBeTruthy();
      expect(VISIBILITY_LABEL[v], `${v} 缺短语标签`).toBeTruthy();
    }
  });

  it('短标记三档互不相同 —— 胶囊上分不出档位等于没标', () => {
    const badges = BLOG_VISIBILITIES.map((v) => VISIBILITY_BADGE[v]);
    expect(new Set(badges).size, '短标记不许重复').toBe(badges.length);
  });
});
