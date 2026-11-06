// ─────────────────────────────────────────────────────────────────────────────
// expression-eval.js — 几何工具页共用的「坐标规范化」与「数值求值」。
//
// 【为什么单独成文件】这两件事原先在 distance2 / distance3 / linedistance2 /
// tetrahedron 四个页面里各有一份内联副本，且都踩过同一类坑：
//   · monomial.js 的 simplifyExpression **不抛错**，失败时返回 `错误: …` 字符串；
//     页面把它当坐标拼进表达式，四面体页的求值器又会把中文与冒号静默丢掉，
//     于是 `1.5+2` 的错误串里只剩 `1.5` 被当坐标（R3-573）。
//   · 四面体页的数值求值器只认 d/sqrt/root，认不出 monomial 的输出语法
//     r()/p()/abs()，键盘上的 √ / ⁿ√ / 幂 结果一律报「格式错误」（R3-575）。
//
// 依赖：必须在 monomial.js **之后**加载（用全局 Monomial）。
// 同时暴露 `window.ExpressionEval` 与 `module.exports`，node 单测可直接 require。
// ─────────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  var ERROR_RE = /^错误[:：]/;

  function isErrorText(value) {
    return typeof value === 'string' && ERROR_RE.test(value.trim());
  }

  // 把一段坐标表达式化简成规范字符串；空输入按 0 处理。
  // 化简失败（返回 `错误: …`）时**抛错**，由调用方统一显示受控提示 ——
  // 绝不把错误串当坐标继续算。
  function normalizeCoord(expr) {
    var s = (expr || '').trim();
    if (!s) return '0';
    var r = root.Monomial.simplifyExpression(s);
    var rs = (r === undefined || r === null) ? '' : String(r).trim();
    if (!rs) throw new Error('坐标表达式无效');
    if (isErrorText(rs)) {
      // 引擎的错误串文案不统一（`无效表达式: …` / `空表达式` / `数值过大`），
      // 统一补上「无效表达式：」前缀，页面直接显示 `错误：无效表达式：…`。
      var detail = rs.replace(ERROR_RE, '').trim();
      throw new Error(/^无效表达式/.test(detail) ? detail : '无效表达式：' + detail);
    }
    return rs;
  }

  // 把 monomial.js 的输出语法（d/p/r/sqrt/root/abs）求成有限实数。
  // 文法与四面体页原先的内联实现一致（递归下降），只把函数分发扩到完整词表。
  function evaluate(expression) {
    if (isErrorText(expression)) {
      throw new Error(String(expression).replace(ERROR_RE, '').trim());
    }

    var tokens = String(expression).match(
      /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-zA-Z_]+|[()+\-*/^,]/gi
    ) || [];

    var ts = tokens.filter(function (t) { return !/^\s+$/.test(t); });
    var pos = 0;

    function peek() { return ts[pos]; }
    function consume() { return ts[pos++]; }

    function expect(value) {
      if (consume() !== value) throw new Error('表达式格式错误');
    }

    function primary() {
      var token = consume();
      if (!token) throw new Error('表达式不完整');

      // 数字
      if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
        return Number(token);
      }

      // 括号
      if (token === '(') {
        var value = addSub();
        expect(')');
        return value;
      }

      // 函数：monomial 的输出语法 + 键盘直出的写法
      if (/^[a-zA-Z_]+$/.test(token)) {
        var name = token.toLowerCase();
        expect('(');
        var args = [addSub()];
        while (peek() === ',') {
          consume();
          args.push(addSub());
        }
        expect(')');

        function arity(n) {
          if (args.length !== n) throw new Error('函数 ' + name + ' 需要 ' + n + ' 个参数');
        }

        switch (name) {
          case 'd':
            arity(2);
            if (args[1] === 0) throw new Error('分母不能为零');
            return args[0] / args[1];
          case 'p':
            arity(2);
            return Math.pow(args[0], args[1]);
          case 'sqrt':
            arity(1);
            if (args[0] < 0) throw new Error('负数不能开平方');
            return Math.sqrt(args[0]);
          case 'root': {
            arity(2);
            var k = args[0], x = args[1];
            if (!Number.isInteger(k) || k === 0) throw new Error('根指数必须为非零整数');
            if (x < 0) {
              if (Math.abs(k % 2) === 0) throw new Error('负数没有实偶次根');
              return -Math.pow(-x, 1 / k);
            }
            return Math.pow(x, 1 / k);
          }
          case 'r': {
            arity(3);
            var coef = args[0], radicand = args[1], index = args[2];
            if (!Number.isInteger(index) || index === 0) throw new Error('根指数必须为非零整数');
            if (radicand < 0) {
              if (Math.abs(index % 2) === 0) throw new Error('负数没有实偶次根');
              return coef * -Math.pow(-radicand, 1 / index);
            }
            return coef * Math.pow(radicand, 1 / index);
          }
          case 'abs':
            arity(1);
            return Math.abs(args[0]);
          default:
            throw new Error('不支持的函数：' + name);
        }
      }

      throw new Error('无法识别表达式：' + token);
    }

    function power() {
      var value = primary();
      if (peek() === '^') {
        consume();
        value = Math.pow(value, unary());
      }
      return value;
    }

    function unary() {
      if (peek() === '+') { consume(); return unary(); }
      if (peek() === '-') { consume(); return -unary(); }
      return power();
    }

    function mulDiv() {
      var value = unary();
      while (peek() === '*' || peek() === '/') {
        var op = consume();
        var next = unary();
        value = op === '*' ? value * next : value / next;
      }
      return value;
    }

    function addSub() {
      var value = mulDiv();
      while (peek() === '+' || peek() === '-') {
        var op = consume();
        var next = mulDiv();
        value = op === '+' ? value + next : value - next;
      }
      return value;
    }

    var result = addSub();
    if (pos !== ts.length || !Number.isFinite(result)) {
      throw new Error('表达式无法得到有限实数');
    }
    return result;
  }

  var api = { isErrorText: isErrorText, normalizeCoord: normalizeCoord, evaluate: evaluate };
  root.ExpressionEval = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
