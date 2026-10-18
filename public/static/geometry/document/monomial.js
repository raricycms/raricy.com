class Monomial {
  constructor(expression) {
    this.expression = expression.trim();
  }

  simplify() {
    try {
      const val = this.evalExpression(this.expression);
      return this.valueToString(val);
    } catch (e) {
      return `错误: ${e.message}`;
    }
  }

  // ==================== 静态入口 ====================

  static simplifyExpression(expr) {
    expr = (expr || '').trim();
    if (!expr) return '0';
    return new Monomial(expr).simplify();
  }

  static operate(a, op, b) {
    const ma = new Monomial(String(a));
    const mb = new Monomial(String(b));
    let result;
    if (op === '+') result = ma.add(mb);
    else if (op === '-') result = ma.sub(mb);
    else if (op === '*') result = ma.mul(mb);
    else if (op === '/') result = ma.div(mb);
    else throw new Error('未知运算符：' + op);
    return result.simplify ? result.simplify() : String(result);
  }

  // ==================== 表达式解析工具 ====================

  static isNumber(s) {
    return /^-?\d+$/.test(s);
  }

  // ==================== 参数支持（基础） ====================

  static get PARAMS() {
    return ['a', 'b', 'h'];
  }

  static isParam(name) {
    return name === 'a' || name === 'b' || name === 'h';
  }

  static isFunctionName(name) {
    return ['r', 'd', 'p', 'sqrt', 'root', 'abs'].includes(name);
  }

  static isSValue(v) {
    return !!v && typeof v === 'object' && Array.isArray(v.sTerms);
  }

  // 判断 expr 是否被一对完整包裹的括号包住
  static isWrapped(expr) {
    if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') {
        depth--;
        if (depth === 0 && i < expr.length - 1) return false;
      }
    }
    return depth === 0;
  }

  static unwrapOuterParens(expr) {
    while (Monomial.isWrapped(expr)) {
      expr = expr.slice(1, -1).trim();
    }
    return expr;
  }

  // 按顶层运算符切分表达式，返回 [{op, value}, ...]
  static splitTopLevel(expr, ops) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let lastOp = null;

    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth < 0) throw new Error("括号不匹配");
      } else if (depth === 0 && ops.includes(ch)) {
        if ((ch === '+' || ch === '-') &&
            (i === 0 || '+-*/(,'.includes(expr[i - 1]))) {
          continue;
        }
        parts.push({ op: lastOp, value: expr.slice(start, i) });
        lastOp = ch;
        start = i + 1;
      }
    }
    if (depth !== 0) throw new Error("括号不匹配");
    parts.push({ op: lastOp, value: expr.slice(start) });
    return parts;
  }

  // 给定左括号的位置，返回括号内内容（不含括号）
  static extractParenthesesContent(str, openParenIndex) {
    if (str[openParenIndex] !== '(') return null;
    let depth = 0;
    let end = -1;
    for (let i = openParenIndex; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') {
        depth--;
        if (depth < 0) return null;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;
    return str.substring(openParenIndex + 1, end);
  }

  static splitArguments(content) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(content.substring(start, i));
        start = i + 1;
      }
    }
    parts.push(content.substring(start));
    return parts;
  }

  // 解析形如 name(args...) 的函数调用；失败返回 null
  static parseFunctionCall(expr) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\(/.exec(expr);
    if (!m) return null;
    const name = m[1];
    const openIdx = name.length;
    const inner = Monomial.extractParenthesesContent(expr, openIdx);
    if (inner === null) return null;
    const closeIdx = openIdx + inner.length + 1;
    if (closeIdx !== expr.length - 1) return null;
    return { name, args: Monomial.splitArguments(inner) };
  }

  // 把 a b、2a、a(b+1)、r(1,2,2)a 这类紧邻写法拆成乘积
  // 返回插入 * 后的表达式；无法识别时返回 null
  static implicitProduct(expr) {
    const s = String(expr).replace(/\s+/g, '');
    if (!s) return null;

    const atoms = [];
    let i = 0;

    while (i < s.length) {
      const ch = s[i];

      if (ch === '(') {
        const inner = Monomial.extractParenthesesContent(s, i);
        if (inner === null) return null;
        atoms.push(s.substr(i, inner.length + 2));
        i += inner.length + 2;
      } else if (/\d/.test(ch)) {
        let j = i;
        while (j < s.length && /\d/.test(s[j])) j++;
        atoms.push(s.slice(i, j));
        i = j;
      } else if (/[a-zA-Z_]/.test(ch)) {
        let j = i;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        const name = s.slice(i, j);

        if (Monomial.isFunctionName(name) && s[j] === '(') {
          const inner = Monomial.extractParenthesesContent(s, j);
          if (inner === null) return null;
          atoms.push(s.slice(i, j + inner.length + 2));
          i = j + inner.length + 2;
        } else if (name.length === 1 && Monomial.isParam(name)) {
          atoms.push(name);
          i = j;
        } else {
          // 连续字母/数字按单字母参数与数字拆开：ab2 → a·b·2
          for (let t = 0; t < name.length; t++) {
            const c2 = name[t];
            if (Monomial.isParam(c2)) {
              atoms.push(c2);
            } else if (/\d/.test(c2)) {
              let k = t;
              while (k < name.length && /\d/.test(name[k])) k++;
              atoms.push(name.slice(t, k));
              t = k - 1;
            } else {
              return null;
            }
          }
          i = j;
        }
      } else {
        return null;
      }
    }

    if (atoms.length < 2) return null;
    return atoms.join('*');
  }

  // 判断一段字符串是否是顶层加减式（用于输出时补括号）
  static isSumString(expr) {
    try {
      return Monomial.splitTopLevel(expr, ['+', '-']).length > 1;
    } catch (e) {
      return false;
    }
  }

  // 解析输出语法，返回结构化对象供渲染层使用
  static parseValueString(expr) {
    expr = (expr || '').trim();
    if (!expr) return { type: 'text', value: '' };

    const call = Monomial.parseFunctionCall(expr);
    if (!call) return { type: 'text', value: expr };

    const args = call.args.map(s => s.trim());
    switch (call.name) {
      case 'd':
        if (args.length === 2) {
          return { type: 'fraction', numerator: args[0], denominator: args[1] };
        }
        break;
      case 'p':
        if (args.length === 2) {
          return { type: 'power', base: args[0], exponent: args[1] };
        }
        break;
      case 'r':
        if (args.length === 3) {
          return {
            type: 'radical',
            coef: parseInt(args[0], 10),
            radicand: args[1],
            index: parseInt(args[2], 10)
          };
        }
        break;
      case 'sqrt':
        if (args.length === 1) {
          return { type: 'sqrt', radicand: args[0] };
        }
        break;
      case 'root':
        if (args.length === 2) {
          return { type: 'root', index: args[0], radicand: args[1] };
        }
        break;
      case 'abs':
        if (args.length === 1) {
          return { type: 'abs', value: args[0] };
        }
        break;
    }
    return { type: 'text', value: expr };
  }

  // ==================== 输出语法格式化 ====================

  static formatFraction(num, den) {
    return `d(${num || '0'},${den || '1'})`;
  }

  static formatPower(base, exp) {
    return `p(${base || '0'},${exp || '1'})`;
  }

  static formatSqrt(radicand) {
    return `sqrt(${radicand || '0'})`;
  }

  static formatRoot(index, radicand) {
    return `root(${index || '2'},${radicand || '0'})`;
  }

  // ==================== 多项式基础工具 ====================

  isPoly(v) {
    return v && Array.isArray(v.terms);
  }

  // 【新增】判断是否为"多项式根式"值（根号内含多项式的值）
  isPolyRadical(v) {
    return v && v.polyRadicand !== undefined && v.polyRadicand !== null;
  }

  toTerms(v) {
    if (this.isPolyRadical(v)) return [v];
    return this.isPoly(v) ? v.terms.slice() : [v];
  }

  fromTerms(terms) {
    const nonZero = terms.filter(t => t.coef !== 0);
    if (nonZero.length === 0) return { coef: 0, radicand: 1, index: 1, den: 1 };
    if (nonZero.length === 1) return nonZero[0];
    return { terms: nonZero };
  }

  combineLikeTerms(terms) {
    const map = new Map();
    for (const t of terms) {
      // 多项式根式：按“根指数 + 被开方多项式”归并
      if (this.isPolyRadical(t)) {
        const key = `__polyRadical__${t.polyRootIndex}|${this.valueToString(t.polyRadicand)}`;
        if (!map.has(key)) {
          map.set(key, {
            coef: t.coef,
            radicand: 1,
            index: 1,
            den: t.den,
            polyRadicand: t.polyRadicand,
            polyRootIndex: t.polyRootIndex
          });
        } else {
          const e = map.get(key);
          const num = e.coef * t.den + t.coef * e.den;
          const den = e.den * t.den;
          map.set(key, this.normalizeValue({ ...e, coef: num, den }));
        }
        continue;
      }
      const key = `${t.radicand}|${t.index}`;
      if (!map.has(key)) {
        map.set(key, { coef: t.coef, radicand: t.radicand, index: t.index, den: t.den });
      } else {
        const existing = map.get(key);
        const num = existing.coef * t.den + t.coef * existing.den;
        const den = existing.den * t.den;
        map.set(key, this.normalizeValue({
          coef: num, radicand: t.radicand, index: t.index, den
        }));
      }
    }
    return Array.from(map.values());
  }

  negateValue(v) {
    // 【参数支持】符号值：只翻系数
    if (Monomial.isSValue(v)) return this.sNeg(v);

    // 多项式根式：只翻系数，保留 polyRadicand
    if (this.isPolyRadical(v)) {
      return { ...v, coef: -v.coef };
    }

    if (this.isPoly(v)) {
      return {
        terms: v.terms.map(t => ({
          ...t,
          coef: -t.coef
        }))
      };
    }

    return {
      coef: -v.coef,
      radicand: v.radicand,
      index: v.index,
      den: v.den
    };
  }

  // ==================== 求值 ====================

  evalExpression(expr) {
    expr = expr.trim();
    if (expr === '') throw new Error("空表达式");

    expr = Monomial.unwrapOuterParens(expr);

    // ---- 顶层 + / - ----
    const addSub = Monomial.splitTopLevel(expr, ['+', '-']);
    if (addSub.length > 1) {
      let result = this.evalExpression(addSub[0].value);
      for (let i = 1; i < addSub.length; i++) {
        const rv = this.evalExpression(addSub[i].value);
        result = addSub[i].op === '+'
          ? this.addValues(result, rv)
          : this.subValues(result, rv);
      }
      return result;
    }

    // ---- 顶层 * / ----
    const mulDiv = Monomial.splitTopLevel(expr, ['*', '/']);
    if (mulDiv.length > 1) {
      let result = this.evalExpression(mulDiv[0].value);
      for (let i = 1; i < mulDiv.length; i++) {
        const rv = this.evalExpression(mulDiv[i].value);
        result = mulDiv[i].op === '*'
          ? this.multiplyValues(result, rv)
          : this.divideValues(result, rv);
      }
      return result;
    }

    // 一元 + / -
    if (expr.startsWith('+')) return this.evalExpression(expr.substring(1));
    if (expr.startsWith('-')) return this.negateValue(this.evalExpression(expr.substring(1)));

    // 幂：a^2（右结合）
    const pow = Monomial.splitTopLevel(expr, ['^']);
    if (pow.length > 1) {
      let result = this.evalExpression(pow[pow.length - 1].value);
      for (let i = pow.length - 2; i >= 0; i--) {
        result = this.powerValues(this.evalExpression(pow[i].value), result);
      }
      return result;
    }

    // 纯整数
    if (Monomial.isNumber(expr)) {
      return { coef: parseInt(expr, 10), radicand: 1, index: 1, den: 1 };
    }

    // 函数调用 r / d / p / sqrt / root / abs
    const call = Monomial.parseFunctionCall(expr);
    if (call) return this.evalFunctionCall(call);

    // 参数 a / b / h
    if (Monomial.isParam(expr)) return this.sFromParam(expr);

    // 隐式乘法：2a、ab、a(b+1) 等
    const implicit = Monomial.implicitProduct(expr);
    if (implicit) return this.evalExpression(implicit);

    throw new Error(`无效表达式: ${expr}`);
  }

  evalFunctionCall(call) {
    const { name, args } = call;

    switch (name) {
      case 'r': {
        if (args.length !== 3) throw new Error("r() 需要 3 个参数");
        const coefInt = this.valueToInteger(this.evalExpression(args[0].trim()));
        const radicandInt = this.valueToInteger(this.evalExpression(args[1].trim()));
        const indexInt = this.valueToInteger(this.evalExpression(args[2].trim()));
        if (coefInt === null || radicandInt === null || indexInt === null) {
          throw new Error("r() 的参数必须为整数");
        }
        if (indexInt <= 0) throw new Error("根指数必须为正整数");
        if (radicandInt < 0 && indexInt % 2 === 0) throw new Error("偶次根号负数");
        return this.normalizeValue({
          coef: coefInt, radicand: radicandInt, index: indexInt, den: 1
        });
      }

      case 'd': {
        if (args.length !== 2) throw new Error("d() 需要 2 个参数");
        const a = this.evalExpression(args[0].trim());
        const b = this.evalExpression(args[1].trim());
        return this.divideValues(a, b);
      }

      case 'p': {
        if (args.length !== 2) throw new Error("p() 需要 2 个参数");
        const base = this.evalExpression(args[0].trim());
        const exp = this.evalExpression(args[1].trim());
        return this.powerValues(base, exp);
      }

      case 'sqrt': {
        if (args.length !== 1) throw new Error("sqrt() 需要 1 个参数");
        const inner = this.evalExpression(args[0].trim());
        return this.rootValue(inner, 2);
      }

      case 'root': {
        if (args.length !== 2) throw new Error("root() 需要 2 个参数");
        const kVal = this.evalExpression(args[0].trim());
        const nVal = this.evalExpression(args[1].trim());
        const kInt = this.valueToInteger(kVal);
        if (kInt !== null && kInt > 0) return this.rootValue(nVal, kInt);
        throw new Error("根指数必须为正整数");
      }

      case 'abs': {
        if (args.length !== 1) throw new Error("abs() 需要 1 个参数");
        return this.sAbs(this.evalExpression(args[0].trim()));
      }

      default:
        throw new Error(`未知函数: ${name}`);
    }
  }

  // ==================== 值的四则运算 ====================

  addValues(a, b) {
    // 【参数支持】任一方为符号值时走符号运算
    if (Monomial.isSValue(a) || Monomial.isSValue(b)) {
      return this.sAdd(this.sLift(a), this.sLift(b));
    }
    const merged = [...this.toTerms(a), ...this.toTerms(b)];
    return this.fromTerms(this.combineLikeTerms(merged));
  }

  subValues(a, b) {
    if (Monomial.isSValue(a) || Monomial.isSValue(b)) {
      return this.sSub(this.sLift(a), this.sLift(b));
    }
    return this.addValues(a, this.negateValue(b));
  }

  multiplyValues(a, b) {
    if (Monomial.isSValue(a) || Monomial.isSValue(b)) {
      return this.sMul(this.sLift(a), this.sLift(b));
    }
    const result = [];
    for (const at of this.toTerms(a)) {
      for (const bt of this.toTerms(b)) {
        result.push(this.multiplySingle(at, bt));
      }
    }
    return this.fromTerms(this.combineLikeTerms(result));
  }

  multiplySingle(a, b) {
    // 【新增】多项式根式目前不支持参与乘法
    if (this.isPolyRadical(a) || this.isPolyRadical(b)) {
      throw new Error("暂不支持含多项式根式的乘法");
    }
    const coef = a.coef * b.coef;
    const den = a.den * b.den;

    const aRational = (a.radicand === 1 && a.index === 1);
    const bRational = (b.radicand === 1 && b.index === 1);

    let radicand, index;

    if (aRational) {
      radicand = b.radicand; index = b.index;
    } else if (bRational) {
      radicand = a.radicand; index = a.index;
    } else if (a.index === b.index) {
      radicand = a.radicand * b.radicand;
      index = a.index;
    } else {
      const M = a.index * b.index;
      radicand = Math.pow(a.radicand, b.index) * Math.pow(b.radicand, a.index);
      index = M;
    }

    if (radicand === 1) {
      return this.normalizeValue({ coef, radicand: 1, index: 1, den });
    }
    const simplified = this.rootOfInteger(radicand, index);
    return this.normalizeValue({
      coef: coef * simplified.coef,
      radicand: simplified.radicand,
      index: simplified.index,
      den: den * simplified.den
    });
  }

  divideValues(a, b) {
    if (Monomial.isSValue(a) || Monomial.isSValue(b)) {
      return this.sDiv(this.sLift(a), this.sLift(b));
    }
    const bTerms = this.toTerms(b);

    if (bTerms.length === 1) {
      const bSingle = bTerms[0];
      if (bSingle.coef === 0) throw new Error("除零");
      const result = this.toTerms(a).map(at => this.divideSingle(at, bSingle));
      return this.fromTerms(this.combineLikeTerms(result));
    }

    return this.divideByPolynomial(a, b, 0);
  }

  divideByPolynomial(a, b, depth = 0) {
    if (depth > 10) {
      throw new Error("多项式分母有理化层次过深");
    }

    const bTerms = this.toTerms(b);

    if (bTerms.length === 1) {
      return this.divideValues(a, bTerms[0]);
    }

    const first = bTerms[0];
    const rest = this.fromTerms(bTerms.slice(1));

    const conj = this.subValues(first, rest);

    const newDen = this.multiplyValues(b, conj);
    const newNum = this.multiplyValues(a, conj);

    if (this.valuesEqual(newDen, b)) {
      throw new Error("无法对多项式分母进行有理化");
    }

    return this.divideByPolynomial(newNum, newDen, depth + 1);
  }

  valuesEqual(a, b) {
    const ta = this.toTerms(a).map(t => this.normalizeValue({ ...t }));
    const tb = this.toTerms(b).map(t => this.normalizeValue({ ...t }));

    if (ta.length !== tb.length) return false;

    const key = t => `${t.coef}|${t.radicand}|${t.index}|${t.den}`;
    const ka = ta.map(key).sort();
    const kb = tb.map(key).sort();

    return ka.every((v, i) => v === kb[i]);
  }

  divideSingle(a, b) {
    // 【新增】多项式根式暂不支持除
    if (this.isPolyRadical(a) || this.isPolyRadical(b)) {
      throw new Error("暂不支持含多项式根式的除法");
    }
    if (b.radicand === 1 && b.index === 1) {
      return this.normalizeValue({
        coef: a.coef * b.den,
        radicand: a.radicand,
        index: a.index,
        den: a.den * b.coef
      });
    }
    const k = b.index;
    const r = b.radicand;
    const invB = {
      coef: b.den,
      radicand: Math.pow(r, k - 1),
      index: k,
      den: b.coef * r
    };
    return this.multiplySingle(a, invB);
  }

  powerValues(base, exp) {
    // 【参数支持】底数为符号值
    if (Monomial.isSValue(base)) {
      const eInt = this.valueToInteger(exp);
      if (eInt === null) throw new Error("指数必须为整数");
      return this.sPow(base, eInt);
    }

    const eInt = this.valueToInteger(exp);
    if (eInt === null) throw new Error("指数必须为整数");

    if (eInt === 0) return { coef: 1, radicand: 1, index: 1, den: 1 };
    if (eInt < 0) {
      const pos = this.powerValues(base, { coef: -eInt, radicand: 1, index: 1, den: 1 });
      return this.divideValues({ coef: 1, radicand: 1, index: 1, den: 1 }, pos);
    }

    if (!this.isPoly(base)) {
      const { coef: c, radicand: n, index: k, den: d } = base;
      const newC = Math.pow(c, eInt);
      const newD = Math.pow(d, eInt);

      if (n === 1) {
        return this.normalizeValue({ coef: newC, radicand: 1, index: 1, den: newD });
      }
      if (eInt % k === 0) {
        const inner = Math.pow(n, eInt / k);
        return this.normalizeValue({ coef: newC * inner, radicand: 1, index: 1, den: newD });
      }
      const newN = Math.pow(n, eInt);
      const simplified = this.rootValue({ coef: 1, radicand: newN, index: 1, den: 1 }, k);
      return this.normalizeValue({
        coef: newC * simplified.coef,
        radicand: simplified.radicand,
        index: simplified.index,
        den: newD
      });
    }

    let result = { coef: 1, radicand: 1, index: 1, den: 1 };
    for (let i = 0; i < eInt; i++) {
      result = this.multiplyValues(result, base);
    }
    return result;
  }

  // ==================== rootValue（关键修改） ====================

  rootValue(v, k) {
    // 【参数支持】符号值开根
    if (Monomial.isSValue(v)) return this.sRoot(v, k);

    // 【修改】多项式根式原样保留，不再抛错
    if (this.isPoly(v)) {
      // 单项式伪装成多项式 → 走单项式路径
      if (v.terms.length === 1) {
        const single = v.terms[0];
        // 如果这一项已经是多项式根式，避免无限递归
        if (this.isPolyRadical(single)) return single;
        return this.rootValue(single, k);
      }
      // 【新增】先尝试去嵌套 √(A ± B√C) = √x ± √y
      const denested = this.tryDenestPolyRadical(v, k);
      if (denested) return denested;
      // 真正的多项式：原样保留为多项式根式
      return {
        coef: 1,
        radicand: 1,
        index: 1,
        den: 1,
        polyRadicand: v,
        polyRootIndex: k
      };
    }

    const { coef, radicand, index, den } = v;

    if (coef === 0) return { coef: 0, radicand: 1, index: 1, den: 1 };
    if (k <= 0) throw new Error("根指数必须为正整数");

    if (index === 1 && radicand === 1) {
      if (coef < 0 && k % 2 === 0) throw new Error("偶次根号负数");
      const N = coef * Math.pow(den, k - 1);
      const r = this.rootOfInteger(N, k);
      return this.normalizeValue({
        coef: r.coef,
        radicand: r.radicand,
        index: r.index,
        den: r.den * den
      });
    }

    if (coef < 0 && k % 2 === 0) throw new Error("偶次根号负数");
    const sign = coef < 0 ? -1 : 1;
    const absCoef = Math.abs(coef);
    const M = index * k;
    const N2 = Math.pow(absCoef, index) * radicand * Math.pow(den, M - index);

    if (!isFinite(N2) || N2 > Number.MAX_SAFE_INTEGER) {
      throw new Error("根式化简数值溢出");
    }

    const r2 = this.rootOfInteger(N2, M);
    return this.normalizeValue({
      coef: sign * r2.coef,
      radicand: r2.radicand,
      index: r2.index,
      den: r2.den * den
    });
  }

  // ==================== 根式去嵌套 ====================

  // √(A ± B√C) = √x ± √y
  // 其中 x = (A+s)/2、y = (A-s)/2、s = √(A²-B²C)。
  // 仅当 A、B 为整数、A²−B²C 为完全平方且 x、y 也为整数时才化简，
  // 这样既不会引入 (√6+√2)/2 这类更难看的结果，也不会引入误差。
  tryDenestPolyRadical(poly, k) {
    if (k !== 2) return null;
    if (!this.isPoly(poly) || poly.terms.length !== 2) return null;

    let rational = null;
    let radical = null;

    for (const t of poly.terms) {
      if (this.isPolyRadical(t)) return null;

      if (t.radicand === 1 && t.index === 1 && t.den === 1) {
        if (rational) return null;
        rational = t;
      } else if (t.index === 2 && t.den === 1 && t.radicand > 1) {
        if (radical) return null;
        radical = t;
      } else {
        return null;
      }
    }

    if (!rational || !radical) return null;

    const A = rational.coef;
    const B = radical.coef;
    const C = radical.radicand;

    if (!Number.isSafeInteger(A) || !Number.isSafeInteger(B)) return null;
    if (A <= 0 || B === 0) return null;

    const disc = A * A - B * B * C;
    if (disc < 0) return null;

    const s = Math.sqrt(disc);
    if (!Number.isInteger(s) || s * s !== disc) return null;

    const x = (A + s) / 2;
    const y = (A - s) / 2;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0) return null;

    const sign = B > 0 ? 1 : -1;
    const terms = [
      this.normalizeValue({ coef: 1, radicand: x, index: 2, den: 1 }),
      this.normalizeValue({ coef: sign, radicand: y, index: 2, den: 1 })
    ];

    return this.fromTerms(this.combineLikeTerms(terms));
  }

  // ==================== 规范化 / 整数提取 ====================

  normalizeValue(v) {
    // 【参数支持】多项式根式：只约分系数，内容保持不变
    if (this.isPolyRadical(v)) {
      if (v.den !== 1 && v.coef !== 0) {
        const g = this.gcd(Math.abs(v.coef), Math.abs(v.den));
        v.coef /= g;
        v.den /= g;
      }
      if (v.den < 0) { v.coef = -v.coef; v.den = -v.den; }
      if (v.coef === 0) v.den = 1;
      return v;
    }

    if (v.den !== 1 && v.coef !== 0) {
      const g = this.gcd(Math.abs(v.coef), Math.abs(v.den));
      v.coef /= g;
      v.den /= g;
    }
    if (v.den < 0) { v.coef = -v.coef; v.den = -v.den; }

    if (v.radicand > 1 && v.index > 1) {
      const r = this.rootOfInteger(v.radicand, v.index);
      v.coef *= r.coef;
      v.radicand = r.radicand;
      v.index = r.index;
      v.den *= r.den;

      if (v.den !== 1 && v.coef !== 0) {
        const g = this.gcd(Math.abs(v.coef), Math.abs(v.den));
        v.coef /= g;
        v.den /= g;
      }
      if (v.den < 0) { v.coef = -v.coef; v.den = -v.den; }
    }
    if (v.radicand === 1) v.index = 1;
    if (v.coef === 0) { v.radicand = 1; v.index = 1; v.den = 1; }
    return v;
  }

  valueToInteger(v) {
    // 【参数支持】符号值：只有纯数值且无参数部分时才是整数
    if (Monomial.isSValue(v)) {
      const sv = this.sNormalize(v);
      if (sv.sDen || sv.sTerms.length !== 1) return null;
      const t = sv.sTerms[0];
      if (t.root || (t.abs && Object.keys(t.abs).length)) return null;
      const pw = t.pw || {};
      if ((pw.a || 0) || (pw.b || 0) || (pw.h || 0)) return null;
      return this.valueToInteger(t.coef);
    }
    // 【新增】多项式根式不是整数
    if (this.isPolyRadical(v)) return null;
    if (this.isPoly(v)) {
      if (v.terms.length === 1) return this.valueToInteger(v.terms[0]);
      return null;
    }
    if (v.radicand === 1 && v.index === 1 && v.den === 1) return v.coef;
    return null;
  }

  // ==================== 字符串化 ====================

  valueToString(v) {
    // 【参数支持】符号值输出
    if (Monomial.isSValue(v)) return this.sValueToString(v);

    // 【新增】多项式根式：输出 sqrt(poly) 或 root(k,poly)
    if (this.isPolyRadical(v)) {
      const inner = this.valueToString(v.polyRadicand);
      const k = v.polyRootIndex;
      const body = (k === 2) ? `sqrt(${inner})` : `root(${k},${inner})`;
      if (v.coef === 1 && v.den === 1) return body;
      if (v.coef === -1 && v.den === 1) return `-${body}`;
      if ((v.den || 1) === 1) return `${v.coef}*(${body})`;
      return `d(${v.coef},${v.den})*(${body})`;
    }

    if (this.isPoly(v)) {
      let result = '';
      for (let i = 0; i < v.terms.length; i++) {
        const t = v.terms[i];
        const isNeg = t.coef < 0;
        // 【修改】保留所有字段（包括 polyRadicand）
        const posT = isNeg ? { ...t, coef: -t.coef } : t;
        const s = this.singleValueToString(posT);
        if (i === 0) result += (isNeg ? '-' : '') + s;
        else result += (isNeg ? '-' : '+') + s;
      }
      return result;
    }
    return this.singleValueToString(v);
  }

  singleValueToString(v) {
    // 【新增】多项式根式的单项输出
    if (this.isPolyRadical(v)) {
      const inner = this.valueToString(v.polyRadicand);
      const k = v.polyRootIndex;
      const body = (k === 2) ? `sqrt(${inner})` : `root(${k},${inner})`;
      if (v.coef === 1 && v.den === 1) return body;
      if (v.coef === -1 && v.den === 1) return `-${body}`;
      // 带系数的多项式根式：以乘法形式表达
      if (v.den === 1) return `${v.coef}*(${body})`;
      return `d(${v.coef},${v.den})*(${body})`;
    }

    v = this.normalizeValue(v);
    if (v.radicand === 1 && v.index === 1) {
      return `d(${v.coef},${v.den})`;
    }
    if (v.den === 1) {
      return `r(${v.coef},${v.radicand},${v.index})`;
    }
    return `d(r(${v.coef},${v.radicand},${v.index}),${v.den})`;
  }

  // ==================== 参数（符号）运算 ====================
  //
  // 符号值（SValue）结构：
  // {
  //   sTerms: [ { coef, pw, abs, root } ],
  //   sDen: SValue                     // 分母，可省略
  // }
  //   coef : 数值系数，沿用 { coef, radicand, index, den }
  //   pw   : 参数幂，例如 { a: 2, b: -1 }（可省略）
  //   abs  : 绝对值因子，例如 { a: 1 } 表示 |a|（可省略）
  //   root : 含参数根式 { poly: SValue, index: k } 表示 (poly)^(1/k)
  //
  // 参数固定为 a、b、h 三个；偶次根号按绝对值处理：√(a²)=|a|。

  plainOne() { return { coef: 1, radicand: 1, index: 1, den: 1 }; }
  plainZero() { return { coef: 0, radicand: 1, index: 1, den: 1 }; }

  sZero() { return { sTerms: [] }; }

  sOne() { return { sTerms: [{ coef: this.plainOne(), pw: {} }] }; }

  sFromPlain(v) { return { sTerms: [{ coef: v, pw: {} }] }; }

  sFromParam(name, exp = 1) {
    if (!Monomial.isParam(name)) throw new Error(`未知参数: ${name}`);
    const pw = {};
    if (exp !== 0) pw[name] = exp;
    return { sTerms: [{ coef: this.plainOne(), pw }] };
  }

  // 把任意值提升为符号值
  sLift(v) {
    if (Monomial.isSValue(v)) return v;
    if (this.isPoly(v)) {
      return { sTerms: v.terms.map(t => ({ coef: t, pw: {} })) };
    }
    return { sTerms: [{ coef: v, pw: {} }] };
  }

  sCloneTerm(t) {
    const r = { coef: this.isPoly(t.coef) ? t.coef : { ...t.coef }, pw: { ...(t.pw || {}) } };
    if (t.abs && Object.keys(t.abs).length) r.abs = { ...t.abs };
    if (t.root) r.root = { poly: t.root.poly, index: t.root.index };
    return r;
  }

  sClone(v) {
    const r = { sTerms: v.sTerms.map(t => this.sCloneTerm(t)) };
    if (v.sDen) r.sDen = this.sClone(v.sDen);
    return r;
  }

  sBare(v) { return { sTerms: v.sTerms.map(t => this.sCloneTerm(t)) }; }

  sDenOf(v) { return v.sDen ? this.sClone(v.sDen) : this.sOne(); }

  sFrac(num, den) {
    if (this.sIsOne(den)) return this.sNormalize(num);
    return { sTerms: num.sTerms.map(t => this.sCloneTerm(t)), sDen: den };
  }

  sIsZero(v) {
    if (!v || !v.sTerms || v.sTerms.length === 0) return true;
    return v.sTerms.every(t => this.valueIsZero(t.coef));
  }

  sIsOne(v) {
    if (!v || v.sDen) return false;
    if (!v.sTerms || v.sTerms.length !== 1) return false;
    const t = v.sTerms[0];
    if (t.root) return false;
    if (t.abs && Object.keys(t.abs).length) return false;
    const pw = t.pw || {};
    if ((pw.a || 0) || (pw.b || 0) || (pw.h || 0)) return false;
    const c = t.coef;
    return !this.isPoly(c) && !this.isPolyRadical(c) &&
      c.radicand === 1 && c.index === 1 && c.coef === 1 && c.den === 1;
  }

  valueIsZero(v) {
    if (this.isPoly(v)) {
      return v.terms.length === 0 || v.terms.every(t => this.valueIsZero(t.coef));
    }
    return !!v && v.coef === 0;
  }

  valueIsNegative(v) {
    if (this.isPoly(v)) return v.terms.length > 0 && this.valueIsNegative(v.terms[0].coef);
    return !!v && v.coef < 0;
  }

  pwKey(pw) {
    if (!pw) return '0,0,0';
    return `${pw.a || 0},${pw.b || 0},${pw.h || 0}`;
  }

  pwAdd(a, b) {
    const r = {};
    for (const name of Monomial.PARAMS) {
      const v = ((a && a[name]) || 0) + ((b && b[name]) || 0);
      if (v !== 0) r[name] = v;
    }
    return r;
  }

  pwSub(a, b) {
    const r = {};
    for (const name of Monomial.PARAMS) {
      const v = ((a && a[name]) || 0) - ((b && b[name]) || 0);
      if (v !== 0) r[name] = v;
    }
    return r;
  }

  absAdd(a, b) {
    const r = {};
    for (const name of Monomial.PARAMS) {
      const v = ((a && a[name]) || 0) + ((b && b[name]) || 0);
      if (v !== 0) r[name] = v;
    }
    return r;
  }

  // |x|^2 = x^2：把绝对值里的偶次幂折回普通幂
  foldAbsIntoPw(term) {
    const pw = { ...(term.pw || {}) };
    const abs = {};
    for (const name of Monomial.PARAMS) {
      const e = (term.abs && term.abs[name]) || 0;
      if (e <= 0) continue;
      const pairs = Math.floor(e / 2);
      if (pairs) pw[name] = (pw[name] || 0) + pairs * 2;
      if (e % 2 === 1) abs[name] = 1;
      if (!pw[name]) delete pw[name];
    }
    const r = { coef: term.coef, pw };
    if (Object.keys(abs).length) r.abs = abs;
    if (term.root) r.root = term.root;
    return r;
  }

  sTermKey(t) {
    return [
      this.pwKey(t.pw),
      t.abs ? this.pwKey(t.abs) : '0,0,0',
      t.root ? `${t.root.index}:${this.sValueToString(t.root.poly)}` : ''
    ].join('|');
  }

  sMerge(terms) {
    const once = this.sMergeSimple(terms.map(t => this.foldAbsIntoPw(this.sCloneTerm(t))));
    const reduced = once.sTerms.map(t => this.sReduceRootTerm(t));
    return this.sMergeSimple(reduced);
  }

  sMergeSimple(terms) {
    const map = new Map();
    for (const raw of terms) {
      const t = this.sCloneTerm(raw);
      if (!this.isPoly(t.coef)) t.coef = this.normalizeValue(t.coef);
      if (this.valueIsZero(t.coef)) continue;
      const key = this.sTermKey(t);
      if (map.has(key)) {
        const old = map.get(key);
        old.coef = this.addValues(old.coef, t.coef);
        if (this.valueIsZero(old.coef)) map.delete(key);
      } else {
        map.set(key, t);
      }
    }
    return { sTerms: Array.from(map.values()) };
  }

  sNormalize(v) {
    if (!Monomial.isSValue(v)) return this.sFromPlain(v);
    if (v.sDen) return this.sCollapse(v);
    if (!v.sTerms) return this.sZero();
    return this.sMerge(v.sTerms);
  }

  // ---------- 四则运算 ----------

  sAdd(a, b) {
    const A = this.sNormalize(a);
    const B = this.sNormalize(b);
    if (!A.sDen && !B.sDen) return this.sMerge([...A.sTerms, ...B.sTerms]);
    const num = this.sAddRaw(
      this.sMulRaw(this.sBare(A), this.sDenOf(B)),
      this.sMulRaw(this.sBare(B), this.sDenOf(A))
    );
    const den = this.sMulRaw(this.sDenOf(A), this.sDenOf(B));
    return this.sCollapse({ sTerms: num.sTerms, sDen: den });
  }

  sAddRaw(A, B) { return this.sMerge([...A.sTerms, ...B.sTerms]); }

  sSub(a, b) { return this.sAdd(a, this.sNeg(b)); }

  sNeg(a) {
    const A = this.sNormalize(a);
    const r = {
      sTerms: A.sTerms.map(t => ({ ...this.sCloneTerm(t), coef: this.negateValue(t.coef) }))
    };
    if (A.sDen) r.sDen = this.sClone(A.sDen);
    return r;
  }

  sMul(a, b) {
    const A = this.sNormalize(a);
    const B = this.sNormalize(b);
    const num = this.sMulRaw(this.sBare(A), this.sBare(B));
    if (!A.sDen && !B.sDen) return num;
    const den = this.sMulRaw(this.sDenOf(A), this.sDenOf(B));
    return this.sCollapse({ sTerms: num.sTerms, sDen: den });
  }

  sMulRaw(A, B) {
    const terms = [];
    for (const at of A.sTerms) {
      for (const bt of B.sTerms) {
        terms.push(this.sMultiplyTerm(at, bt));
      }
    }
    return this.sMerge(terms);
  }

  sMultiplyTerm(a, b) {
    const t = {
      coef: this.multiplyValues(a.coef, b.coef),
      pw: this.pwAdd(a.pw, b.pw),
      abs: this.absAdd(a.abs, b.abs)
    };

    if (a.root && b.root) {
      const p = a.root.index;
      const q = b.root.index;
      if (p === q) {
        t.root = { poly: this.sMul(a.root.poly, b.root.poly), index: p };
      } else {
        t.root = {
          poly: this.sMul(this.sPow(a.root.poly, q), this.sPow(b.root.poly, p)),
          index: p * q
        };
      }
    } else if (a.root) {
      t.root = { poly: this.sClone(a.root.poly), index: a.root.index };
    } else if (b.root) {
      t.root = { poly: this.sClone(b.root.poly), index: b.root.index };
    }

    return this.foldNumericRadical(this.foldAbsIntoPw(t));
  }

  // 数值根式与同指数的根式因子合并：√2 · √p = √(2p)
  foldNumericRadical(t) {
    const c = t.coef;
    if (t.root && c && !this.isPoly(c) && !this.isPolyRadical(c) &&
        c.radicand > 1 && c.index === t.root.index) {
      const extra = this.sFromPlain({ coef: 1, radicand: c.radicand, index: 1, den: 1 });
      t.root = { poly: this.sMul(t.root.poly, extra), index: t.root.index };
      t.coef = { coef: c.coef, radicand: 1, index: 1, den: c.den };
    }
    return t;
  }

  sDiv(a, b) {
    const A = this.sNormalize(a);
    const B = this.sNormalize(b);
    if (this.sIsZero(B)) throw new Error("除零");
    const num = this.sMulRaw(this.sBare(A), this.sDenOf(B));
    const den = this.sMulRaw(this.sDenOf(A), this.sBare(B));
    if (this.sIsOne(den)) return this.sNormalize(num);
    return this.sCollapse({ sTerms: num.sTerms, sDen: den });
  }

  sPow(base, n) {
    if (!Number.isSafeInteger(n)) throw new Error("指数必须为整数");
    if (n === 0) return this.sOne();
    if (n < 0) return this.sDiv(this.sOne(), this.sPow(base, -n));

    let result = this.sOne();
    let cur = this.sNormalize(base);
    let e = n;

    while (e > 0) {
      if (e % 2 === 1) result = this.sMul(result, cur);
      e = Math.floor(e / 2);
      if (e > 0) cur = this.sMul(cur, cur);
    }

    return result;
  }

  // 分式收敛：能整除就整除，否则保留分式
  sCollapse(v) {
    if (!v.sDen) return this.sNormalize(v);

    const num = this.sNormalize(this.sBare(v));
    const den = this.sNormalize(v.sDen);

    if (this.sIsZero(num)) return this.sZero();
    if (this.sIsZero(den)) throw new Error("除零");
    if (this.sIsOne(den)) return num;

    // 单项式分母：逐项相除，把负幂留在项里（输出时再转成分式）
    if (den.sTerms.length === 1 &&
        !(den.sTerms[0].abs && Object.keys(den.sTerms[0].abs).length) &&
        !den.sTerms[0].root) {
      const dt = den.sTerms[0];
      const terms = num.sTerms.map(t => {
        const r = {
          coef: this.divideValues(t.coef, dt.coef),
          pw: this.pwSub(t.pw, dt.pw),
          abs: t.abs
        };
        if (t.root) r.root = t.root;
        return r;
      });
      return this.sMerge(terms);
    }

    // 多项式分母：尝试精确除法
    const exact = this.sTryExactDivide(num, den);
    if (exact) return exact;

    return { sTerms: num.sTerms, sDen: den };
  }

  // ---------- 多项式精确除法（多变量长除法） ----------

  sTryExactDivide(A, B) {
    if (!B.sTerms || B.sTerms.length < 2) return null;

    const ok = t => !t.root && !(t.abs && Object.keys(t.abs).length) &&
      !(t.pw && (t.pw.a < 0 || t.pw.b < 0 || t.pw.h < 0)) &&
      !this.isPoly(t.coef) && !this.isPolyRadical(t.coef) &&
      t.coef && t.coef.radicand === 1 && t.coef.index === 1 && t.coef.coef !== 0;

    if (!A.sTerms.every(ok) || !B.sTerms.every(ok)) return null;

    let R = this.sMerge(A.sTerms.map(t => this.sCloneTerm(t)));
    let Q = this.sZero();
    let guard = 0;

    while (R.sTerms.length > 0) {
      if (++guard > 300) return null;

      const rt = this.sLeadTerm(R);
      const dt = this.sLeadTerm(B);
      const qpw = this.pwSub(rt.pw, dt.pw);

      for (const name of Monomial.PARAMS) {
        if ((qpw[name] || 0) < 0) return null;
      }

      const qcoef = this.sDivideRational(rt.coef, dt.coef);
      if (!qcoef) return null;

      const qterm = { coef: qcoef, pw: qpw };
      Q = this.sAddRaw(Q, { sTerms: [this.sCloneTerm(qterm)] });

      const sub = this.sMulRaw({ sTerms: [this.sCloneTerm(qterm)] }, B);
      R = this.sMerge([...R.sTerms, ...this.sNeg(sub).sTerms]);
    }

    return Q;
  }

  sTermOrder(t) {
    const pw = t.pw || {};
    const a = pw.a || 0, b = pw.b || 0, h = pw.h || 0;
    return (a + b + h) * 1000000 + a * 10000 + b * 100 + h;
  }

  sLeadTerm(v) {
    let best = null;
    for (const t of v.sTerms) {
      if (!best || this.sTermOrder(t) > this.sTermOrder(best)) best = t;
    }
    return best;
  }

  sDivideRational(a, b) {
    if (!a || !b || b.coef === 0) return null;
    return this.normalizeValue({
      coef: a.coef * b.den,
      radicand: 1,
      index: 1,
      den: a.den * b.coef
    });
  }

  // ---------- 含参数根式 ----------

  sRoot(v, k) {
    if (!Number.isInteger(k) || k <= 0) throw new Error("根指数必须为正整数");

    const value = this.sNormalize(v);
    if (this.sIsZero(value)) return this.sZero();

    if (value.sDen) {
      return this.sCollapse(this.sFrac(
        this.sRoot(this.sBare(value), k),
        this.sRoot(value.sDen, k)
      ));
    }

    if (value.sTerms.length === 1) {
      const wrapped = {
        coef: this.plainOne(),
        root: { poly: { sTerms: [this.sCloneTerm(value.sTerms[0])] }, index: k }
      };
      return this.sMerge([this.sReduceRootTerm(wrapped)]);
    }

    return {
      sTerms: [{
        coef: this.plainOne(),
        root: { poly: this.sClone(value), index: k }
      }]
    };
  }

  // 把 {coef, pw, abs, root} 中的根式能提出来的部分提出来
  sReduceRootTerm(term) {
    if (!term.root) return term;

    const k = term.root.index;
    const P = this.sNormalize(term.root.poly);

    if (this.sIsZero(P)) return { coef: this.plainZero(), pw: {} };

    if (P.sTerms.length !== 1 || P.sDen) {
      return { ...this.sCloneTerm(term), root: { poly: P, index: k } };
    }

    const inner = P.sTerms[0];

    if (inner.root || this.isPoly(inner.coef) ||
        (inner.abs && Object.keys(inner.abs).length)) {
      return { ...this.sCloneTerm(term), root: { poly: P, index: k } };
    }

    const coefRoot = this.rootValue(inner.coef, k);
    const outPw = {};
    const outAbs = {};
    const remPw = {};
    const pw = inner.pw || {};

    for (const name of Monomial.PARAMS) {
      const e = pw[name] || 0;
      if (e === 0) continue;
      if (e < 0) { remPw[name] = e; continue; }

      const q = Math.floor(e / k);
      const rem = e - q * k;
      if (rem !== 0) remPw[name] = rem;
      if (q === 0) continue;

      if (k % 2 === 0) {
        if (q % 2 === 1) outAbs[name] = (outAbs[name] || 0) + 1;
        if (q - (q % 2) !== 0) outPw[name] = (outPw[name] || 0) + (q - (q % 2));
      } else {
        outPw[name] = (outPw[name] || 0) + q;
      }
    }

    const result = {
      coef: this.multiplyValues(term.coef, coefRoot),
      pw: this.pwAdd(term.pw, outPw),
      abs: this.absAdd(term.abs, outAbs)
    };

    if (Object.keys(remPw).length > 0) {
      result.root = {
        poly: { sTerms: [{ coef: this.plainOne(), pw: remPw }] },
        index: k
      };
    }

    return this.foldNumericRadical(this.foldAbsIntoPw(result));
  }

  // ---------- 绝对值 ----------

  sAbs(v) {
    const value = this.sNormalize(v);

    if (value.sDen) {
      return this.sCollapse(this.sFrac(
        this.sAbs(this.sBare(value)),
        this.sAbs(value.sDen)
      ));
    }

    if (value.sTerms.length !== 1) {
      throw new Error("暂不支持对含参数的多项式取绝对值");
    }

    const t = value.sTerms[0];
    if (t.root) throw new Error("暂不支持对含参数的根式取绝对值");
    if (this.isPoly(t.coef)) throw new Error("暂不支持该绝对值运算");

    const coef = this.absNumeric(t.coef);
    const pw = {};
    const abs = this.absAdd({}, t.abs);
    const raw = t.pw || {};

    for (const name of Monomial.PARAMS) {
      const e = raw[name] || 0;
      if (e === 0) continue;
      if (e < 0) throw new Error("暂不支持对含参数的分式取绝对值");
      if (e % 2 === 1) {
        abs[name] = (abs[name] || 0) + 1;
        if (e > 1) pw[name] = e - 1;
      } else {
        pw[name] = e;
      }
    }

    return this.sMerge([{ coef, pw, abs }]);
  }

  absNumeric(v) {
    if (this.isPoly(v)) throw new Error("暂不支持该绝对值运算");
    return { ...v, coef: Math.abs(v.coef) };
  }

  // ---------- 符号值输出 ----------

  sValueToString(v) {
    const value = this.sNormalize(v);

    if (this.sIsZero(value)) return '0';

    if (value.sDen) {
      return Monomial.formatFraction(
        this.sValueToString(this.sBare(value)),
        this.sValueToString(value.sDen)
      );
    }

    let result = '';

    value.sTerms.forEach((t, i) => {
      const neg = this.valueIsNegative(t.coef);
      const term = this.sCloneTerm(t);
      if (neg) term.coef = this.negateValue(term.coef);
      const body = this.sTermToString(term);

      if (i === 0) result += (neg ? '-' : '') + body;
      else result += (neg ? '-' : '+') + body;
    });

    return result;
  }

  sTermToString(t) {
    const pw = t.pw || {};
    const abs = t.abs || {};
    const numFactors = [];
    const denFactors = [];

    for (const name of Monomial.PARAMS) {
      const e = pw[name] || 0;
      if (e > 0) numFactors.push(e === 1 ? name : Monomial.formatPower(name, e));
      else if (e < 0) denFactors.push(e === -1 ? name : Monomial.formatPower(name, -e));
      if (abs[name]) numFactors.push(`abs(${name})`);
    }

    if (t.root) {
      const inner = this.sValueToString(t.root.poly);
      numFactors.push(t.root.index === 2
        ? Monomial.formatSqrt(inner)
        : Monomial.formatRoot(t.root.index, inner));
    }

    const c = t.coef;
    const rational = !this.isPoly(c) && !this.isPolyRadical(c) &&
      c.radicand === 1 && c.index === 1;

    let numStr;

    if (rational) {
      const cn = Math.abs(c.coef);
      const cd = Math.abs(c.den) || 1;
      const parts = [];
      if (cn !== 1 || numFactors.length === 0) parts.push(String(cn));
      parts.push(...numFactors);
      numStr = parts.join('*') || '1';
      if (cd !== 1) denFactors.unshift(String(cd));
    } else {
      let coefStr = this.valueToString(c);
      if (Monomial.isSumString(coefStr)) coefStr = `(${coefStr})`;
      const parts = [];
      if (!(coefStr === '1' && numFactors.length > 0)) parts.push(coefStr);
      parts.push(...numFactors);
      numStr = parts.join('*') || coefStr;
    }

    const denStr = denFactors.join('*');
    if (denStr) return Monomial.formatFraction(numStr, denStr);
    return numStr;
  }

  // ==================== 杂项 ====================

  gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    return b === 0 ? a : this.gcd(b, a % b);
  }

  rootOfInteger(N, k) {
    if (N === 0) return { coef: 0, radicand: 1, index: 1, den: 1 };
    const isNeg = N < 0;
    if (isNeg && k % 2 === 0) throw new Error("偶次根号负数");

    const absN = Math.abs(N);
    const factors = this.factorize(absN);

    let g = k;
    for (const p in factors) g = this.gcd(g, factors[p]);
    if (g > 1) {
      k = k / g;
      for (const p in factors) factors[p] = factors[p] / g;
    }

    let coef = 1, radicand = 1;
    for (const p in factors) {
      const e = factors[p];
      const pi = parseInt(p, 10);
      const full = Math.floor(e / k);
      const rem = e % k;
      coef *= Math.pow(pi, full);
      radicand *= Math.pow(pi, rem);
    }
    if (isNeg) coef = -coef;

    if (radicand === 1) return { coef, radicand: 1, index: 1, den: 1 };
    return { coef, radicand, index: k, den: 1 };
  }

  factorize(n) {
    const factors = {};
    n = Math.abs(n);
    for (let d = 2; d * d <= n; d++) {
      while (n % d === 0) {
        factors[d] = (factors[d] || 0) + 1;
        n /= d;
      }
    }
    if (n > 1) factors[n] = (factors[n] || 0) + 1;
    return factors;
  }

  // ==================== 对外接口 ====================

  add(other) {
    const a = this.evalExpression(this.expression);
    const b = other.evalExpression(other.expression);
    return new Monomial(this.valueToString(this.addValues(a, b)));
  }

  sub(other) {
    const a = this.evalExpression(this.expression);
    const b = other.evalExpression(other.expression);
    return new Monomial(this.valueToString(this.subValues(a, b)));
  }

  mul(other) {
    const a = this.evalExpression(this.expression);
    const b = other.evalExpression(other.expression);
    return new Monomial(this.valueToString(this.multiplyValues(a, b)));
  }

  div(other) {
    const a = this.evalExpression(this.expression);
    const b = other.evalExpression(other.expression);
    return new Monomial(this.valueToString(this.divideValues(a, b)));
  }
}

if (typeof window !== 'undefined') {
  window.Monomial = Monomial;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Monomial;
}
