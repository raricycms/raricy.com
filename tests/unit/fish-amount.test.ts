// fish-amount.ts —— 鱼干金额的展示与解析。
//
// 这里最容易搞混的是 fmtFish 与 fmtFishInput：一个**固定 4 位**（展示）、
// 一个**去尾零**（回填输入框）。混用的后果不是报错，而是「点一下 +1 按钮，
// 输入框里出现 1.0000」这种一眼看得出来但没人会写用例的毛病。

import { describe, it, expect } from 'vitest';
import {
  AMOUNT_ERROR,
  AMOUNT_RE,
  fmtFish,
  fmtFishInput,
  parseFishAmount,
  roundFish,
} from '@/lib/fish-amount';
import { FISH_DECIMALS } from '@/lib/fish-units';

describe('fmtFish（展示：固定 4 位小数）', () => {
  it('整数也补满 4 位（全站金额一个长相）', () => {
    expect(fmtFish(0)).toBe('0.0000');
    expect(fmtFish(1)).toBe('1.0000');
    expect(fmtFish(2045)).toBe('2045.0000');
  });

  it('小数补满 4 位', () => {
    expect(fmtFish(12.4)).toBe('12.4000');
    expect(fmtFish(0.0001)).toBe('0.0001');
    expect(fmtFish(109.89)).toBe('109.8900');
  });

  it('负数（支出流水）带号', () => {
    expect(fmtFish(-0.3)).toBe('-0.3000');
  });

  it('浮点残差被 toFixed 收敛掉', () => {
    expect(fmtFish(0.1 + 0.2)).toBe('0.3000');
    expect(fmtFish(1.005)).toBe('1.0050');
  });
});

describe('fmtFishInput（回填输入框：去尾零）', () => {
  it('整数不带小数点', () => {
    expect(fmtFishInput(1)).toBe('1');
    expect(fmtFishInput(2045)).toBe('2045');
  });

  it('有小数就保留，但去掉无意义的尾零', () => {
    expect(fmtFishInput(1.5)).toBe('1.5');
    expect(fmtFishInput(0.0001)).toBe('0.0001');
  });

  it('与 fmtFish 是两种形态（写这个用例就是为了钉住这个区别）', () => {
    expect(fmtFish(1)).not.toBe(fmtFishInput(1));
  });
});

describe('roundFish（4 位小数收敛）', () => {
  it('把 double 的渣收掉', () => {
    expect(roundFish(0.3 - 0.1)).toBe(0.2);
    expect(roundFish(0.1 + 0.2)).toBe(0.3);
  });

  it('4 位以内的值原样返回', () => {
    expect(roundFish(2045)).toBe(2045);
    expect(roundFish(0.0001)).toBe(0.0001);
  });
});

describe('parseFishAmount / AMOUNT_RE', () => {
  it('接受正整数与最多 4 位小数', () => {
    expect(parseFishAmount('1')).toBe(1);
    expect(parseFishAmount('1.5')).toBe(1.5);
    expect(parseFishAmount('0.0001')).toBe(0.0001);
    expect(parseFishAmount(' 12.3456 ')).toBe(12.3456); // 两侧空白会 trim
  });

  it('超过 4 位小数被拒（与服务端 fishToUnits 同口径）', () => {
    expect(parseFishAmount('0.00001')).toBeNull();
    expect(parseFishAmount('1.23456')).toBeNull();
  });

  it('非数字/空/负号/科学计数法一律 null', () => {
    for (const bad of ['', '  ', 'abc', '-1', '1.', '.5', '1e3', '1,000', '+1', 'Infinity']) {
      expect(parseFishAmount(bad), `应拒绝 ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('AMOUNT_RE 的位数由 FISH_DECIMALS 插值而来（不会各自漂移）', () => {
    expect(AMOUNT_RE.test('1.' + '0'.repeat(FISH_DECIMALS))).toBe(true);
    expect(AMOUNT_RE.test('1.' + '0'.repeat(FISH_DECIMALS + 1))).toBe(false);
  });

  it('错误文案里的位数与常量一致', () => {
    expect(AMOUNT_ERROR).toContain(String(FISH_DECIMALS));
  });
});
