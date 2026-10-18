/* ============================================================
 * derivative.js —— 含参多项式的求导
 * ------------------------------------------------------------
 * 依赖（浏览器中先加载，Node 中自动 require）：
 *   document/monomial.js    单项式 / 符号运算
 *   document/polynomial.js  多项式规范化与输出
 *
 * 输入：
 *   含参多项式（幂、根式、绝对值、有理式；不含三角/指数/对数函数）。
 *   参数为单个字母（例如 a、b、h、x、y），最多三个（底层引擎的限制）。
 *   支持 + - * / ^、括号、隐式乘法，以及 p()、d()、sqrt()、
 *   root()、r()、abs() 这些引擎内部写法。
 *   例如：3a^2b + 2ab + 1、sqrt(2)*x、p(a,3)-a/b
 *
 * 输出（沿用计算器的内部语法，可直接交给 FormulaRender）：
 *   2a^2+3a+1      对唯一参数求导  ->  4*a+3
 *   a^2*b+b^3      对 b 求偏导     ->  p(a,2)+3*p(b,2)
 *
 * 用法：
 *   const Derivative = require('./derivative.js');
 *   Derivative.derivative('3a^2+2a+1');       // '6*a+2'
 *   Derivative.partial('a^2*b+b^3', 'b');     // 'p(a,2)+3*p(b,2)'
 *
 *   浏览器：
 *   <script src="./document/monomial.js"></script>
 *   <script src="./document/polynomial.js"></script>
 *   <script src="./derivative.js"></script>
 *   <script>Derivative.derivative('a^2+1')</script>
 * ============================================================ */

(function (root, factory) {
  'use strict';

  if (typeof module !== 'undefined' && module.exports) {
    const Monomial = require('./document/monomial.js');
    // polynomial.js 内部直接引用全局 Monomial，先挂到全局再加载。
    if (typeof globalThis !== 'undefined') {
      globalThis.Monomial = Monomial;
    }
    const Polynomial = require('./document/polynomial.js');
    module.exports = factory(Monomial, Polynomial);
  } else {
    root.Derivative = factory(root.Monomial, root.Polynomial);
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this),
  function (Monomial, Polynomial) {
    'use strict';

  if (!Monomial || !Polynomial) {
    throw new Error('derivative.js 需要先加载 document/monomial.js 和 document/polynomial.js');
  }

  const FUNCTIONS = new Set(['p', 'd', 'r', 'sqrt', 'root', 'abs']);
  const TRIG_FUNCTIONS = new Set([
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'arcsin', 'arccos', 'arctan', 'arccot',
    'asin', 'acos', 'atan', 'acot',
    'sinh', 'cosh', 'tanh', 'coth',
    'sh', 'ch', 'th'
  ]);
  const EXP_LOG_FUNCTIONS = new Set(['exp', 'ln', 'log', 'lg', 'log2', 'log10']);

  // ============================================================
  // 一、词法分析
  // ============================================================

  function isDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  function isLetter(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }

  function normalizeInput(expression) {
    return String(expression == null ? '' : expression)
      .replace(/[−–—]/g, '-')
      .replace(/[×·⋅]/g, '*')
      .replace(/[÷]/g, '/')
      .trim();
  }

  function tokenize(expression) {
    const text = normalizeInput(expression);
    if (!text) throw new Error('表达式不能为空');

    const tokens = [];
    let i = 0;

    function pushIdentifier(name, isCall) {
      if (isCall) {
        tokens.push({ type: 'id', value: name, call: true });
        return;
      }

      // 连续字母按隐式乘法拆成单字母参数：ab -> a*b。
      // 不带括号的函数名（sqrt 等）也按字母拆开，由后面的语法检查报错。
      let j = 0;
      while (j < name.length) {
        if (isLetter(name[j])) {
          tokens.push({ type: 'id', value: name[j], call: false });
          j++;
        } else if (isDigit(name[j])) {
          let k = j;
          while (k < name.length && isDigit(name[k])) k++;
          tokens.push({ type: 'num', value: name.slice(j, k) });
          j = k;
        } else {
          throw new Error(`无法识别的字符：${name[j]}`);
        }
      }
    }

    while (i < text.length) {
      const ch = text[i];

      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
        let j = i;
        let dot = false;
        while (j < text.length) {
          if (isDigit(text[j])) {
            j++;
          } else if (text[j] === '.' && !dot) {
            dot = true;
            j++;
          } else {
            break;
          }
        }
        if (text[j] === '.') {
          throw new Error(`无效数字：${text.slice(i, j + 1)}`);
        }

        tokens.push({ type: 'num', value: text.slice(i, j) });
        i = j;
        continue;
      }

      if (isLetter(ch)) {
        let j = i;
        while (j < text.length && (isLetter(text[j]) || isDigit(text[j]) || text[j] === '_')) {
          j++;
        }
        const name = text.slice(i, j);

        if (name.includes('_')) {
          throw new Error('参数名只能使用单个字母');
        }

        let k = j;
        while (k < text.length && /\s/.test(text[k])) k++;
        const followedByParen = text[k] === '(';

        // 只有函数名才按调用处理；a(b+c) 里的 a 仍是参数，走隐式乘法。
        const isCall = followedByParen && (
          FUNCTIONS.has(name) ||
          TRIG_FUNCTIONS.has(name) ||
          EXP_LOG_FUNCTIONS.has(name) ||
          name.length > 1
        );

        if (isCall) {
          tokens.push({ type: 'id', value: name, call: true });
        } else {
          pushIdentifier(name, false);
        }

        i = j;
        continue;
      }

      if ('+-*/^(),'.includes(ch)) {
        tokens.push({ type: 'op', value: ch });
        i++;
        continue;
      }

      throw new Error(`无法识别的字符：${ch}`);
    }

    tokens.push({ type: 'eof', value: '' });
    return tokens;
  }

  // ============================================================
  // 二、语法分析：表达式 -> Monomial 的 SValue
  // ============================================================

  class Parser {
    constructor(expression) {
      this.expression = expression;
      this.tokens = tokenize(expression);
      this.pos = 0;
      this.engine = new Monomial('0');
      this.polynomial = new Polynomial('0');

      this.variableMap = new Map();   // 原参数名 -> 内部 a/b/h
      this.reverseMap = new Map();    // 内部 a/b/h -> 原参数名
    }

    peek(offset = 0) {
      return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    }

    consume() {
      return this.tokens[this.pos++];
    }

    match(value) {
      if (this.peek().value === value) {
        this.consume();
        return true;
      }
      return false;
    }

    expect(value) {
      if (!this.match(value)) {
        const t = this.peek();
        throw new Error(`缺少 “${value}”${t.type === 'eof' ? '（表达式不完整）' : ''}`);
      }
    }

    // 把原参数名映射到引擎支持的 a/b/h，最多三个参数
    mapVariable(name) {
      if (this.variableMap.has(name)) return this.variableMap.get(name);

      if (this.variableMap.size >= Monomial.PARAMS.length) {
        throw new Error(
          `参数过多：引擎最多支持 ${Monomial.PARAMS.length} 个参数（当前已出现 ${Array.from(this.variableMap.keys()).join('、')}）`
        );
      }

      const internal = Monomial.PARAMS[this.variableMap.size];
      this.variableMap.set(name, internal);
      this.reverseMap.set(internal, name);
      return internal;
    }

    parse() {
      const value = this.parseAddSub();
      if (this.peek().type !== 'eof') {
        throw new Error(`表达式末尾多余内容：${this.peek().value}`);
      }
      return value;
    }

    parseAddSub() {
      let value = this.parseMulDiv();

      while (this.peek().value === '+' || this.peek().value === '-') {
        const op = this.consume().value;
        const right = this.parseMulDiv();
        value = op === '+'
          ? this.engine.sAdd(value, right)
          : this.engine.sSub(value, right);
      }

      return value;
    }

    parseMulDiv() {
      let value = this.parseUnary();

      while (true) {
        const token = this.peek();

        if (token.value === '*' || token.value === '/') {
          this.consume();
          const right = this.parseUnary();
          value = token.value === '*'
            ? this.engine.sMul(value, right)
            : this.engine.sDiv(value, right);
          continue;
        }

        // 隐式乘法：2a、ab、a(b+1)、2 sqrt(a) 等
        if (this.startsPrimary(token)) {
          const right = this.parseUnary();
          value = this.engine.sMul(value, right);
          continue;
        }

        break;
      }

      return value;
    }

    startsPrimary(token) {
      return token.type === 'num' ||
        token.type === 'id' ||
        token.value === '(';
    }

    parseUnary() {
      if (this.match('+')) return this.parseUnary();
      if (this.match('-')) return this.engine.sNeg(this.parseUnary());
      return this.parsePower();
    }

    parsePower() {
      let base = this.parsePrimary();

      if (this.match('^')) {
        const exponentValue = this.parseUnary();
        const exponent = this.integerValue(exponentValue);

        if (exponent === null || !Number.isSafeInteger(exponent)) {
          throw new Error('指数必须是整数');
        }

        base = this.engine.sPow(base, exponent);
      }

      return base;
    }

    parsePrimary() {
      const token = this.peek();

      if (token.type === 'num') {
        this.consume();
        return this.numberValue(token.value);
      }

      if (token.value === '(') {
        this.consume();
        const value = this.parseAddSub();
        this.expect(')');
        return value;
      }

      if (token.type === 'id') {
        this.consume();

        if (token.call) {
          if (FUNCTIONS.has(token.value)) {
            return this.parseFunction(token.value);
          }
          if (TRIG_FUNCTIONS.has(token.value)) {
            throw new Error(`暂不支持三角函数：${token.value}()`);
          }
          if (EXP_LOG_FUNCTIONS.has(token.value)) {
            throw new Error(`输入格式应为多项式，暂不支持指数/对数函数：${token.value}()`);
          }
          throw new Error(`未知函数：${token.value}()`);
        }

        return this.engine.sFromParam(this.mapVariable(token.value));
      }

      if (token.type === 'eof') {
        throw new Error('表达式不完整');
      }

      throw new Error(`无法识别的内容：${token.value}`);
    }

    numberValue(text) {
      let coef;
      let den = 1;

      if (text.includes('.')) {
        const parts = text.split('.');
        if (parts.length !== 2 || parts[1].length === 0) {
          throw new Error(`无效数字：${text}`);
        }
        den = Math.pow(10, parts[1].length);
        coef = Number((parts[0] || '0') + parts[1]);
      } else {
        coef = Number(text);
      }

      if (!Number.isSafeInteger(coef) || !Number.isSafeInteger(den)) {
        throw new Error(`数字过大：${text}`);
      }

      const value = this.engine.normalizeValue({
        coef,
        radicand: 1,
        index: 1,
        den
      });
      return this.engine.sFromPlain(value);
    }

    // Monomial.valueToInteger 把零多项式当成“无法转整数”，这里补上 0。
    integerValue(value) {
      if (this.engine.sIsZero(value)) return 0;
      return this.engine.valueToInteger(value);
    }

    parseArguments() {
      const args = [];

      if (this.match(')')) return args;

      while (true) {
        args.push(this.parseAddSub());
        if (this.match(',')) continue;
        this.expect(')');
        return args;
      }
    }

    parseFunction(name) {
      this.expect('(');
      const args = this.parseArguments();
      const m = this.engine;

      switch (name) {
        case 'p': {
          if (args.length !== 2) throw new Error('p() 需要 2 个参数');
          const exponent = this.integerValue(args[1]);
          if (exponent === null || !Number.isSafeInteger(exponent)) {
            throw new Error('p() 的指数必须是整数');
          }
          return m.sPow(args[0], exponent);
        }

        case 'd': {
          if (args.length !== 2) throw new Error('d() 需要 2 个参数');
          return m.sDiv(args[0], args[1]);
        }

        case 'r': {
          if (args.length !== 3) throw new Error('r() 需要 3 个参数');
          const coef = this.integerValue(args[0]);
          const radicand = this.integerValue(args[1]);
          const index = this.integerValue(args[2]);
          if (coef === null || radicand === null || index === null) {
            throw new Error('r() 的三个参数都必须是整数');
          }
          if (index <= 0) throw new Error('r() 的根指数必须为正整数');

          const root = m.rootValue({ coef: 1, radicand, index: 1, den: 1 }, index);
          return m.sMul(
            m.sFromPlain({ coef, radicand: 1, index: 1, den: 1 }),
            m.sLift(root)
          );
        }

        case 'sqrt': {
          if (args.length !== 1) throw new Error('sqrt() 需要 1 个参数');
          return m.sRoot(args[0], 2);
        }

        case 'root': {
          if (args.length !== 2) throw new Error('root() 需要 2 个参数');
          const index = this.integerValue(args[0]);
          if (index === null || !Number.isSafeInteger(index) || index <= 0) {
            throw new Error('root() 的根指数必须为正整数');
          }
          return m.sRoot(args[1], index);
        }

        case 'abs': {
          if (args.length !== 1) throw new Error('abs() 需要 1 个参数');
          return m.sAbs(args[0]);
        }

        default:
          throw new Error(`未知函数：${name}()`);
      }
    }
  }

  // ============================================================
  // 三、求导
  // ============================================================

  class Derivative {
    constructor(expression) {
      // 也接受 Monomial / Polynomial 实例，直接读取它们的 expression。
      const source = (expression && typeof expression === 'object' &&
        typeof expression.expression === 'string')
        ? expression.expression
        : expression;

      this.expression = String(source == null ? '' : source).trim();

      const parser = new Parser(this.expression);
      this.engine = parser.engine;
      this.polynomial = parser.polynomial;
      this.value = parser.parse();
      this.variableMap = parser.variableMap;
      this.reverseMap = parser.reverseMap;

      this.variables = this.collectVariables(this.value)
        .map(internal => this.reverseMap.get(internal))
        .filter(Boolean);
    }

    // 表达式中实际出现的参数（按首次出现顺序）
    collectVariables(value) {
      const m = this.engine;
      const used = new Set();

      const visit = (v) => {
        if (!v) return;
        if (v.sDen) visit(v.sDen);
        for (const term of v.sTerms || []) {
          for (const name of Monomial.PARAMS) {
            if ((term.pw && term.pw[name]) || (term.abs && term.abs[name])) {
              used.add(name);
            }
          }
          if (term.root) visit(term.root.poly);
        }
      };

      visit(m.sNormalize(value));
      return Array.from(this.variableMap.values()).filter(name => used.has(name));
    }

    getVariables() {
      return this.variables.slice();
    }

    // 对唯一参数求导；没有参数时返回 0，多个参数时要求显式指定
    derivative(variable) {
      if (variable === undefined || variable === null || variable === '') {
        if (this.variables.length === 0) return '0';
        if (this.variables.length > 1) {
          throw new Error(
            `表达式含多个参数（${this.variables.join('、')}），请用 partial(expression, parameter) 指定参数`
          );
        }
        variable = this.variables[0];
      }

      return this.partial(variable);
    }

    // 对指定参数求偏导
    partial(variable) {
      const name = String(variable == null ? '' : variable).trim();

      if (!/^[A-Za-z]$/.test(name)) {
        throw new Error('参数名必须是单个字母');
      }

      const internal = this.variableMap.get(name);
      if (!internal) return '0';

      const result = this.differentiateValue(this.value, internal);
      return this.format(result);
    }

    differentiateValue(value, variable) {
      const m = this.engine;
      const v = m.sNormalize(value);

      if (m.sIsZero(v)) return m.sZero();

      // 分式：商法则
      if (v.sDen) {
        const numerator = m.sBare(v);
        const denominator = m.sClone(v.sDen);
        const dNumerator = this.differentiateValue(numerator, variable);
        const dDenominator = this.differentiateValue(denominator, variable);

        const top = m.sSub(
          m.sMul(dNumerator, denominator),
          m.sMul(numerator, dDenominator)
        );

        return m.sDiv(top, m.sPow(denominator, 2));
      }

      let result = m.sZero();
      for (const term of v.sTerms) {
        result = m.sAdd(result, this.differentiateTerm(term, variable));
      }
      return m.sNormalize(result);
    }

    differentiateTerm(term, variable) {
      const m = this.engine;
      const factors = [];

      // 常数系数
      factors.push({
        value: m.sFromPlain({ ...term.coef }),
        derivative: m.sZero()
      });

      // 参数幂：a^2 -> 2a
      const powers = term.pw || {};
      for (const name of Monomial.PARAMS) {
        const exponent = powers[name] || 0;
        if (!exponent) continue;

        const base = m.sFromParam(name);
        const value = m.sPow(base, exponent);
        let d = m.sZero();

        if (name === variable) {
          d = m.sMul(
            m.sFromPlain({ coef: exponent, radicand: 1, index: 1, den: 1 }),
            m.sPow(base, exponent - 1)
          );
        }

        factors.push({ value, derivative: d });
      }

      // 绝对值因子：d|x|/dx = x/|x|
      const absolutes = term.abs || {};
      for (const name of Monomial.PARAMS) {
        const exponent = absolutes[name] || 0;
        if (!exponent) continue;

        const base = m.sAbs(m.sFromParam(name));
        const value = m.sPow(base, exponent);
        let d = m.sZero();

        if (name === variable) {
          // d(|x|^n)/dx = n·x·|x|^(n-2)
          d = m.sMul(
            m.sMul(
              m.sFromPlain({ coef: exponent, radicand: 1, index: 1, den: 1 }),
              m.sFromParam(variable)
            ),
            m.sPow(base, exponent - 2)
          );
        }

        factors.push({ value, derivative: d });
      }

      // 根式因子：d(p^(1/n))/dx = p' / (n·p^((n-1)/n))
      if (term.root) {
        const inner = m.sClone(term.root.poly);
        const index = term.root.index;
        const rootValue = m.sRoot(inner, index);
        const innerDerivative = this.differentiateValue(inner, variable);

        let d = m.sZero();
        if (!m.sIsZero(innerDerivative)) {
          if (index === 1) {
            d = innerDerivative;
          } else {
            const denominator = m.sMul(
              m.sFromPlain({ coef: index, radicand: 1, index: 1, den: 1 }),
              m.sPow(rootValue, index - 1)
            );
            d = m.sDiv(innerDerivative, denominator);
          }
        }

        factors.push({ value: rootValue, derivative: d });
      }

      // 乘积法则
      let result = m.sZero();

      for (let i = 0; i < factors.length; i++) {
        if (m.sIsZero(factors[i].derivative)) continue;

        let piece = factors[i].derivative;
        for (let j = 0; j < factors.length; j++) {
          if (i === j) continue;
          piece = m.sMul(piece, factors[j].value);
        }

        result = m.sAdd(result, piece);
      }

      return m.sNormalize(result);
    }

    // 优先让 Polynomial 输出（保证与计算器其它结果同一种规范），
    // 分式等 Polynomial 表示不了的结果再退回 Monomial。
    format(value) {
      const m = this.engine;
      const v = m.sNormalize(value);

      if (m.sIsZero(v)) return '0';

      let text;
      const poly = this.polynomial.fromSValue(v);
      if (poly) {
        text = this.polynomial.polyToString(poly);
      } else {
        text = m.sValueToString(v);
      }

      return this.restoreParameterNames(text);
    }

    restoreParameterNames(text) {
      const reverse = this.reverseMap;
      return String(text).replace(/[A-Za-z][A-Za-z0-9_]*/g, name => {
        return reverse.has(name) ? reverse.get(name) : name;
      });
    }

    // ---------------- 静态便捷接口 ----------------

    static derivative(expression, variable) {
      const d = new Derivative(expression);
      return (variable === undefined || variable === null || variable === '')
        ? d.derivative()
        : d.partial(variable);
    }

    static partial(expression, variable) {
      return new Derivative(expression).partial(variable);
    }

    static differentiate(expression, variable) {
      return Derivative.derivative(expression, variable);
    }

    static variables(expression) {
      return new Derivative(expression).getVariables();
    }
  }

  return Derivative;
});
