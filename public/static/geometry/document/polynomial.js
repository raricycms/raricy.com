class Polynomial {
  constructor(expression) {
    this.expression = String(expression ?? '').trim();
    this.engine = new Monomial('0');
  }

  // ==================================================
  // 一、静态入口
  // ==================================================

  static simplifyExpression(expr) {
    try {
      return new Polynomial(expr).simplify();
    } catch (e) {
      return `错误: ${e.message}`;
    }
  }

  static operate(a, op, b) {
    const A = new Polynomial(a);
    const B = new Polynomial(b);

    const av = A.parse();
    const bv = B.parse();

    let result;

    switch (op) {
      case '+':
        result = A.addPoly(av, bv);
        break;
      case '-':
        result = A.subPoly(av, bv);
        break;
      case '*':
        result = A.mulPoly(av, bv);
        break;
      case '/':
        result = A.divPoly(av, bv);
        break;
      default:
        throw new Error('未知运算符: ' + op);
    }

    return A.polyToString(result);
  }

  simplify() {
    try {
      return this.polyToString(this.parse());
    } catch (e) {
      return `错误: ${e.message}`;
    }
  }

  // ==================================================
  // 二、数据结构
  //
  // 多项式：
  // {
  //   terms: [
  //     {
  //       coef: MonomialValue,
  //       factors: [
  //         {
  //           index: 2,
  //           radicand: Polynomial
  //         }
  //       ]
  //     }
  //   ]
  // }
  // ==================================================

  zero() {
    return { terms: [] };
  }

  one() {
    return {
      terms: [{
        coef: this.scalar(1),
        factors: [],
        pw: {},
        abs: {}
      }]
    };
  }

  isZero(p) {
    return p.terms.length === 0;
  }

  // ==================================================
  // 二·五、参数（符号）支持
  //
  // 参数固定为 a、b、h。
  // 每一项在 coef / factors 之外增加：
  //   pw  : 参数幂，例如 { a: 2, b: -1 }
  //   abs : 绝对值因子，例如 { a: 1 } 表示 |a|
  // ==================================================

  pwKey(pw) {
    if (!pw) return '0,0,0';
    return `${pw.a || 0},${pw.b || 0},${pw.h || 0}`;
  }

  absKey(abs) {
    return this.pwKey(abs);
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

  // |a|^2 = a^2
  foldAbs(term) {
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
    return { coef: term.coef, factors: term.factors, pw, abs };
  }

  paramPoly(name) {
    if (!Monomial.isParam(name)) throw new Error('未知参数: ' + name);
    const pw = {};
    pw[name] = 1;
    return {
      terms: [{
        coef: this.scalar(1),
        factors: [],
        pw,
        abs: {}
      }]
    };
  }

  hasParams(p) {
    return p.terms.some(t =>
      (t.pw && (t.pw.a || t.pw.b || t.pw.h)) ||
      (t.abs && (t.abs.a || t.abs.b || t.abs.h))
    );
  }

  // 多项式 → 符号值（供 Monomial 的符号运算使用）
  toSValue(p) {
    const terms = [];
    for (const t of p.terms) {
      if (t.factors.length > 0) return null;
      const term = { coef: t.coef, pw: { ...(t.pw || {}) } };
      const abs = { ...(t.abs || {}) };
      if (Object.keys(abs).length) term.abs = abs;
      terms.push(term);
    }
    return { sTerms: terms };
  }

  // 符号值 → 多项式（无法表示时返回 null，例如分式）
  fromSValue(sv) {
    if (!sv || sv.sDen) return null;

    const terms = [];

    for (const t of sv.sTerms) {
      let coef = t.coef;

      if (this.engine.isPoly(coef)) return null;

      const factors = [];

      if (this.engine.isPolyRadical(coef)) {
        factors.push({
          index: coef.polyRootIndex,
          radicand: coef.polyRadicand
        });
        coef = { coef: coef.coef, radicand: 1, index: 1, den: coef.den };
      }

      if (t.root) {
        const inner = this.fromSValue(t.root.poly);
        if (!inner) return null;
        factors.push({ index: t.root.index, radicand: inner });
      }

      terms.push({
        coef,
        factors,
        pw: { ...(t.pw || {}) },
        abs: { ...(t.abs || {}) }
      });
    }

    return this.normalize({ terms });
  }

  // ==================================================
  // 三、底层单项式接口
  // ==================================================

  scalar(n) {
    return {
      coef: Number(n),
      radicand: 1,
      index: 1,
      den: 1
    };
  }

  scalarClone(v) {
    return {
      coef: v.coef,
      radicand: v.radicand,
      index: v.index,
      den: v.den
    };
  }

  scalarAdd(a, b) {
    return this.engine.addValues(a, b);
  }

  scalarSub(a, b) {
    return this.engine.subValues(a, b);
  }

  scalarMul(a, b) {
    return this.engine.multiplyValues(a, b);
  }

  scalarDiv(a, b) {
    return this.engine.divideValues(a, b);
  }

  scalarNeg(a) {
    return {
      ...a,
      coef: -a.coef
    };
  }

  scalarInteger(v) {
    return this.engine.valueToInteger(v);
  }

  // ==================================================
  // 四、表达式解析工具
  // ==================================================

  splitTopLevel(expr, ops) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let lastOp = null;

    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];

      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;

        if (depth < 0) {
          throw new Error('括号不匹配');
        }
      } else if (depth === 0 && ops.includes(ch)) {

        if (
          (ch === '+' || ch === '-') &&
          (
            i === 0 ||
            '+-*/,(,'.includes(expr[i - 1])
          )
        ) {
          continue;
        }

        parts.push({
          op: lastOp,
          value: expr.slice(start, i)
        });

        lastOp = ch;
        start = i + 1;
      }
    }

    if (depth !== 0) {
      throw new Error('括号不匹配');
    }

    parts.push({
      op: lastOp,
      value: expr.slice(start)
    });

    return parts;
  }

  isWrapped(expr) {
    if (!expr.startsWith('(') || !expr.endsWith(')')) {
      return false;
    }

    let depth = 0;

    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      if (expr[i] === ')') depth--;

      if (depth === 0 && i < expr.length - 1) {
        return false;
      }

      if (depth < 0) return false;
    }

    return depth === 0;
  }

  unwrap(expr) {
    expr = expr.trim();

    while (this.isWrapped(expr)) {
      expr = expr.slice(1, -1).trim();
    }

    return expr;
  }

  extractContent(expr, start) {
    if (expr[start] !== '(') return null;

    let depth = 0;

    for (let i = start; i < expr.length; i++) {
      if (expr[i] === '(') depth++;

      if (expr[i] === ')') {
        depth--;

        if (depth === 0) {
          return expr.slice(start + 1, i);
        }
      }
    }

    return null;
  }

  splitArguments(content) {
    const result = [];
    let depth = 0;
    let start = 0;

    for (let i = 0; i < content.length; i++) {
      if (content[i] === '(') depth++;
      else if (content[i] === ')') depth--;
      else if (content[i] === ',' && depth === 0) {
        result.push(content.slice(start, i).trim());
        start = i + 1;
      }
    }

    result.push(content.slice(start).trim());

    return result;
  }

  parseCall(expr) {
    const m = /^([a-zA-Z_]\w*)\(/.exec(expr);

    if (!m) return null;

    const name = m[1];
    const inner = this.extractContent(expr, name.length);

    if (inner === null) return null;

    if (name.length + inner.length + 1 !== expr.length - 1) {
      return null;
    }

    return {
      name,
      args: this.splitArguments(inner)
    };
  }

  // ==================================================
  // 五、表达式解析主程序
  // ==================================================

  parse(expr = this.expression) {
    expr = this.unwrap(String(expr).trim());

    if (!expr) throw new Error('空表达式');

    // 加减法
    const addParts = this.splitTopLevel(expr, ['+', '-']);

    if (addParts.length > 1) {
      let result = this.parse(addParts[0].value);

      for (let i = 1; i < addParts.length; i++) {
        const next = this.parse(addParts[i].value);

        result = addParts[i].op === '+'
          ? this.addPoly(result, next)
          : this.subPoly(result, next);
      }

      return result;
    }

    // 乘除法
    const mulParts = this.splitTopLevel(expr, ['*', '/']);

    if (mulParts.length > 1) {
      let result = this.parse(mulParts[0].value);

      for (let i = 1; i < mulParts.length; i++) {
        const next = this.parse(mulParts[i].value);

        result = mulParts[i].op === '*'
          ? this.mulPoly(result, next)
          : this.divPoly(result, next);
      }

      return result;
    }

    // 一元正负
    if (expr.startsWith('+')) {
      return this.parse(expr.slice(1));
    }

    if (expr.startsWith('-')) {
      return this.negPoly(this.parse(expr.slice(1)));
    }

    // 整数
    if (/^-?\d+$/.test(expr)) {
      return this.constant(Number(expr));
    }

    // 参数 a / b / h
    if (Monomial.isParam(expr)) {
      return this.paramPoly(expr);
    }

    // 函数
    const call = this.parseCall(expr);

    if (call) {
      return this.evalFunction(call);
    }

    // 普通单项式根式，例如 r(2,3,2)，以及含参数的式子（隐式乘法等）
    const value = this.engine.evalExpression(expr);

    if (this.engine.isSValue(value)) {
      const poly = this.fromSValue(value);
      if (poly) return poly;
      throw new Error('暂不支持该含参数表达式');
    }

    return {
      terms: [{
        coef: value,
        factors: [],
        pw: {},
        abs: {}
      }]
    };
  }

  evalFunction({ name, args }) {
    switch (name) {
      case 'd': {
        if (args.length !== 2) {
          throw new Error('d() 需要两个参数');
        }

        return this.divPoly(
          this.parse(args[0]),
          this.parse(args[1])
        );
      }

      case 'p': {
        if (args.length !== 2) {
          throw new Error('p() 需要两个参数');
        }

        const base = this.parse(args[0]);
        const expPoly = this.parse(args[1]);

        if (expPoly.terms.length !== 1) {
          throw new Error('指数必须是整数');
        }

        const exp = this.scalarInteger(
          expPoly.terms[0].coef
        );

        if (exp === null) {
          throw new Error('指数必须是整数');
        }

        return this.powPoly(base, exp);
      }

      case 'sqrt':
      case 'root': {
        const k = name === 'sqrt' ? 2 : 0;

        if (name === 'sqrt' && args.length !== 1) {
          throw new Error('sqrt() 需要一个参数');
        }

        if (name === 'root' && args.length !== 2) {
          throw new Error('root() 需要两个参数');
        }

        let index = k;
        let radicand;

        if (name === 'root') {
          const indexPoly = this.parse(args[0]);

          if (indexPoly.terms.length !== 1) {
            throw new Error('根指数必须为整数');
          }

          index = this.scalarInteger(
            indexPoly.terms[0].coef
          );

          if (index === null || index <= 0) {
            throw new Error('根指数必须为正整数');
          }

          radicand = this.parse(args[1]);
        } else {
          radicand = this.parse(args[0]);
        }

        return this.rootPoly(radicand, index);
      }

      case 'r': {
        if (args.length !== 3) {
          throw new Error('r() 需要三个参数');
        }

        const value = this.engine.evalExpression(
          `r(${args.join(',')})`
        );

        return {
          terms: [{
            coef: value,
            factors: [],
            pw: {},
            abs: {}
          }]
        };
      }

      default:
        throw new Error('未知函数: ' + name);
    }
  }

  // ==================================================
  // 六、常数多项式
  // ==================================================

  constant(n) {
    if (n === 0) return this.zero();

    return {
      terms: [{
        coef: this.scalar(n),
        factors: [],
        pw: {},
        abs: {}
      }]
    };
  }

  // ==================================================
  // 七、项与根式处理
  // ==================================================

  clonePoly(p) {
    return {
      terms: p.terms.map(t => ({
        coef: this.scalarClone(t.coef),
        factors: t.factors.map(f => ({
          index: f.index,
          radicand: this.clonePoly(f.radicand)
        })),
        pw: { ...(t.pw || {}) },
        abs: { ...(t.abs || {}) }
      }))
    };
  }

  factorKey(f) {
    return `${f.index}:${this.polyToString(f.radicand)}`;
  }

  termKey(t) {
    return [
      t.coef.radicand,
      t.coef.index,
      this.pwKey(t.pw),
      this.absKey(t.abs),
      ...t.factors.map(f => this.factorKey(f)).sort()
    ].join('|');
  }

  normalizeFactors(factors, coef) {
    const result = [];

    for (const f of factors) {
      if (this.isZero(f.radicand)) {
        return {
          coef: this.scalar(0),
          factors: []
        };
      }

      if (this.isOne(f.radicand)) {
        continue;
      }

      // 常数多项式根式交给 Monomial 处理（含参数或绝对值时保持原样）
      if (f.radicand.terms.length === 1) {
        const t = f.radicand.terms[0];

        const plainTerm =
          (!t.pw || (!t.pw.a && !t.pw.b && !t.pw.h)) &&
          (!t.abs || (!t.abs.a && !t.abs.b && !t.abs.h));

        if (t.factors.length === 0 && plainTerm) {
          const root = this.engine.rootValue(
            t.coef,
            f.index
          );

          coef = this.scalarMul(coef, root);
          continue;
        }
      }

      result.push({
        index: f.index,
        radicand: f.radicand
      });
    }

    return { coef, factors: result };
  }

  // 系数里是否含根式（如 r(1,2,2) = √2、r(3,5,2) = 3√5）
  isRootCoefficient(v) {
    return !!v &&
      !this.engine.isPolyRadical(v) &&
      v.coef !== 0 &&
      v.radicand > 1 &&
      v.index > 1;
  }

  // 合并同指数根式
  mergeFactors(a, b) {
    const factors = a.factors.map(f => ({
      index: f.index,
      radicand: this.clonePoly(f.radicand)
    }));

    for (const bf of b.factors) {
      const found = factors.find(
        f => f.index === bf.index
      );

      if (found) {
        found.radicand = this.mulPoly(
          found.radicand,
          bf.radicand
        );
      } else {
        factors.push({
          index: bf.index,
          radicand: this.clonePoly(bf.radicand)
        });
      }
    }

    let coef = this.scalarMul(a.coef, b.coef);

    // 【新增】根号相乘：把系数里的根式提升成同指数因子再合并
    //   √2 · √(2+√3) = √(2·(2+√3)) = √(4+2√3)
    if (this.isRootCoefficient(coef)) {
      const radicand = this.constant(coef.radicand);
      const found = factors.find(f => f.index === coef.index);

      if (found) {
        found.radicand = this.mulPoly(found.radicand, radicand);
      } else {
        factors.push({ index: coef.index, radicand });
      }

      coef = {
        coef: coef.coef,
        radicand: 1,
        index: 1,
        den: coef.den
      };
    }

    const normalized = this.normalizeFactors(factors, coef);

    return {
      coef: normalized.coef,
      factors: normalized.factors,
      pw: this.pwAdd(a.pw, b.pw),
      abs: this.absAdd(a.abs, b.abs)
    };
  }

  // ==================================================
  // 八、多项式规范化
  // ==================================================

  normalize(p) {
    const map = new Map();

    for (const original of p.terms) {
      const t = this.foldAbs({
        coef: this.scalarClone(original.coef),
        factors: original.factors,
        pw: { ...(original.pw || {}) },
        abs: { ...(original.abs || {}) }
      });

      const normalized = this.normalizeFactors(
        t.factors,
        t.coef
      );

      if (normalized.coef.coef === 0) continue;

      const term = {
        coef: normalized.coef,
        factors: normalized.factors,
        pw: t.pw,
        abs: t.abs
      };

      const key = [
        term.coef.radicand,
        term.coef.index,
        this.pwKey(term.pw),
        this.absKey(term.abs),
        ...term.factors.map(f => this.factorKey(f)).sort()
      ].join('|');

      if (!map.has(key)) {
        map.set(key, term);
      } else {
        const old = map.get(key);

        old.coef = this.scalarAdd(
          old.coef,
          term.coef
        );
      }
    }

    const terms = [];

    for (const t of map.values()) {
      if (t.coef.coef !== 0) {
        terms.push(t);
      }
    }

    return { terms };
  }

  isOne(p) {
    if (p.terms.length !== 1) return false;
    const t = p.terms[0];
    return (
      t.factors.length === 0 &&
      !(t.pw && (t.pw.a || t.pw.b || t.pw.h)) &&
      !(t.abs && (t.abs.a || t.abs.b || t.abs.h)) &&
      t.coef.coef === 1 &&
      t.coef.den === 1 &&
      t.coef.radicand === 1
    );
  }

  // ==================================================
  // 九、多项式加减
  // ==================================================

  addPoly(a, b) {
    return this.normalize({
      terms: [
        ...this.clonePoly(a).terms,
        ...this.clonePoly(b).terms
      ]
    });
  }

  negPoly(a) {
    return {
      terms: a.terms.map(t => ({
        coef: this.scalarNeg(t.coef),
        factors: t.factors,
        pw: { ...(t.pw || {}) },
        abs: { ...(t.abs || {}) }
      }))
    };
  }

  subPoly(a, b) {
    return this.addPoly(a, this.negPoly(b));
  }

  // ==================================================
  // 十、多项式乘法
  // ==================================================

  multiplyTerms(a, b) {
    const merged = this.mergeFactors(a, b);

    return {
      coef: merged.coef,
      factors: merged.factors,
      pw: merged.pw,
      abs: merged.abs
    };
  }

  mulPoly(a, b) {
    const result = [];

    for (const at of a.terms) {
      for (const bt of b.terms) {
        result.push(
          this.multiplyTerms(at, bt)
        );
      }
    }

    return this.normalize({ terms: result });
  }

  // ==================================================
  // 十一、多项式幂
  // ==================================================

  powPoly(base, n) {
    if (!Number.isSafeInteger(n)) {
      throw new Error('指数必须为整数');
    }

    if (n === 0) return this.one();

    if (n < 0) {
      return this.divPoly(
        this.one(),
        this.powPoly(base, -n)
      );
    }

    let result = this.one();
    let current = this.clonePoly(base);
    let exp = n;

    while (exp > 0) {
      if (exp % 2 === 1) {
        result = this.mulPoly(result, current);
      }

      exp = Math.floor(exp / 2);

      if (exp > 0) {
        current = this.mulPoly(current, current);
      }
    }

    return result;
  }

  // ==================================================
  // 十二、多项式开根
  // ==================================================

  rootPoly(p, k) {
    if (!Number.isInteger(k) || k <= 0) {
      throw new Error('根指数必须为正整数');
    }

    if (this.isZero(p)) return this.zero();

    // 单项式：直接处理系数、参数幂与已有根式
    if (p.terms.length === 1) {
      const t = p.terms[0];

      if (t.factors.length === 0) {
        // 数值系数开根
        const coefRoot = this.engine.rootValue(t.coef, k);

        // 参数幂提取：偶次根号按绝对值处理
        const pw = {};
        const outAbs = {};
        const inAbs = { ...(t.abs || {}) };
        const remPw = {};
        const source = t.pw || {};

        for (const name of Monomial.PARAMS) {
          const e = source[name] || 0;
          if (e === 0) continue;
          if (e < 0) { remPw[name] = e; continue; }

          const q = Math.floor(e / k);
          const rem = e - q * k;
          if (rem !== 0) remPw[name] = rem;
          if (q === 0) continue;

          if (k % 2 === 0) {
            if (q % 2 === 1) outAbs[name] = (outAbs[name] || 0) + 1;
            if (q - (q % 2) !== 0) pw[name] = (pw[name] || 0) + (q - (q % 2));
          } else {
            pw[name] = (pw[name] || 0) + q;
          }
        }

        let coef = coefRoot;
        const hasRemainder =
          Object.keys(remPw).length > 0 ||
          Object.keys(inAbs).length > 0;

        if (hasRemainder) {
          let radicand = {
            terms: [{
              coef: this.scalar(1),
              factors: [],
              pw: { ...remPw },
              abs: { ...inAbs }
            }]
          };

          // 数值根式的被开方数并入根号：2√2 · √a = 2√(2a)
          if (!this.engine.isPoly(coef) && !this.engine.isPolyRadical(coef) &&
              coef.radicand > 1 && coef.index === k) {
            radicand = this.mulPoly(radicand, this.constant(coef.radicand));
            coef = { coef: coef.coef, radicand: 1, index: 1, den: coef.den };
          }

          return this.normalize({
            terms: [{
              coef,
              factors: [{ index: k, radicand }],
              pw,
              abs: outAbs
            }]
          });
        }

        return this.normalize({
          terms: [{
            coef,
            factors: [],
            pw,
            abs: outAbs
          }]
        });
      }

      // 单项式中已有根式时，将整个项作为根式内部
    }

    // 多项式根式作为一个完整因子保存
    return {
      terms: [{
        coef: this.scalar(1),
        factors: [{
          index: k,
          radicand: this.clonePoly(p)
        }],
        pw: {},
        abs: {}
      }]
    };
  }

  // ==================================================
  // 十三、多项式相等判断
  // ==================================================

  polyEqual(a, b) {
    const A = this.normalize(a);
    const B = this.normalize(b);

    if (A.terms.length !== B.terms.length) return false;

    const key = t =>
      this.engine.valueToString(t.coef) +
      '#' +
      this.termKey(t);

    const ka = A.terms.map(key).sort();
    const kb = B.terms.map(key).sort();

    return ka.every((v, i) => v === kb[i]);
  }

  // ==================================================
  // 十四、多项式除法与有理化
  // ==================================================

  divPoly(a, b, depth = 0) {
    if (this.isZero(b)) {
      throw new Error('除数不能为零');
    }

    if (depth > 12) {
      throw new Error('多项式有理化层次过深');
    }

    // 分母含参数（a、b、h）时的处理
    if (this.hasParams(b)) {
      if (b.terms.length === 1) {
        return this.divideByTerm(a, b.terms[0]);
      }

      const exact = this.tryDivideSymbolic(a, b);
      if (exact) return exact;

      throw new Error('分母含参数且无法整除，暂不支持进一步化简');
    }

    // 单项式分母
    if (b.terms.length === 1) {
      return this.divideByTerm(a, b.terms[0]);
    }

    // 多项式分母
    return this.rationalizePoly(a, b, depth);
  }

  // 借助 Monomial 的符号层做多变量精确除法
  tryDivideSymbolic(a, b) {
    try {
      const A = this.toSValue(a);
      const B = this.toSValue(b);
      if (!A || !B) return null;

      const q = this.engine.sTryExactDivide(A, B);
      if (!q) return null;

      return this.fromSValue(q);
    } catch (e) {
      return null;
    }
  }

  divideByTerm(a, b) {
    if (b.abs && (b.abs.a || b.abs.b || b.abs.h)) {
      throw new Error('暂不支持以含绝对值的项作分母');
    }

    const result = [];

    for (const at of a.terms) {
      const inverse = {
        coef: this.scalarDiv(
          at.coef,
          b.coef
        ),
        factors: [
          ...at.factors
        ],
        pw: this.pwSub(at.pw, b.pw),
        abs: { ...(at.abs || {}) }
      };

      // 分母含根式时，先使用根式的倒数
      for (const f of b.factors) {
        inverse.factors.push({
          index: f.index,
          radicand: this.powPoly(
            f.radicand,
            f.index - 1
          )
        });

        inverse.coef = this.scalarDiv(
          inverse.coef,
          this.scalar(1)
        );

        // 1 / root(k,R) = root(k,R^(k-1)) / R
        // R 作为多项式分母，交给有理化程序处理
        inverse.denominator = f.radicand;
      }

      result.push(inverse);
    }

    let output = this.normalize({ terms: result });

    for (const f of b.factors) {
      output = this.divPoly(
        output,
        f.radicand
      );
    }

    return output;
  }

  rationalizePoly(a, b, depth = 0) {
    if (depth > 12) {
      throw new Error('有理化层次过深');
    }

    if (b.terms.length === 1) {
      return this.divideByTerm(a, b.terms[0]);
    }

    // 将分母分成第一项和剩余项
    const first = {
      terms: [b.terms[0]]
    };

    const rest = {
      terms: b.terms.slice(1)
    };

    // 共轭：first - rest
    const conjugate = this.subPoly(first, rest);

    const newDen = this.mulPoly(b, conjugate);
    const newNum = this.mulPoly(a, conjugate);

    if (this.polyEqual(newDen, b)) {
      throw new Error('无法进一步有理化');
    }

    if (newDen.terms.length >= b.terms.length) {
      throw new Error('当前分母无法通过共轭继续化简');
    }

    return this.rationalizePoly(
      newNum,
      newDen,
      depth + 1
    );
  }

  // ==================================================
  // 十五、字符串输出
  // ==================================================

  scalarToString(v) {
    return this.engine.valueToString(v);
  }

  factorToString(f) {
    const inner = this.polyToString(f.radicand);

    if (f.index === 2) {
      return `sqrt(${inner})`;
    }

    return `root(${f.index},${inner})`;
  }

  // 单项式字符串：负号一律提到整项最前面，
  // 这样 polyToString 只要看首字符就能决定要不要补 '+'，
  // 不会出现 r(1,3,2)*(...)r(-1,2,2)*(...) 这种丢失运算符的非法结果
  termToString(t) {
    const isNeg = t.coef.coef < 0;

    const positiveTerm = isNeg
      ? { ...t, coef: this.scalarNeg(t.coef) }
      : t;

    const body = this.positiveTermToString(positiveTerm);

    return isNeg ? `-${body}` : body;
  }

  positiveTermToString(t) {
    const isRootValue = this.engine.isPolyRadical(t.coef);

    const coefStr = this.scalarToString(t.coef);

    const numFactors = [];
    const denFactors = [];

    const pw = t.pw || {};
    const abs = t.abs || {};

    for (const name of Monomial.PARAMS) {
      const e = pw[name] || 0;
      if (e > 0) numFactors.push(e === 1 ? name : Monomial.formatPower(name, e));
      else if (e < 0) denFactors.push(e === -1 ? name : Monomial.formatPower(name, -e));
      if (abs[name]) numFactors.push(`abs(${name})`);
    }

    numFactors.push(...t.factors.map(f => this.factorToString(f)));

    const rational = !isRootValue &&
      t.coef.radicand === 1 &&
      t.coef.index === 1;

    let numStr;

    if (rational) {
      const cn = Math.abs(t.coef.coef);
      const cd = Math.abs(t.coef.den) || 1;
      const parts = [];
      if (cn !== 1 || numFactors.length === 0) parts.push(String(cn));
      parts.push(...numFactors);
      numStr = parts.join('*') || '1';
      if (cd !== 1) denFactors.unshift(String(cd));
    } else {
      const parts = [];
      if (!(coefStr === '1' && numFactors.length > 0)) parts.push(coefStr);
      parts.push(...numFactors);
      numStr = parts.join('*') || coefStr;
    }

    const denStr = denFactors.join('*');
    if (denStr) return Monomial.formatFraction(numStr, denStr);
    return numStr;
  }

  polyToString(p) {
    p = this.normalize(p);

    if (p.terms.length === 0) return '0';

    const result = [];

    for (const t of p.terms) {
      const s = this.termToString(t);

      if (result.length === 0 || s.startsWith('-')) {
        result.push(s);
      } else {
        result.push('+' + s);
      }
    }

    return result.join('');
  }

  toString() {
    return this.simplify();
  }

  // ==================================================
  // 十六、对外运算接口
  // ==================================================

  add(other) {
    return this.calculate(other, '+');
  }

  sub(other) {
    return this.calculate(other, '-');
  }

  mul(other) {
    return this.calculate(other, '*');
  }

  div(other) {
    return this.calculate(other, '/');
  }

  calculate(other, op) {
    const A = this.parse();
    const B = new Polynomial(other).parse();

    let result;

    switch (op) {
      case '+':
        result = this.addPoly(A, B);
        break;

      case '-':
        result = this.subPoly(A, B);
        break;

      case '*':
        result = this.mulPoly(A, B);
        break;

      case '/':
        result = this.divPoly(A, B);
        break;

      default:
        throw new Error('未知运算符');
    }

    return this.polyToString(result);
  }

  sqrt() {
    return this.polyToString(
      this.rootPoly(this.parse(), 2)
    );
  }

  root(k) {
    return this.polyToString(
      this.rootPoly(this.parse(), k)
    );
  }

  pow(n) {
    return this.polyToString(
      this.powPoly(this.parse(), n)
    );
  }

  rationalize(denominator) {
    return this.div(denominator);
  }

  // ==================================================
  // 十七、导出
  // ==================================================

  // ==================================================
  // 十八、对外公共接口
  //
  // 页面与公共界面模块（formula-editor.js / formula-render.js）统一调用这里，
  // 不再直接调用 Monomial：
  //   · 化简 / 计算：simplifyExpression、operate、calculate、sqrt、root、pow、evaluate
  //   · 内部输出语法：formatFraction / formatPower / formatSqrt / formatRoot
  //   · 表达式解析（渲染层用）：splitTopLevel / isWrapped / unwrapOuterParens / parseValueString
  // Monomial 只在 Polynomial 内部作为参数表与语法工具使用。
  // ==================================================

  // ---------- 内部输出语法（d/p/sqrt/root） ----------
  // 语法只有一处定义（Monomial），这里只是对外暴露，避免语法被复制两份

  static formatFraction(num, den) {
    return Monomial.formatFraction(num, den);
  }

  static formatPower(base, exp) {
    return Monomial.formatPower(base, exp);
  }

  static formatSqrt(radicand) {
    return Monomial.formatSqrt(radicand);
  }

  static formatRoot(index, radicand) {
    return Monomial.formatRoot(index, radicand);
  }

  // ---------- 表达式解析（供渲染层使用） ----------

  static splitTopLevel(expr, ops) {
    return Monomial.splitTopLevel(expr, ops);
  }

  static isWrapped(expr) {
    return Monomial.isWrapped(expr);
  }

  static unwrapOuterParens(expr) {
    return Monomial.unwrapOuterParens(expr);
  }

  static parseValueString(expr) {
    return Monomial.parseValueString(expr);
  }

  // ---------- 表达式 → 数值 ----------
  // 先把表达式化简，再把化简结果（内部输出语法）求成一个数。
  // 支持：数字、+ - * / ^、括号，
  //       d(a,b) 除法、p(a,b) 幂、sqrt(x) 平方根、root(n,x) n 次方根、
  //       r(系数,被开方数,根指数) 根式、abs(x) 绝对值。
  // 空表达式按 0 处理；含参数或无法得到有限实数时抛错。
  static evaluate(expr) {
    const text = String(expr ?? '').trim();
    if (!text) return 0;

    const simplified = Polynomial.simplifyExpression(text);
    if (/^错误[:：]/.test(simplified)) {
      throw new Error(simplified.replace(/^错误[:：]\s*/, ''));
    }

    const value = Polynomial.evaluateSyntax(simplified);
    if (!Number.isFinite(value)) {
      throw new Error('表达式无法得到有限实数：' + text);
    }
    return value;
  }

  // 直接对一段内部输出语法求值（不做化简）
  static evaluateSyntax(expr) {
    const tokens = String(expr ?? '').match(
      /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-zA-Z_]+|[()+\-*/^,]/gi
    ) || [];
    const ts = tokens.filter(t => !/^\s+$/.test(t));
    let pos = 0;

    const peek = () => ts[pos];
    const consume = () => ts[pos++];

    function expect(value) {
      if (consume() !== value) {
        throw new Error('表达式格式错误');
      }
    }

    // n 次方根：负数允许奇次根
    function nthRoot(n, x) {
      if (n === 0) throw new Error('根指数不能为 0');
      if (x < 0) {
        if (!Number.isInteger(n) || Math.abs(n % 2) !== 1) {
          throw new Error('负数没有实数偶次根');
        }
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    }

    function primary() {
      const token = consume();
      if (token === undefined) throw new Error('表达式不完整');

      // 数字
      if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
        return Number(token);
      }

      // 括号
      if (token === '(') {
        const value = addSub();
        expect(')');
        return value;
      }

      // 函数：d(a,b)、p(a,b)、sqrt(x)、root(n,x)、r(系数,被开方数,根指数)、abs(x)
      if (/^[a-zA-Z_]+$/.test(token)) {
        const name = token.toLowerCase();

        if (peek() !== '(') {
          throw new Error('含参数，无法求出数值：' + token);
        }
        expect('(');

        const a = addSub();
        let b = null;
        let c = null;
        if (peek() === ',') { consume(); b = addSub(); }
        if (peek() === ',') { consume(); c = addSub(); }

        expect(')');

        switch (name) {
          case 'd':
            if (b === null) throw new Error('除法需要两个参数');
            if (b === 0) throw new Error('分母不能为零');
            return a / b;

          case 'p':
            if (b === null) throw new Error('幂需要两个参数');
            return Math.pow(a, b);

          case 'sqrt':
            if (a < 0) throw new Error('负数不能开平方');
            return Math.sqrt(a);

          case 'root':
            if (b === null) throw new Error('根式需要两个参数');
            return nthRoot(a, b);

          case 'r':
            if (b === null || c === null) throw new Error('根式需要三个参数');
            return a * nthRoot(c, b);

          case 'abs':
            return Math.abs(a);

          default:
            throw new Error('不支持的函数：' + name);
        }
      }

      throw new Error('无法识别的内容：' + token);
    }

    function power() {
      let value = primary();

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
      let value = unary();

      while (peek() === '*' || peek() === '/') {
        const op = consume();
        const next = unary();
        value = op === '*' ? value * next : value / next;
      }

      return value;
    }

    function addSub() {
      let value = mulDiv();

      while (peek() === '+' || peek() === '-') {
        const op = consume();
        const next = mulDiv();
        value = op === '+' ? value + next : value - next;
      }

      return value;
    }

    const result = addSub();

    if (pos !== ts.length) {
      throw new Error('表达式格式错误');
    }

    return result;
  }
}

if (typeof window !== 'undefined') {
  window.Polynomial = Polynomial;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Polynomial;
}
