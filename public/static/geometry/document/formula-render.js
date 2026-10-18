/* ============================================================
   formula-render.js —— 表达式 → DOM 渲染（公共）
   ------------------------------------------------------------
   提取自 monomial.html 的“输出公式渲染”一节
   （distance2/3、linedistance2、tetrahedron 四个页面里是它的小子集）。

   与 monomial.html 内联版本相比是超集：
     · 顶层乘除 a*b/c 会渲染成 “a · b ÷ c”（原距离页面不拆乘除）
     · 幂的底数遇到和式/乘积/根式/幂时自动补括号
     · 支持 |x| 绝对值节点
   原先各页面的渲染结果都能正确渲染，只是排版更接近 monomial.html。

   依赖：document/polynomial.js（提供 Polynomial.splitTopLevel / parseValueString /
        isWrapped / unwrapOuterParens），monomial.js 由 polynomial.js 内部使用
   用法：<script src="./document/formula-render.js"></script>
        FormulaRender.setResult(document.getElementById('result'), '2/3');
   ============================================================ */

const FormulaRender = (function () {
  'use strict';

  function engine() {
    if (typeof Polynomial === 'undefined') {
      throw new Error('formula-render.js 依赖 Polynomial，请先引入 document/polynomial.js');
    }
    return Polynomial;
  }

  // 顶层切分（容错：括号不匹配等异常时返回 null，避免渲染直接抛错）
  function topLevelParts(expr, ops) {
    try {
      const parts = engine().splitTopLevel(expr, ops);
      return parts.length > 1 ? parts : null;
    } catch (err) {
      return null;
    }
  }

  function isSumExpr(expr) {
    return !!topLevelParts(expr, ['+', '-']);
  }

  function isProductExpr(expr) {
    return !!topLevelParts(expr, ['*', '/']);
  }

  // 把渲染结果包进圆括号
  function wrapInParens(node) {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode('('));
    frag.appendChild(node);
    frag.appendChild(document.createTextNode(')'));
    return frag;
  }

  // 渲染乘积/商中的一个因子，必要时补括号（如 (1 + √2) · √3）
  function renderFactor(expr) {
    expr = (expr || '').trim();
    if (!expr) return document.createTextNode('');

    if (expr.startsWith('-')) {
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode('−'));
      frag.appendChild(renderFactor(expr.substring(1).trim()));
      return frag;
    }
    if (expr.startsWith('+')) {
      return renderFactor(expr.substring(1).trim());
    }
    if (engine().isWrapped(expr)) {
      const inner = engine().unwrapOuterParens(expr);
      if (isSumExpr(inner) || inner.startsWith('-')) {
        return wrapInParens(render(inner));
      }
      return renderFactor(inner);
    }
    if (isSumExpr(expr)) {
      return wrapInParens(render(expr));
    }
    return render(expr);
  }

  // 渲染幂的底数（和式、乘积、根式、幂、负号都要加括号，避免 √2² 这类歧义）
  function renderBase(expr) {
    expr = (expr || '').trim();
    if (!expr) return document.createTextNode('');
    if (expr.startsWith('-')) return wrapInParens(render(expr));
    const inner = engine().isWrapped(expr) ? engine().unwrapOuterParens(expr) : expr;
    if (isSumExpr(inner) || isProductExpr(inner)) {
      return wrapInParens(render(inner));
    }
    const ast = engine().parseValueString(inner);
    if (ast.type === 'radical' || ast.type === 'sqrt' ||
        ast.type === 'root' || ast.type === 'power') {
      return wrapInParens(render(inner));
    }
    return render(inner);
  }

  // 核心：把一个表达式字符串渲染成 DOM 片段
  function render(expr) {
    expr = (expr || '').trim();
    if (!expr) return document.createTextNode('');

    // 顶层加减：a + b − c
    const addSub = topLevelParts(expr, ['+', '-']);
    if (addSub) {
      const frag = document.createDocumentFragment();
      addSub.forEach((part, i) => {
        if (i > 0) {
          frag.appendChild(document.createTextNode(part.op === '+' ? ' + ' : ' − '));
        }
        frag.appendChild(render(part.value));
      });
      return frag;
    }

    // 顶层乘除：a · b ÷ c
    const mulDiv = topLevelParts(expr, ['*', '/']);
    if (mulDiv) {
      const frag = document.createDocumentFragment();
      mulDiv.forEach((part, i) => {
        if (i > 0) {
          frag.appendChild(document.createTextNode(part.op === '*' ? ' · ' : ' ÷ '));
        }
        frag.appendChild(renderFactor(part.value));
      });
      return frag;
    }

    // 一元负号 / 正号
    if (expr.startsWith('-')) {
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode('−'));
      frag.appendChild(renderFactor(expr.substring(1).trim()));
      return frag;
    }
    if (expr.startsWith('+')) {
      return render(expr.substring(1).trim());
    }

    // 整体被一对括号包住
    if (engine().isWrapped(expr)) {
      return wrapInParens(render(engine().unwrapOuterParens(expr)));
    }

    const ast = engine().parseValueString(expr);

    switch (ast.type) {
      case 'fraction': {
        if (ast.denominator === '1') return render(ast.numerator);
        const frac = document.createElement('span');
        frac.className = 'render-fraction';
        const num = document.createElement('span');
        num.className = 'render-num';
        num.appendChild(render(ast.numerator));
        const bar = document.createElement('span');
        bar.className = 'render-bar';
        const den = document.createElement('span');
        den.className = 'render-den';
        den.appendChild(render(ast.denominator));
        frac.appendChild(num);
        frac.appendChild(bar);
        frac.appendChild(den);
        return frac;
      }
      case 'power': {
        const power = document.createElement('span');
        power.className = 'render-power';
        const base = document.createElement('span');
        base.className = 'render-base';
        base.appendChild(renderBase(ast.base));
        const exp = document.createElement('sup');
        exp.className = 'render-exp';
        exp.appendChild(render(ast.exponent));
        power.appendChild(base);
        power.appendChild(exp);
        return power;
      }
      case 'radical': {
        const wrap = document.createElement('span');
        wrap.className = 'render-root';
        const coef = Number(ast.coef);
        if (coef === -1) {
          wrap.appendChild(document.createTextNode('−'));
        } else if (coef !== 1 && !Number.isNaN(coef)) {
          wrap.appendChild(document.createTextNode(coef < 0 ? '−' + Math.abs(coef) : String(coef)));
        } else if (Number.isNaN(coef)) {
          wrap.appendChild(document.createTextNode(String(ast.coef)));
        }
        if (ast.index !== 2) {
          const idx = document.createElement('sup');
          idx.className = 'render-index';
          idx.textContent = ast.index;
          wrap.appendChild(idx);
        }
        wrap.appendChild(document.createTextNode('√'));
        const rad = document.createElement('span');
        rad.className = 'render-radicand';
        rad.appendChild(render(ast.radicand));
        wrap.appendChild(rad);
        return wrap;
      }
      case 'sqrt': {
        const sqrt = document.createElement('span');
        sqrt.className = 'render-sqrt';
        sqrt.appendChild(document.createTextNode('√'));
        const radicand = document.createElement('span');
        radicand.className = 'render-radicand';
        radicand.appendChild(render(ast.radicand));
        sqrt.appendChild(radicand);
        return sqrt;
      }
      case 'root': {
        const root = document.createElement('span');
        root.className = 'render-root';
        const index = document.createElement('sup');
        index.className = 'render-index';
        index.appendChild(render(ast.index));
        root.appendChild(index);
        root.appendChild(document.createTextNode('√'));
        const radicand = document.createElement('span');
        radicand.className = 'render-radicand';
        radicand.appendChild(render(ast.radicand));
        root.appendChild(radicand);
        return root;
      }
      case 'abs': {
        const abs = document.createElement('span');
        abs.className = 'render-abs';
        const left = document.createElement('span');
        left.className = 'render-abs-bar';
        left.textContent = '|';
        const inner = document.createElement('span');
        inner.className = 'render-abs-inner';
        inner.appendChild(render(ast.value));
        const right = document.createElement('span');
        right.className = 'render-abs-bar';
        right.textContent = '|';
        abs.appendChild(left);
        abs.appendChild(inner);
        abs.appendChild(right);
        return abs;
      }
      default:
        return document.createTextNode(ast.value);
    }
  }

  // 永不抛错的渲染入口：表达式有问题时退化为纯文本
  // （distance2/3、linedistance2、tetrahedron 里的 safeRender）
  function safe(expr) {
    try {
      return render(expr);
    } catch (err) {
      console.error(err);
      const span = document.createElement('span');
      span.textContent = expr;
      return span;
    }
  }

  // 渲染成元素节点（方便直接 append）
  function element(expr) {
    const span = document.createElement('span');
    span.className = 'render-expression';
    span.appendChild(safe(expr));
    return span;
  }

  // 把结果写进结果容器：清空 + [可选标签] + 渲染后的公式
  function setResult(container, expr, label) {
    if (!container) return null;
    container.innerHTML = '';
    if (label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'result-label';
      labelEl.textContent = label;
      container.appendChild(labelEl);
    }
    const node = safe(expr);
    container.appendChild(node);
    return node;
  }

  // 追加一个结果项（多结果页面用，配 .result-item / .result-value 样式）
  function addResultItem(container, label, expr) {
    if (!container) return null;
    const item = document.createElement('div');
    item.className = 'result-item';
    if (label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'result-label';
      labelEl.textContent = label;
      item.appendChild(labelEl);
    }
    const value = document.createElement('span');
    value.className = 'result-value';
    value.appendChild(safe(expr));
    item.appendChild(value);
    container.appendChild(item);
    return value;
  }

  return {
    render: render,          // 可能抛错，需要自己兜底
    safe: safe,              // 永不抛错（推荐）
    element: element,
    setResult: setResult,
    addResultItem: addResultItem,
    renderFactor: renderFactor,
    renderBase: renderBase,
    wrapInParens: wrapInParens,
    isSumExpr: isSumExpr,
    isProductExpr: isProductExpr,
    topLevelParts: topLevelParts
  };
})();
