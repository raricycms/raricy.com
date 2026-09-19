// 站内列表卡片上的可见性标记（`/blog` 的 .blog-visibility-tag）。
//
// 【为什么值得一条静态守卫】src/app/blog/page.tsx 里那两个分支是**写死的字面量**：
// tests/unit/css-tsx-classes.test.ts 只认字面量类名（模板串里 `${…}` 整段会被剥掉，
// 剩下的 `blog-visibility-tag--` 会被判成「写了但没有定义」），所以拼不出动态类名。
//
// 写死意味着加第四档时这里**不会自动长出来**，而后果是静默的：作者看到一篇没有标记的
// 文章，会以为它没对外 —— 而它可能已经公开了。这条守卫把那个静默缺口变成一条会红的
// 断言，与 blog-visibility-guard / explore-visibility-guard 是同一手法。
//
// ⚠️ 它扫的是**源码文本**，不是渲染结果。「静态守卫是绊线，不是证明器」——
// 真正的行为保证在 e2e 里（真实渲染出的卡片上有没有那个胶囊）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BLOG_VISIBILITIES, VISIBILITY_BADGE, VISIBILITY_LABEL } from '@/lib/blog-visibility';

const PAGE = path.resolve(import.meta.dirname, '../../src/app/blog/page.tsx');
const src = fs.readFileSync(PAGE, 'utf-8');

/** 卡片里出现了某个档位的标记分支吗？（`b.visibility === 'x'`） */
const hasBranch = (v: string) => new RegExp(`b\\.visibility\\s*===\\s*'${v}'`).test(src);

describe('站内列表的可见性标记', () => {
  it('扫的是真文件，不是空字符串（防路径写错导致的假绿）', () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('blog-visibility-tag');
  });

  it('**不标** private —— 它是默认档，标它等于满屏噪音', () => {
    // 站内数千篇默认全是 private。给默认值加标记，反而把 link/public 淹没在里面。
    expect(hasBranch('private')).toBe(false);
  });

  it('★ 除 private 外的**每一档**都必须有标记分支 —— 加第四档时这条会红', () => {
    const missing = BLOG_VISIBILITIES.filter((v) => v !== 'private' && !hasBranch(v));
    expect(
      missing,
      '这些档位在 src/app/blog/page.tsx 里没有标记分支 —— 作者会把它们看成「没对外」，' +
        '而其中可能有已经公开的。补一个分支（类名必须是**字面量**，见该处注释）。'
    ).toEqual([]);
  });

  it('用到的类名恰好是定义过的那两个变体，没有第三个', () => {
    const all = [...src.matchAll(/blog-visibility-tag(?:--[a-z]+)?/g)].map((m) => m[0]);
    // 裸基类名是容器类，两个变体是 --link / --public；注释里出现过 `blog-visibility-tag--`
    // 这种截断写法，它只会匹配到裸基类名，不算数。
    const variants = new Set(all.filter((c) => c !== 'blog-visibility-tag'));
    expect([...variants].sort()).toEqual([
      'blog-visibility-tag--link',
      'blog-visibility-tag--public',
    ]);
  });

  it('文案取自 VISIBILITY_BADGE，**不在 JSX 里写死**档名', () => {
    // 反例：直接写 <span>已公开</span>。那样改文案时两处会漂，加第四档时也不会被 tsc 逼到。
    for (const v of BLOG_VISIBILITIES) {
      if (v === 'private') continue;
      expect(src, `${v} 的文案应来自 {VISIBILITY_BADGE.${v}}`).toContain(
        `{VISIBILITY_BADGE.${v}}`
      );
    }
    // 反向：确认没有把中文短语直接抄进 JSX（抄了上面那条还是过的，因为分子也在）
    expect(src, '别把短标记文案直接写进 JSX').not.toContain(`>${VISIBILITY_BADGE.public}<`);
    expect(src, '别把短标记文案直接写进 JSX').not.toContain(`>${VISIBILITY_BADGE.link}<`);
  });
});

describe('可见性词汇的两张表', () => {
  it('短标记覆盖三档且互不相同（三档要能一眼分开）', () => {
    for (const v of BLOG_VISIBILITIES) {
      expect(VISIBILITY_BADGE[v], `${v} 缺短标记`).toBeTruthy();
      expect(VISIBILITY_LABEL[v], `${v} 缺短语标签`).toBeTruthy();
    }
    const badges = BLOG_VISIBILITIES.map((v) => VISIBILITY_BADGE[v]);
    expect(new Set(badges).size, '三个短标记不许重复').toBe(badges.length);
  });

  it('短标记确实比短语短 —— 它是给小胶囊用的', () => {
    for (const v of BLOG_VISIBILITIES) {
      expect(
        VISIBILITY_BADGE[v].length,
        `${v}：「${VISIBILITY_BADGE[v]}」不比短语「${VISIBILITY_LABEL[v]}」短，那就不该分成两张表`
      ).toBeLessThan(VISIBILITY_LABEL[v].length);
    }
  });
});
