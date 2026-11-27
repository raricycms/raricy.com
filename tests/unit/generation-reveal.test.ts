// ─────────────────────────────────────────────────────────────────────────────
// generation-reveal.test.ts — 生成预览的分步显示计划
//
// 服务端快照 200ms 一帧，前端按两个累计进度点显示，视觉维持约 10 帧/秒。
// 这里只钉住纯计划的边界：追加、源码被替换、无变化、单步显示（减少动态效果）、
// 以及不拆代理对/组合表情。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  GENERATION_REVEAL_STEPS,
  planGenerationReveal,
} from '@/app/chat/generation-reveal';

describe('planGenerationReveal', () => {
  it('把新增后缀切成两个累计进度点，最后一步等于目标', () => {
    expect(GENERATION_REVEAL_STEPS).toBe(2);
    expect(planGenerationReveal('ab', 'abcdef')).toEqual(['abcd', 'abcdef']);
  });

  it('源码被完整替换 / 回退时直接对齐最新版，不播放旧中间态', () => {
    expect(planGenerationReveal('旧正文', '全新正文')).toEqual(['全新正文']);
    expect(planGenerationReveal('abc', 'ab')).toEqual(['ab']);
  });

  it('已经是最新版时不需要更新', () => {
    expect(planGenerationReveal('abc', 'abc')).toEqual([]);
  });

  it('steps=1（减少动态效果）时一步显示到目标', () => {
    expect(planGenerationReveal('a', 'abc', 1)).toEqual(['abc']);
  });

  it('不拆代理对或组合表情', () => {
    const steps = planGenerationReveal('a', 'a😀b');
    expect(steps).toEqual(['a😀', 'a😀b']);
    // 中间态必须仍是目标的合法前缀；出现孤立代理项会让浏览器闪替换符。
    for (const step of steps) {
      expect('a😀b'.startsWith(step)).toBe(true);
      expect(step).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('新增不足一个可分单位时直接显示目标', () => {
    expect(planGenerationReveal('', '甲')).toEqual(['甲']);
  });
});