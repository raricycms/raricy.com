export class CattcaInterpreter {
  /**
   * @param outputCb  正文输出
   * @param logCb     日志（含 `执行错误：…` 的可读日志行，给阅读器的日志面板用）
   * @param inputCb   文本输入
   * @param choiceCb  选项
   * @param delimiters 指令块分隔符
   * @param hooks     `{ onError(message) }`：**独立的错误通道**。宿主不该再从 logCb 的
   *                  文案前缀里猜「这是不是一条错误」——那样一旦改文案，错误态就静默丢失。
   */
  constructor(outputCb, logCb, inputCb, choiceCb, delimiters = { open: '</', close: '/>' }, hooks = {}) {
    this.outputCb = outputCb || (() => {});
    this.logCb = logCb || (() => {});
    this.inputCb = inputCb || (async () => "");
    this.choiceCb = choiceCb || (async (opts) => opts[0] );
    this.delimiters = delimiters;
    this.onError = typeof hooks.onError === 'function' ? hooks.onError : null;
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

  /** Cattca 指令关键字：只有 `</` 后面跟这些词才当成指令块开始（R3-593）。 */
  static COMMAND_KEYWORDS = new Set(['let', 'set', 'label', 'goto', 'exit', 'if', 'log', 'apply', 'input', 'random']);

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
   * 去除源码中的 注释。
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

    const pushText = (raw) => {
      const cleaned = raw.replace(/^[\r\n]+/, '');
      if (cleaned !== '') this.lines.push({ type: "text", content: cleaned });
    };

    let lastIndex = 0;
    let searchFrom = 0;
    while (searchFrom <= sourceWithoutComments.length) {
      const openIdx = sourceWithoutComments.indexOf(open, searchFrom);
      if (openIdx === -1) break;
      const afterOpenStart = openIdx + open.length;
      // 开标记后面必须紧跟（可留空白）一个已知指令关键字。正文里的 HTML 结束标签
      // `</div>` 与真正的 `</let …/>` 前缀相同，旧实现用无差别正则会把 `</div>`
      // 当成块开始、吞掉它到下一个 `/>` 之间的正文（R3-593）。
      const head = sourceWithoutComments.slice(afterOpenStart).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
      const keyword = head ? head[1].toLowerCase() : '';
      if (!head || !CattcaInterpreter.COMMAND_KEYWORDS.has(keyword)) {
        searchFrom = afterOpenStart;
        continue;
      }
      const closeIdx = sourceWithoutComments.indexOf(close, afterOpenStart);
      if (closeIdx === -1) break;
      if (openIdx > lastIndex) pushText(sourceWithoutComments.slice(lastIndex, openIdx));
      const inside = sourceWithoutComments.slice(afterOpenStart, closeIdx);
      const cmds = CattcaInterpreter.splitTopLevelSemicolons(inside);
      for (let cc of cmds) {
        cc = CattcaInterpreter.normCmd(cc);
        if (cc.length) this.lines.push({ type: "command", content: cc });
      }
      lastIndex = closeIdx + close.length;
      searchFrom = lastIndex;
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
        // 变量名必须是合法标识符：否则 new Function 编译失败会静默回退原文，
        // 后续 if 条件拿到非空字符串就恒真（R3-591）。
        const rawName = (eqIdx === -1 ? after : after.slice(0, eqIdx)).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName)) {
          throw new Error('变量名只能用字母、数字、下划线，且不能以数字开头：' + rawName);
        }
        if (eqIdx === -1) {
          this.vars[rawName] = null;
        } else {
          const expr = after.slice(eqIdx + 1).trim();
          this.vars[rawName] = this.evalExpr(expr);
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
        const cond = this.evalExpr(condStr);
        // evalExpr 的最终回退是「原样返回表达式字符串」；字符串恒真，会让写错的条件
        // 永远走 then 分支（R3-591）。条件位只接受能求出数值/布尔的结果。
        if (typeof cond === 'string') throw new Error('if 条件无法求值：' + condStr);
        if (cond && actionStr) {
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

        // 在顶层空格处切成两段 min/max。表达式本身可以含空格（如 `1 + 2`），
        // 旧实现只按第一个顶层空格切，遇空格即失败（R3-592）。这里逐个候选切点
        // 试求值，取第一组两边都能求出有限数值的切法。
        const cuts = [];
        let inS = false, inD = false;
        for (let i = 0; i < rangeStr.length; i++) {
          const ch = rangeStr[i];
          if (ch === '\\') { i++; continue; }
          if (ch === "'" && !inD) { inS = !inS; continue; }
          if (ch === '"' && !inS) { inD = !inD; continue; }
          if (ch === ' ' && !inS && !inD) cuts.push(i);
        }
        let min = NaN, max = NaN;
        for (const cut of cuts) {
          const left = Number(this.evalExpr(rangeStr.slice(0, cut).trim()));
          const right = Number(this.evalExpr(rangeStr.slice(cut + 1).trim()));
          if (Number.isFinite(left) && Number.isFinite(right)) { min = left; max = right; break; }
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          throw new Error('random 需要两个可求值的参数：最小值和最大值');
        }
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

  /**
   * 跑到结束。返回**结构化结果**，调用方不必再猜「有没有出错」：
   *   · `{ ok: true }`            跑到最后一行 / 命中 `exit`
   *   · `{ ok: false, error }`    某一行执行抛错
   *
   * 出错时同时走两条通道：`hooks.onError(message)`（结构化，宿主用它置错误态）与
   * `logCb('执行错误：…')`（人可读日志，保留给日志面板）。`running` 被宿主置 false
   * 取消时同样返回 ok:true —— 取消不是错误，宿主用 run token 丢弃这个结果。
   */
  async run() {
    this.running = true;
    while (this.running && this.pointer < this.lines.length) {
      const cur = this.lines[this.pointer];
      try {
        await this.execute(cur);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        this.logCb('执行错误：' + message);
        this.running = false;
        if (this.onError) this.onError(message);
        return { ok: false, error: message };
      }
      this.pointer++;
    }
    return { ok: true };
  }
}
