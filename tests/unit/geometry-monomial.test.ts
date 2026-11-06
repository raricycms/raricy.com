// 几何工具的表达式求值器（public/static/geometry/document/monomial.js）。
//
// 【为什么能单测】该文件末尾有 `module.exports = Monomial`（浏览器侧同时挂 window），
// 所以这里用 `new Function` 直接加载真实脚本，不复制实现、不 mock。
//
// 钉的是 R3-571 / R3-572：
//   · `a^-2` 曾被切成 `a^`/`2` → 「空表达式」；
//   · `2a^2` 曾把底数整串 `2a` 一起平方 → 静默得到 4a²（应为 2a²）；
//   · `a(b+1)` 曾被当未知函数 `a` → 报错；
//   · `p(10,400)` 曾输出 `d(Infinity,1)`，`d(p(10,400),2)` 在 gcd 里栈溢出。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../public/static/geometry/document/monomial.js'),
  'utf-8'
);

interface MonomialEngine {
  simplifyExpression(expr: string): string;
}

function loadEngine(): MonomialEngine {
  const mod = { exports: {} as MonomialEngine };
  new Function('module', 'exports', SRC)(mod, mod.exports);
  return mod.exports;
}

const M = loadEngine();
const simplify = (expr: string) => M.simplifyExpression(expr);

describe('R3-571：幂与隐式乘法的优先级', () => {
  it('a^-2 不再被一元负号切断（等价于 1/a²）', () => {
    const got = simplify('a^-2');
    expect(got).not.toContain('错误');
    expect(got).toBe(simplify('d(1,p(a,2))'));
  });

  it('2a^2 = 2·(a²)，不是 (2a)²', () => {
    expect(simplify('2a^2')).toBe(simplify('2*p(a,2)'));
    expect(simplify('2a^2')).not.toBe(simplify('4*p(a,2)'));
  });

  it('ab^2 = a·(b²)', () => {
    expect(simplify('ab^2')).toBe(simplify('a*p(b,2)'));
  });

  it('a(b+1) 走隐式乘法而不是「未知函数: a」', () => {
    const got = simplify('a(b+1)');
    expect(got).not.toContain('未知函数');
    expect(got).toBe(simplify('a*(b+1)'));
  });

  it('既有正确输入结果不变（回归）', () => {
    expect(simplify('a^2')).toBe('p(a,2)');
    expect(simplify('a^3')).toBe('p(a,3)');
    expect(simplify('2a')).toBe('2*a');
    expect(simplify('a+b')).toBe('a+b');
    expect(simplify('(a+b)^2')).toBe(simplify('p(a,2)+2*a*b+p(b,2)'));
    expect(simplify('-a^2')).toBe(simplify('-p(a,2)'));
    expect(simplify('(2a)^2')).toBe(simplify('4*p(a,2)'));
    expect(simplify('sqrt(4)')).toBe('d(2,1)');
    expect(simplify('sqrt(2)')).toBe('r(1,2,2)');
    expect(simplify('d(1,2)+d(1,3)')).toBe('d(5,6)');
  });
});

describe('R3-572：幂/乘的数值护栏', () => {
  it('p(10,400) 返回受控错误而不是 d(Infinity,1)', () => {
    const got = simplify('p(10,400)');
    expect(got).toContain('数值过大');
    expect(got).not.toContain('Infinity');
  });

  it('d(p(10,400),2) 不再在 gcd 里栈溢出', () => {
    const got = simplify('d(p(10,400),2)');
    expect(got).toContain('数值过大');
    expect(got).not.toContain('Maximum call stack');
  });

  it('两个大幂相乘同样受控', () => {
    expect(simplify('p(10,200)*p(10,200)')).toContain('数值过大');
  });
});
