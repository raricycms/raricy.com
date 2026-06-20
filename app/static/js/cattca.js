export class CattcaInterpreter {
  constructor(outputCb, logCb, inputCb, choiceCb, delimiters = { open: '</', close: '/>' }) {
    this.outputCb = outputCb || (() => {});
    this.logCb = logCb || (() => {});
    this.inputCb = inputCb || (async () => "");
    this.choiceCb = choiceCb || (async (opts) => opts[0] );
    this.delimiters = delimiters;
    this.reset();
  }

  reset() {
    this.vars = {};
    this.labels = {};
    this.pointer = 0;
    this.running = true;
    this.lines = [];
    this.source = "";
    this._exprCache = new Map();
  }

  load(source) {
    this.reset();
    this.source = source == null ? "" : String(source);
    this.parse();
  }

  // =========================================================================
  //  Static helpers
  // =========================================================================

  static escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 在字符串 s 中查找第一个处于引号外层的字符 char 的位置。
   * 返回索引，找不到返回 -1。
   */
  static findTopLevelChar(s, char) {
    let inS = false, inD = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') { i++; continue; }           // 跳过转义字符
      if (ch === "'" && !inD) { inS = !inS; continue; }
      if (ch === '"' && !inS) { inD = !inD; continue; }
      if (ch === char && !inS && !inD) return i;
    }
    return -1;
  }

  /**
   * 按顶层分号拆分，忽略引号内分号。
   */
  static splitTopLevelSemicolons(s) {
    const out = [];
    let curr = "";
    let inS = false, inD = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') { curr += ch; if (i + 1 < s.length) curr += s[++i]; continue; }
      if (ch === "'" && !inD) { inS = !inS; curr += ch; continue; }
      if (ch === '"' && !inS) { inD = !inD; curr += ch; continue; }
      if (ch === ';' && !inS && !inD) { out.push(curr.trim()); curr = ""; continue; }
      curr += ch;
    }
    if (curr.trim() !== "") out.push(curr.trim());
    return out.filter(x => x.length > 0);
  }

  /**
   * 按顶层指定字符拆分，忽略引号内该字符。
   */
  static splitTopLevelByChar(s, sepChar) {
    const out = [];
    let curr = "";
    let inS = false, inD = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') { curr += ch; if (i + 1 < s.length) curr += s[++i]; continue; }
      if (ch === "'" && !inD) { inS = !inS; curr += ch; continue; }
      if (ch === '"' && !inS) { inD = !inD; curr += ch; continue; }
      if (ch === sepChar && !inS && !inD) { out.push(curr.trim()); curr = ""; continue; }
      curr += ch;
    }
    if (curr.trim() !== "") out.push(curr.trim());
    return out.filter(x => x.length > 0);
  }

  /**
   * 在 s 中查找第一个顶层 "->"，返回 [left, right] 或 null。
   */
  static splitByArrowTopLevel(s) {
    let inS = false, inD = false;
    for (let i = 0; i < s.length - 1; i++) {
      const ch = s[i];
      if (ch === '\\') { i++; continue; }
      if (ch === "'" && !inD) { inS = !inS; continue; }
      if (ch === '"' && !inS) { inD = !inD; continue; }
      if (ch === '-' && s[i + 1] === '>' && !inS && !inD) {
        return [ s.slice(0, i).trim(), s.slice(i + 2).trim() ];
      }
    }
    return null;
  }

  /**
   * 规范化命令字符串：去除尾部多余分号与空白。
   */
  static normCmd(s) {
    return s.replace(/;+\s*$/, '').trim();
  }

  /**
   * 去除源码中的 /* */ 注释。
   */
  static removeComments(source) {
    let result = '';
    let i = 0;
    let inString = false;
    let stringChar = '';

    while (i < source.length) {
      const ch = source[i];
      const next = i + 1 < source.length ? source[i + 1] : '';

      // 字符串字面量
      if (!inString && (ch === '"' || ch === "'")) {
        inString = true;
        stringChar = ch;
        result += ch;
        i++;
        continue;
      }

      if (inString && ch === stringChar) {
        if (i > 0 && source[i - 1] === '\\') {
          result += ch;
          i++;
          continue;
        }
        inString = false;
        stringChar = '';
        result += ch;
        i++;
        continue;
      }

      if (inString) { result += ch; i++; continue; }

      // 注释（字符串外）
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < source.length - 1) {
          if (source[i] === '*' && source[i + 1] === '/') { i += 2; break; }
          i++;
        }
        continue;
      }

      result += ch;
      i++;
    }

    return result;
  }

  // =========================================================================
  //  Parsing
  // =========================================================================

  parse() {
    const sourceWithoutComments = CattcaInterpreter.removeComments(this.source);
    const { open, close } = this.delimiters;
    const regex = new RegExp(
      CattcaInterpreter.escapeRegExp(open) + "([\\s\\S]*?)" + CattcaInterpreter.escapeRegExp(close),
      "g"
    );

    const pushText = (raw) => {
      const cleaned = raw.replace(/^[\r\n]+/, '');
      if (cleaned !== '') this.lines.push({ type: "text", content: cleaned });
    };

    let lastIndex = 0;
    let m;
    while ((m = regex.exec(sourceWithoutComments)) !== null) {
      if (m.index > lastIndex) {
        pushText(sourceWithoutComments.slice(lastIndex, m.index));
      }
      const inside = m[1] || "";
      const cmds = CattcaInterpreter.splitTopLevelSemicolons(inside);
      for (let cc of cmds) {
        cc = CattcaInterpreter.normCmd(cc);
        if (cc.length) this.lines.push({ type: "command", content: cc });
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < sourceWithoutComments.length) {
      pushText(sourceWithoutComments.slice(lastIndex));
    }

    // 建立标签索引
    for (let i = 0; i < this.lines.length; i++) {
      const L = this.lines[i];
      if (L.type === 'command' && L.content.startsWith('label ')) {
        const name = CattcaInterpreter.normCmd(L.content.slice(6).trim()).replace(/^['"]|['"]$/g, '');
        if (name.length) this.labels[name] = i;
      }
    }
  }

  // =========================================================================
  //  Expression evaluation
  // =========================================================================

  evalExpr(expr) {
    if (expr == null) return null;
    expr = String(expr).trim();
    if (expr === '') return '';

    // 字符串字面量
    if ((expr[0] === '"' && expr[expr.length - 1] === '"') ||
        (expr[0] === "'" && expr[expr.length - 1] === "'")) {
      return expr.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    }

    // 数字
    if (/^-?\d+(?:\.\d+)?$/.test(expr)) return Number(expr);

    // 布尔 / null
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;

    // 纯变量名
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) && this.vars.hasOwnProperty(expr)) {
      return this.vars[expr];
    }

    // 编译表达式（带缓存）
    const argNames = Object.keys(this.vars).sort();
    const cacheKey = expr + '\0' + argNames.join(',');
    let fn = this._exprCache.get(cacheKey);
    if (!fn) {
      try {
        fn = new Function(...argNames, '"use strict"; return (' + expr + ');');
      } catch (_) {
        fn = null; // 编译失败，走 fallback
      }
      this._exprCache.set(cacheKey, fn);
    }

    if (fn) {
      try {
        const argVals = argNames.map(k => this.vars[k]);
        return fn(...argVals);
      } catch (_) {
        // 运行时求值失败，走 fallback
      }
    }

    return expr; // 最终回退：返回原始文本
  }

  // =========================================================================
  //  Execution
  // =========================================================================

  async execute(line) {
    if (this.pointer < 0 || this.pointer >= this.lines.length) { this.running = false; return; }

    // 文本行：直接输出
    if (line.type === 'text') {
      const txt = line.content;
      if (txt != null && txt !== '') this.outputCb(txt);
      return;
    }

    const cmd = CattcaInterpreter.normCmd(line.content);
    if (!cmd) return;

    // 取第一个词作为命令关键字
    const spaceIdx = cmd.indexOf(' ');
    const keyword = spaceIdx > 0 ? cmd.slice(0, spaceIdx) : cmd;
    const after = spaceIdx > 0 ? cmd.slice(spaceIdx + 1).trim() : '';

    switch (keyword) {

      // ---- let ----
      case 'let': {
        const eqIdx = CattcaInterpreter.findTopLevelChar(after, '=');
        if (eqIdx === -1) {
          this.vars[after.trim()] = null;
        } else {
          const name = after.slice(0, eqIdx).trim();
          const expr = after.slice(eqIdx + 1).trim();
          this.vars[name] = this.evalExpr(expr);
          // 变量集合变了，清缓存
          this._exprCache.clear();
        }
        return;
      }

      // ---- set ----
      case 'set': {
        const eqIdx = CattcaInterpreter.findTopLevelChar(after, '=');
        if (eqIdx === -1) throw new Error('set 缺少 =');
        const name = after.slice(0, eqIdx).trim();
        const expr = after.slice(eqIdx + 1).trim();
        if (!this.vars.hasOwnProperty(name)) throw new Error('变量未声明：' + name);
        this.vars[name] = this.evalExpr(expr);
        return;
      }

      // ---- label (运行时无操作) ----
      case 'label':
        return;

      // ---- goto ----
      case 'goto': {
        let label = after.replace(/;+\s*$/, '').replace(/^['"]|['"]$/g, '');
        if (this.labels.hasOwnProperty(label)) {
          this.pointer = this.labels[label];
        } else {
          this.logCb('goto 未找到标签：' + label);
        }
        return;
      }

      // ---- exit ----
      case 'exit':
        this.running = false;
        return;

      // ---- if ----
      case 'if': {
        const parts = CattcaInterpreter.splitByArrowTopLevel(after);
        if (!parts) throw new Error('if 语句缺少 ->');
        const condStr = parts[0].trim();
        const actionStr = CattcaInterpreter.normCmd(parts[1] || '');
        if (this.evalExpr(condStr) && actionStr) {
          await this.execute({ type: 'command', content: actionStr });
        }
        return;
      }

      // ---- log ----
      case 'log':
        this.logCb(String(this.evalExpr(after)));
        return;

      // ---- apply ----
      case 'apply':
        this.outputCb(String(this.evalExpr(after)));
        return;

      // ---- input text ----
      case 'input': {
        const rest = after;
        if (rest.startsWith('text ')) {
          const name = rest.slice(5).trim();
          if (!this.vars.hasOwnProperty(name)) throw new Error('变量未声明：' + name);
          this.vars[name] = String(await this.inputCb(name));
          return;
        }
        if (rest.startsWith('case')) {
          let inner = rest.slice(4).trim();
          let varName = null;
          // 检测第一个顶层冒号前是否为合法变量名
          const colonIdx = CattcaInterpreter.findTopLevelChar(inner, ':');
          if (colonIdx >= 0) {
            const possibleHeader = inner.slice(0, colonIdx).trim();
            const afterColon = inner.slice(colonIdx + 1);
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(possibleHeader)) {
              varName = possibleHeader;
              inner = afterColon;
            }
          } else {
            throw new Error('input case 缺少冒号与选项');
          }

          const optionChunks = CattcaInterpreter.splitTopLevelByChar(inner, ':');
          if (optionChunks.length === 0) throw new Error('input case 至少需要一个选项');

          const opts = [];
          for (let chunk of optionChunks) {
            if (!chunk) continue;
            const pair = CattcaInterpreter.splitByArrowTopLevel(chunk);
            if (!pair) throw new Error('input case 选项缺少 ->');
            const labelExpr = pair[0].trim();
            const actionRaw = pair[1] ? CattcaInterpreter.normCmd(pair[1]) : '';
            opts.push({ labelExpr, labelValue: this.evalExpr(labelExpr), action: actionRaw });
          }

          const displayOptions = opts.map(o => String(o.labelValue));
          const choose = await this.choiceCb(displayOptions);
          const chosen = opts.find(o => String(o.labelValue) === String(choose));

          if (!chosen) {
            if (varName) this.vars[varName] = '';
            return;
          }
          if (varName) this.vars[varName] = chosen.labelValue;
          if (chosen.action) {
            await this.execute({ type: 'command', content: chosen.action });
          }
          return;
        }
        // fallthrough to unknown
      }

      // ---- random ----
      case 'random': {
        const eqIdx = CattcaInterpreter.findTopLevelChar(after, '=');
        if (eqIdx === -1) throw new Error('random 缺少 =');

        const varName = after.slice(0, eqIdx).trim();
        const rangeStr = after.slice(eqIdx + 1).trim();
        if (!this.vars.hasOwnProperty(varName)) throw new Error('变量未声明：' + varName);

        const spaceIdx = CattcaInterpreter.findTopLevelChar(rangeStr, ' ');
        if (spaceIdx === -1) throw new Error('random 需要两个参数：最小值和最大值');

        const min = Number(this.evalExpr(rangeStr.slice(0, spaceIdx).trim()));
        const max = Number(this.evalExpr(rangeStr.slice(spaceIdx + 1).trim()));
        if (isNaN(min) || isNaN(max)) throw new Error('random 参数必须是数字');
        if (min > max) throw new Error('random 最小值不能大于最大值');

        this.vars[varName] = Math.floor(Math.random() * (max - min + 1)) + min;
        return;
      }

      // ---- unknown ----
      default:
        this.logCb('未知命令：' + cmd);
    }
  }

  // =========================================================================
  //  Run loop
  // =========================================================================

  async run() {
    this.running = true;
    while (this.running && this.pointer < this.lines.length) {
      const cur = this.lines[this.pointer];
      try {
        await this.execute(cur);
      } catch (err) {
        this.logCb('执行错误：' + (err && err.message ? err.message : String(err)));
        this.running = false;
        break;
      }
      this.pointer++;
    }
  }
}
