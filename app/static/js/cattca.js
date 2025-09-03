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
  }

  load(source) {
    this.reset();
    this.source = source == null ? "" : String(source);
    this.parse();
  }

  // ---------- parsing helpers ----------
  static escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // split by top-level semicolons (ignore semicolons inside quotes)
  static splitTopLevelSemicolons(s) {
    const out = [];
    let curr = "";
    let inS = false, inD = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\\\') { curr += ch; if (i + 1 < s.length) curr += s[++i]; continue; }
      if (ch === "'" && !inD) { inS = !inS; curr += ch; continue; }
      if (ch === '"' && !inS) { inD = !inD; curr += ch; continue; }
      if (ch === ';' && !inS && !inD) { out.push(curr.trim()); curr = ""; continue; }
      curr += ch;
    }
    if (curr.trim() !== "") out.push(curr.trim());
    return out.filter(x => x.length > 0);
  }

  // split by a top-level separator char (e.g. ':'), ignore separators inside quotes
  static splitTopLevelByChar(s, sepChar) {
    const out = [];
    let curr = "";
    let inS = false, inD = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\\\') { curr += ch; if (i + 1 < s.length) curr += s[++i]; continue; }
      if (ch === "'" && !inD) { inS = !inS; curr += ch; continue; }
      if (ch === '"' && !inS) { inD = !inD; curr += ch; continue; }
      if (ch === sepChar && !inS && !inD) { out.push(curr.trim()); curr = ""; continue; }
      curr += ch;
    }
    if (curr.trim() !== "") out.push(curr.trim());
    return out.filter(x => x.length > 0);
  }

  // find '->' outside quotes and split once
  static splitByArrowTopLevel(s) {
    let inS = false, inD = false;
    for (let i = 0; i < s.length - 1; i++) {
      const ch = s[i];
      const nxt = s[i+1];
      if (ch === '\\\\') { i++; continue; }
      if (ch === "'" && !inD) { inS = !inS; continue; }
      if (ch === '"' && !inS) { inD = !inD; continue; }
      if (ch === '-' && nxt === '>' && !inS && !inD) {
        return [ s.slice(0,i).trim(), s.slice(i+2).trim() ];
      }
    }
    return null;
  }

  // normalize a command string: trim and strip trailing semicolons/spaces
  static normCmd(s) {
    return s.replace(/;+\s*$/,'').trim();
  }

  // ---------- parse ----------
  parse() {
    const { open, close } = this.delimiters;
    const regex = new RegExp(CattcaInterpreter.escapeRegExp(open) + "([\\s\\S]*?)" + CattcaInterpreter.escapeRegExp(close), "g");
    let lastIndex = 0;
    let m;
    while ((m = regex.exec(this.source)) !== null) {
      if (m.index > lastIndex) {
        const text = this.source.slice(lastIndex, m.index);
        // keep text as-is (but remove leading newlines)
        this.lines.push({ type: "text", content: text.replace(/^[\\r\\n]+/, '') });
      }
      const inside = m[1] || "";
      // split into commands by top-level semicolons
      const cmds = CattcaInterpreter.splitTopLevelSemicolons(inside);
      for (let cc of cmds) {
        cc = CattcaInterpreter.normCmd(cc);
        if (cc.length) this.lines.push({ type: "command", content: cc });
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < this.source.length) {
      const tail = this.source.slice(lastIndex);
      this.lines.push({ type: "text", content: tail.replace(/^[\\r\\n]+/, '') });
    }

    // build label index -> point to the LABEL instruction index (so a goto sets pointer = labels[name])
    for (let i = 0; i < this.lines.length; i++) {
      const L = this.lines[i];
      if (L.type === 'command' && L.content.startsWith('label ')) {
        const name = CattcaInterpreter.normCmd(L.content.slice(6).trim()).replace(/^['"]|['"]$/g,'');
        if (name.length) this.labels[name] = i; // store label command index
      }
    }
  }

  // ---------- expression evaluation ----------
  evalExpr(expr) {
    if (expr == null) return null;
    expr = String(expr).trim();
    if (expr === '') return '';
    // string literal
    if ((expr[0] === '"' && expr[expr.length-1] === '"') || (expr[0] === "'" && expr[expr.length-1] === "'")) {
      // remove surrounding quotes, handle simple escapes
      return expr.slice(1,-1).replace(/\\\\n/g,'\\n').replace(/\\\\r/g,'\\r').replace(/\\\\t/g,'\\t');
    }
    // numeric
    if (/^-?\\d+(?:\\.\\d+)?$/.test(expr)) return Number(expr);
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    // plain variable name?
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) && this.vars.hasOwnProperty(expr)) return this.vars[expr];

    // try to evaluate expression with current vars (safe-ish: local sandbox)
    try {
      const argNames = Object.keys(this.vars);
      const argVals = Object.values(this.vars);
      const f = new Function(...argNames, "return (" + expr + ");");
      return f(...argVals);
    } catch (e) {
      // last fallback: return original text
      return expr;
    }
  }

  // ---------- execution ----------
  async execute(line) {
    if (this.pointer < 0 || this.pointer >= this.lines.length) { this.running = false; return; }

    if (line.type === 'text') {
      const txt = line.content;
      if (txt != null && txt !== '') this.outputCb(txt);
      return;
    }

    // normalize command (remove trailing semicolons)
    let cmd = CattcaInterpreter.normCmd(line.content);

    // ---- let ----
    if (cmd.startsWith('let ')) {
      const after = cmd.slice(4).trim();
      const eqIdx = (() => {
        // find top-level '=' ignoring quotes
        let inS=false,inD=false;
        for (let i=0;i<after.length;i++){
          const ch=after[i];
          if (ch==='\\\\') { i++; continue; }
          if (ch==="'" && !inD) { inS=!inS; continue; }
          if (ch=='\"' && !inS) { inD=!inD; continue; }
          if (ch==='=' && !inS && !inD) return i;
        }
        return -1;
      })();
      if (eqIdx === -1) {
        const name = after.trim();
        this.vars[name] = null;
      } else {
        const name = after.slice(0, eqIdx).trim();
        const expr = after.slice(eqIdx+1).trim();
        this.vars[name] = this.evalExpr(expr);
      }
      return;
    }

    // ---- set ----
    if (cmd.startsWith('set ')) {
      const after = cmd.slice(4).trim();
      const eq = after.indexOf('=');
      if (eq === -1) throw new Error('set 缺少 =');
      const name = after.slice(0, eq).trim();
      const expr = after.slice(eq+1).trim();
      if (!this.vars.hasOwnProperty(name)) throw new Error('变量未声明：' + name);
      this.vars[name] = this.evalExpr(expr);
      return;
    }

    // ---- label (noop at runtime) ----
    if (cmd.startsWith('label ')) return;

    // ---- goto ----
    if (cmd.startsWith('goto ')) {
      const parts = cmd.split(/\s+/);
      let label = parts.slice(1).join(' ').trim();
      label = label.replace(/;+\s*$/,'').replace(/^['"]|['"]$/g,'');
      if (this.labels.hasOwnProperty(label)) {
        // set pointer to label instruction index; run() will increment pointer after execute,
        // so next executed instruction becomes labelIndex + 1 — that's desired.
        this.pointer = this.labels[label];
      } else {
        // not found: throw or ignore? 我们选择记录日志并继续（避免死循环）
        this.logCb('goto 未找到标签：' + label);
      }
      return;
    }

    // ---- exit ----
    if (cmd === 'exit') { this.running = false; return; }

    // ---- if cond -> action ----
    if (cmd.startsWith('if ')) {
      const parts = CattcaInterpreter.splitByArrowTopLevel(cmd.slice(3));
      if (!parts) throw new Error('if 语句缺少 ->');
      const condStr = parts[0].trim();
      const actionStr = CattcaInterpreter.normCmd(parts[1] || '');
      const cond = !!this.evalExpr(condStr);
      if (cond && actionStr) {
        // execute action as a single command (note: this may change this.pointer if action is goto)
        await this.execute({ type: 'command', content: actionStr });
      }
      return;
    }

    // ---- log ----
    if (cmd.startsWith('log ')) {
      const expr = cmd.slice(4).trim();
      const v = this.evalExpr(expr);
      this.logCb(v);
      return;
    }

    // ---- apply ----
    if (cmd.startsWith('apply ')) {
      const expr = cmd.slice(6).trim();
      const v = this.evalExpr(expr);
      this.outputCb(v);
      return;
    }

    // ---- input text varname ----
    if (cmd.startsWith('input text')) {
      const name = cmd.slice('input text'.length).trim();
      if (!this.vars.hasOwnProperty(name)) throw new Error('变量未声明：' + name);
      const val = await this.inputCb(name);
      this.vars[name] = String(val);
      return;
    }

    // ---- input case [varname:] opt:opt:... ----
    if (cmd.startsWith('input case')) {
      let inner = cmd.slice('input case'.length).trim();
      // if starts with a colon, skip it; otherwise if header present, detect header before first top-level colon
      let varName = null, rest = inner;
      // find first top-level colon (outside quotes)
      let firstColonIdx = (function(){
        let inS=false,inD=false;
        for (let i=0;i<inner.length;i++){
          const ch=inner[i];
          if (ch==='\\\\'){ i++; continue; }
          if (ch==="'" && !inD){ inS=!inS; continue; }
          if (ch=='\"' && !inS){ inD=!inD; continue; }
          if (ch === ':' ) return i;
        }
        return -1;
      })();
      if (firstColonIdx >= 0) {
        const possibleHeader = inner.slice(0, firstColonIdx).trim();
        const after = inner.slice(firstColonIdx+1);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(possibleHeader)) {
          varName = possibleHeader;
          rest = after;
        } else {
          // header is not a var name — include the whole inner as rest
          rest = inner;
        }
      } else {
        // no colon at all -> invalid
        throw new Error('input case 缺少冒号与选项');
      }
      // now rest is the options area, split by top-level ':' into option chunks
      const optionChunks = CattcaInterpreter.splitTopLevelByChar(rest, ':');
      if (optionChunks.length === 0) throw new Error('input case 至少需要一个选项');
      const opts = [];
      for (let chunk of optionChunks) {
        if (!chunk) continue;
        const pair = CattcaInterpreter.splitByArrowTopLevel(chunk);
        if (!pair) throw new Error('input case 选项缺少 ->');
        const labelExpr = pair[0].trim();
        const actionRaw = pair[1] ? CattcaInterpreter.normCmd(pair[1]) : '';
        const labelValue = this.evalExpr(labelExpr);
        opts.push({ labelExpr, labelValue, action: actionRaw });
      }
      // present options to user: show human strings
      const displayOptions = opts.map(o => String(o.labelValue));
      const choose = await this.choiceCb(displayOptions);
      // find matching option (string compare)
      const chosen = opts.find(o => String(o.labelValue) === String(choose));
      if (!chosen) {
        // user canceled or invalid -> set var (if any) to empty and continue
        if (varName) this.vars[varName] = '';
        return;
      }
      if (varName) this.vars[varName] = chosen.labelValue;
      if (chosen.action) {
        await this.execute({ type: 'command', content: chosen.action });
      }
      return;
    }

    // unknown command fallback
    this.logCb('未知命令：' + cmd);
  }

  // ---------- run loop ----------
  async run() {
    this.running = true;
    while (this.running && this.pointer < this.lines.length) {
      const cur = this.lines[this.pointer];
      try {
        await this.execute(cur);
      } catch (err) {
        this.logCb('执行错误：' + (err && err.message ? err.message : String(err)));
        // stop on runtime error
        this.running = false;
        break;
      }
      // advance pointer (note: some commands may have altered this.pointer)
      this.pointer++;
    }
  }
}

