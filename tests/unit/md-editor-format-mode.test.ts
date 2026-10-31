// md-editor/format-mode.test.ts —— 编辑器格式判定的**预筛**只有一条判据：
// 「肯定不含增强语法」。它不参与分类，所以这里只钉「不会把候选漏掉」。
//
// 真正的分类（markdown / reactive / invalid-enhanced）属于后端公共契约
// `@/lib/reactive/format-observer`，不在这里复制一份解析器。

import { describe, expect, it } from 'vitest';
import { mightContainReactiveSyntax } from '@/lib/md-editor/format-mode';

describe('mightContainReactiveSyntax：只做「肯定不含」的排除', () => {
  it('纯文本 / 普通 Markdown 不触发分析', () => {
    expect(mightContainReactiveSyntax('')).toBe(false);
    expect(mightContainReactiveSyntax('# 标题\n\n**粗体** 与 [链接](https://x.y)')).toBe(false);
    expect(mightContainReactiveSyntax('单行公式 $x^2$ 与代码 `a + b`')).toBe(false);
  });

  it('组件、插值、声明、版本指令都算候选', () => {
    expect(mightContainReactiveSyntax('<slider bind="a">')).toBe(true);
    expect(mightContainReactiveSyntax('人数：{{ people }}')).toBe(true);
    expect(mightContainReactiveSyntax('<theme primary="#fff"></theme>')).toBe(true);
    expect(mightContainReactiveSyntax('<!-- reactive-md: local-draft-3 -->')).toBe(true);
  });

  it('代码块里的示例也会触发（宁可多分析，绝不漏判）', () => {
    expect(mightContainReactiveSyntax('```\n<slider bind="a">\n```')).toBe(true);
  });
});
