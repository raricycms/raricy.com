import { describe, expect, it } from 'vitest';
import { hasLegacyMathDelimiters } from '@/lib/reactive/legacy-math';

describe('legacy backslash math observation', () => {
  const cases: Array<[string, boolean]> = [
    [String.raw`行内 \(x_1+y_2\)`, true],
    [String.raw`块级 \[x^2+y^2\]`, true],
    ['`\\(x\\)` 放在行内代码里', false],
    ['```\n\\(x\\)\n```', false],
    [String.raw`\\(x\\)`, false],
    [String.raw`孤立 \( 不算数学`, false],
    ['普通正文 $x^2$', false],
  ];

  it.each(cases)('%s → %s', (source, expected) => {
    expect(hasLegacyMathDelimiters(source)).toBe(expected);
  });
});
