// 每日一言的抽取纯函数：**先按作者 log(n+2) 权重抽作者，再在作者名下均匀抽一条**。
//
// 这里不碰数据库：随机源是显式参数，固定序列就能断言「抽中谁」，权重边界也按
// 公式算出来再验证，不靠概率采样（采样会随机器抖动，红了查不出是算法还是运气）。

import { describe, expect, it } from 'vitest';
import { pickWeightedQuote } from '@/lib/daily-quote';

const candidate = (id: string, submitterId: string | null) => ({ id, submitterId });

/** 依次吐出给定值的随机源；用完后一直返回 0（不该再多取）。 */
function sequence(...values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}

const weight = (n: number) => Math.log(n + 2);

describe('pickWeightedQuote：作者加权 + 作者内均匀', () => {
  it('空池返回 null；单作者时随机只决定组内第几条', () => {
    expect(pickWeightedQuote([], sequence(0, 0))).toBeNull();

    const pool = [candidate('a1', 'a'), candidate('a2', 'a'), candidate('a3', 'a')];
    expect(pickWeightedQuote(pool, sequence(0, 0))?.id).toBe('a1');
    expect(pickWeightedQuote(pool, sequence(0, 0.34))?.id).toBe('a2');
    expect(pickWeightedQuote(pool, sequence(0, 0.999999))?.id).toBe('a3');
    // 只有一组时，作者那一次随机取什么都还是同一位作者。
    expect(pickWeightedQuote(pool, sequence(0.99, 0.5))?.id).toBe('a2');
  });

  it('多作者：按累计权重落点选作者；越过边界就换人', () => {
    const pool = [candidate('a1', 'a'), candidate('a2', 'a'), candidate('a3', 'a'), candidate('b1', 'b')];
    const boundary = weight(3) / (weight(3) + weight(1));
    // 落点刚好在 a 的权重内 → a；越过 → b。组内第二次随机再挑条目。
    expect(pickWeightedQuote(pool, sequence(boundary * 0.999, 0.999999))?.id).toBe('a3');
    expect(pickWeightedQuote(pool, sequence(boundary * 1.001, 0))?.id).toBe('b1');
  });

  it('权重随作者稿件数对数增长，边际递减：9 条对 1 条远不到 9 倍机会', () => {
    const small = Array.from({ length: 9 }, (_, i) => candidate(`big${i}`, 'big'));
    const pool = [...small, candidate('solo', 'solo')];
    const nineVsOne = weight(9) / (weight(9) + weight(1));
    // 9:1 的稿件数只换来约 68.6% 的作者命中率，而不是 90%。
    expect(nineVsOne).toBeCloseTo(0.6858, 3);
    expect(pickWeightedQuote(pool, sequence(nineVsOne * 0.999, 0))?.id).toBe('big0');
    expect(pickWeightedQuote(pool, sequence(nineVsOne * 1.001, 0))?.id).toBe('solo');
  });

  it('组序 = 池内首次出现顺序；submitterId 为空的行归为同一组', () => {
    const pool = [
      candidate('none1', null), candidate('b1', 'b'), candidate('none2', null),
    ];
    // 空 id 是第一组（权重 log4），b 是第二组（log3）。
    const boundary = weight(2) / (weight(2) + weight(1));
    expect(pickWeightedQuote(pool, sequence(boundary * 0.999, 0))?.id).toBe('none1');
    expect(pickWeightedQuote(pool, sequence(boundary * 0.999, 0.999999))?.id).toBe('none2');
    expect(pickWeightedQuote(pool, sequence(boundary * 1.001, 0))?.id).toBe('b1');
  });
});
