// ─────────────────────────────────────────────────────────────────────────────
// image-compress.test.ts —— 压缩前的「是不是动画」判定（R3-371）
//
// 【为什么只测这个纯函数】动画 WebP / APNG 被 sharp 压缩时只输出首帧，是**静默
// 丢帧**：没有报错、图还能开，只有作者看得出「动图不动了」。压缩路径本身依赖
// sharp 原生编解码，单测里造真实动图样本成本高且脆；这里钉住判定规则，压缩调用
// 点（`compressImage`）在 meta.pages>1 时原样返回，由类型与代码审查保证接线。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { isAnimatedImage } from '@/lib/image-upload';

describe('isAnimatedImage', () => {
  it('pages > 1 视为动画（动画 WebP / APNG / 多页图）', () => {
    expect(isAnimatedImage({ pages: 2 })).toBe(true);
    expect(isAnimatedImage({ pages: 24 })).toBe(true);
  });

  it('单帧图与缺省 pages 不跳过压缩', () => {
    expect(isAnimatedImage({ pages: 1 })).toBe(false);
    expect(isAnimatedImage({})).toBe(false);
    expect(isAnimatedImage({ pages: null })).toBe(false);
  });
});
