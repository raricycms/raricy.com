// geometry-engines.test.ts —— 几何页共享符号引擎的**数值/加载契约**（R3-608）
//
// 【为什么需要】10 个几何页是纯静态 HTML + `<script>` 全局脚本，没有单测覆盖：
// 引擎改错（如指数被静默截断）只会在浏览器里给出错误结果，CI 全绿。这里用 vm
// 以页面同样的顺序加载 document/*.js，只钉两条真正会回归的契约：
//   1. `p()` / `root()` 的非整数指数/根指数必须**报错**，不能静默截断（R3-577）；
//   2. `derivative.js` 以浏览器全局脚本形态可加载并给出文档里的示例结果（R3-588
//      删掉 CJS 分支后的加载链、monomial → polynomial → derivative 的顺序）。
// 【刻意不做】不重画/不渲染 DOM、不逐条覆盖 10 个页面；视觉与布局靠页面目检。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOC = path.join(ROOT, 'public', 'static', 'geometry', 'document');

interface EngineSandbox {
  window: Record<string, unknown>;
  Polynomial: { simplifyExpression(expr: string): string };
  Derivative: {
    variables(expr: string): string[];
    derivative(expr: string, variable?: string): string;
    partial(expr: string, variable: string): string;
  };
  Monomial: unknown;
}

/** 按页面 `<script>` 的加载顺序把引擎装进一个 vm 上下文。 */
function loadEngines(): EngineSandbox {
  const sandbox: Record<string, unknown> = { console };
  sandbox.window = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const run = (name: string) => {
    const code = fs.readFileSync(path.join(DOC, name), 'utf8');
    vm.runInContext(code, sandbox, { filename: name });
  };
  run('monomial.js');
  // polynomial.js 用裸全局名 `Monomial`；浏览器里它是 monomial.js 的全局类。
  sandbox.Monomial = (sandbox.window as Record<string, unknown>).Monomial ?? sandbox.Monomial;
  run('polynomial.js');
  run('expression-eval.js');
  run('derivative.js');
  // 三个引擎都挂到 window 上（页面里就是用这些全局名调用）。
  const win = sandbox.window as Record<string, unknown>;
  return {
    window: win,
    Monomial: win.Monomial,
    Polynomial: win.Polynomial as EngineSandbox['Polynomial'],
    Derivative: win.Derivative as EngineSandbox['Derivative'],
  };
}

describe('几何页共享符号引擎', () => {
  const engines = loadEngines();

  it('p()/root() 的非整数指数与根指数必须报错（不是静默截断成 1）', () => {
    const exponent = engines.Polynomial.simplifyExpression('p(a,1/2)');
    expect(exponent, '非整数指数必须报「指数必须是整数」').toContain('指数必须是整数');

    const rootIndex = engines.Polynomial.simplifyExpression('root(1/2,4)');
    expect(rootIndex, '非整数根指数必须报错').toMatch(/根指数必须为(正整数|整数)/);
  });

  it('derivative.js 以浏览器全局脚本可加载，并给出文档示例结果', () => {
    expect(engines.Derivative, 'derivative.js 应把类挂到 window.Derivative').toBeTruthy();
    expect(engines.Derivative.variables('a^2*b + b^3').sort()).toEqual(['a', 'b']);
    // 文件头示例：3a^2+2a+1 → 6*a+2
    expect(engines.Derivative.derivative('3a^2+2a+1')).toBe('6*a+2');
    // 偏导：a^2*b+b^3 对 b → p(a,2)+3*p(b,2)
    expect(engines.Derivative.partial('a^2*b+b^3', 'b')).toBe('p(a,2)+3*p(b,2)');
  });
});
