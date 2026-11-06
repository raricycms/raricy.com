// 几何工具页的共享求值层（public/static/geometry/document/expression-eval.js）。
//
// 钉 R3-573 / R3-575：
//   · monomial.js 化简失败时**不抛错**、返回 `错误: …` 串；共享层必须把它当错误
//     上抛，不能当坐标继续算（四面体曾把 `1.5+2` 的错误串静默算成 1.5）。
//   · 四面体的数值求值器曾只认 d/sqrt/root；monomial 的输出语法 r()/p()/abs()
//     必须能求值（键盘上的 √ / ⁿ√ / 幂 结果）。
//
// 两个脚本都是浏览器全局 + `module.exports` 双出口，这里按真实加载顺序：
// 先 monomial.js（挂 globalThis.Monomial），再 expression-eval.js。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const GEOMETRY_DIR = path.resolve(import.meta.dirname, '../../public/static/geometry/document');

function loadScript(file: string): Record<string, unknown> {
  const src = fs.readFileSync(path.join(GEOMETRY_DIR, file), 'utf-8');
  const mod = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

interface EvalApi {
  isErrorText(value: unknown): boolean;
  normalizeCoord(expr: string): string;
  evaluate(expression: string): number;
}

const Monomial = loadScript('monomial.js') as unknown;
(globalThis as Record<string, unknown>).Monomial = Monomial;
const Eval = loadScript('expression-eval.js') as unknown as EvalApi;

describe('normalizeCoord：化简失败必须上抛（R3-573）', () => {
  it('空输入按 0', () => {
    expect(Eval.normalizeCoord('')).toBe('0');
    expect(Eval.normalizeCoord('   ')).toBe('0');
  });

  it('合法表达式照常化简', () => {
    expect(Eval.normalizeCoord('2+3')).toBe('d(5,1)');
    expect(Eval.normalizeCoord('a^2')).toBe('p(a,2)');
  });

  it('小数坐标（引擎不支持）不再被当原样坐标使用', () => {
    expect(() => Eval.normalizeCoord('1.5')).toThrow(/无效表达式/);
    expect(() => Eval.normalizeCoord('1.5+2')).toThrow(/无效表达式/);
  });

  it('不完整表达式上抛受控错误', () => {
    expect(() => Eval.normalizeCoord('2+')).toThrow(/无效表达式/);
  });

  it('isErrorText 识别引擎的错误串', () => {
    expect(Eval.isErrorText('错误: 无效表达式: 2+')).toBe(true);
    expect(Eval.isErrorText('错误：分母不能为零')).toBe(true);
    expect(Eval.isErrorText('d(1,2)')).toBe(false);
  });
});

describe('evaluate：认全 monomial 输出语法（R3-575）', () => {
  it('分式 d(a,b)', () => {
    expect(Eval.evaluate('d(1,2)')).toBe(0.5);
  });

  it('幂 p(base,exp)', () => {
    expect(Eval.evaluate('p(2,3)')).toBe(8);
    expect(Eval.evaluate('p(2,-2)')).toBe(0.25);
  });

  it('根式 r(coef,radicand,index)', () => {
    expect(Eval.evaluate('r(1,2,2)')).toBeCloseTo(Math.SQRT2, 12);
    expect(Eval.evaluate('r(2,2,2)')).toBeCloseTo(2 * Math.SQRT2, 12);
    expect(Eval.evaluate('r(1,-8,3)')).toBeCloseTo(-2, 12);
  });

  it('sqrt / root', () => {
    expect(Eval.evaluate('sqrt(2)')).toBeCloseTo(Math.SQRT2, 12);
    expect(Eval.evaluate('root(3,8)')).toBeCloseTo(2, 12);
    expect(Eval.evaluate('root(2,16)')).toBeCloseTo(4, 12);
  });

  it('abs', () => {
    expect(Eval.evaluate('abs(-3)')).toBe(3);
    expect(Eval.evaluate('2*abs(-3)')).toBe(6);
  });

  it('四则/括号/一元负号与幂的优先级', () => {
    expect(Eval.evaluate('(1+2)*3')).toBe(9);
    expect(Eval.evaluate('-2^2')).toBe(-4);
    expect(Eval.evaluate('2+3*4')).toBe(14);
  });

  it('错误串在入口被拒绝，不会被当数值', () => {
    expect(() => Eval.evaluate('错误: 无效表达式: 2+')).toThrow(/无效表达式/);
  });

  it('参数个数不对时给出受控错误', () => {
    expect(() => Eval.evaluate('r(1,2)')).toThrow(/需要 3 个参数/);
    expect(() => Eval.evaluate('sqrt(1,2)')).toThrow(/需要 1 个参数/);
  });
});
