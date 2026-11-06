// quota-view.test.ts —— R3-379 的对外契约：quotaView() 四个字段的取整口径
//
// 两条 quota 路由与两个媒体页此前各内联一遍同一公式；收成 upload-quota.ts 的
// quotaView() 之后，这里钉住「逐字不变」，避免以后调精度时改一处漏一处。
// 字段承诺见 docs/bot/image-bot.md:242-256 与 docs/bot/audio-bot.md:191-198。
import { describe, expect, it } from 'vitest';
import { quotaView } from '@/lib/upload-quota';

describe('quotaView —— 配额视图的唯一公式（对外契约）', () => {
  it('MB 两位小数、百分比一位小数', () => {
    // 10.5 MB / 50 MB：两个除法都能整除，断言的是取整表达式本身
    expect(quotaView(11010048, 50)).toEqual({
      used_mb: 10.5,
      limit_mb: 50,
      remaining_mb: 39.5,
      usage_percent: 21,
    });
  });

  it('已用为 0：全零、百分比 0', () => {
    expect(quotaView(0, 50)).toEqual({
      used_mb: 0,
      limit_mb: 50,
      remaining_mb: 50,
      usage_percent: 0,
    });
  });

  it('配额为 0：不除零，百分比直接给 100（与两条 quota 路由的原分支一致）', () => {
    expect(quotaView(123456, 0)).toEqual({
      used_mb: 0.12,
      limit_mb: 0,
      remaining_mb: 0,
      usage_percent: 100,
    });
  });

  it('已用超限：remaining_mb 夹到 0（不出现负数）', () => {
    expect(quotaView(53477376, 50)).toMatchObject({
      used_mb: 51,
      remaining_mb: 0,
      usage_percent: 102,
    });
  });
});
