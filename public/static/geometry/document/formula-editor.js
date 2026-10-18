/* ============================================================
   formula-editor.js —— 公式编辑器公共逻辑
   ------------------------------------------------------------
   提取自下列页面的内联 <script>（各页面前 500+ 行几乎逐字重复）：
     monomial.html、distance2.html、distance3.html、
     linedistance2.html、tetrahedron.html

   内容：
     · 槽位（.slot）与光标：定位、保存/恢复选区、左右槽位跳转
     · 键盘：数字/运算符/参数按键、分数、幂、√、ⁿ√、退格、清空、←→
     · 数学结构插入 / 整体删除
     · 公式导出：DOM → 表达式字符串，并补隐式乘号（ab → a*b）
     · 读取某个编辑框、表达式规范化（走 Polynomial）
     · 参数运算兜底：sqrt()/exactSqrt()，引擎化简不动时给出精确根式

   依赖：
     document/polynomial.js       （化简与 d()/p()/sqrt()/root() 输出语法都走它，
                                    monomial.js 由 polynomial.js 内部使用）
     document/formula-render.js   （只有 render/setResult 转发需要）
     document/keypad.css + math-page.css（外观）

   用法（把一个页面接进来，详见 document/README.md）：
     <script src="./document/monomial.js"></script>
     <script src="./document/polynomial.js"></script>
     <script src="./document/formula-render.js"></script>
     <script src="./document/formula-editor.js"></script>
     <script>
       FormulaEditor.init({
         onSubmit: function () {
           const expr = FormulaEditor.readEditor();      // 整块编辑框
           FormulaEditor.setResult(Polynomial.simplifyExpression(expr), '= ');
         }
       });
     </script>
   ============================================================ */

const FormulaEditor = (function () {
  'use strict';

  // ==================== 状态 ====================
  let currentSlot = null;
  let savedRange = null;

  const options = {
    editorSelector: '.formula-editor',  // 编辑框容器
    keypadSelector: '#keypad',          // 键盘容器
    submitSelector: '#simplify-btn',    // “计算 / 化简”按钮
    onSubmit: null,                     // 按钮回调
    autoFocus: true,                    // 载入后聚焦第一个槽位
    implicitMul: true,                  // 输入时自动补乘号（a、b → a*b）
    bindArrowKeys: true,                // Home/End/←/→ 在槽位间跳转
    radicalWrap: true                   // 根号被开方部分外面套 .radicand-wrap（monomial.html 的最终结构）
                                        // 旧页面（distance2/3、linedistance2、tetrahedron）设为 false，
                                        // 槽位直接作为 .radicand，外观与原来完全一致
  };

  // ==================== 编辑框定位 ====================

  // 找到某个节点所属的编辑框
  function editorOf(node) {
    if (!node) return null;
    const el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
    return el ? el.closest(options.editorSelector) : null;
  }

  function allEditors() {
    return Array.from(document.querySelectorAll(options.editorSelector));
  }

  function saveEditorSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (editorOf(range.commonAncestorContainer)) {
      savedRange = range.cloneRange();
    }
  }

  function getActiveSlot() {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('slot') && document.contains(ae)) {
      currentSlot = ae;
      return currentSlot;
    }
    if (currentSlot && document.contains(currentSlot)) return currentSlot;
    currentSlot = document.querySelector(options.editorSelector + ' .slot');
    return currentSlot;
  }

  function getAllSlots() {
    const slot = getActiveSlot();
    const editor = slot ? slot.closest(options.editorSelector) : null;
    if (!editor) return [];
    return Array.from(editor.querySelectorAll('.slot')).filter(s => s.isContentEditable);
  }

  // ==================== 光标位置 ====================

  function placeCaret(el, atEnd) {
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(!atEnd);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    currentSlot = el;
    savedRange = range.cloneRange();
  }

  function placeCaretAtEnd(el) { placeCaret(el, true); }
  function placeCaretAtStart(el) { placeCaret(el, false); }

  function isCaretAtStart(slot) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!slot.contains(r.startContainer)) return false;
    const probe = document.createRange();
    probe.selectNodeContents(slot);
    try { probe.setEnd(r.startContainer, r.startOffset); }
    catch (err) { return false; }
    return probe.toString().length === 0;
  }

  function isCaretAtEnd(slot) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!slot.contains(r.startContainer)) return false;
    const probe = document.createRange();
    probe.selectNodeContents(slot);
    try { probe.setStart(r.startContainer, r.startOffset); }
    catch (err) { return false; }
    return probe.toString().length === 0;
  }

  function setSlotText(slot, text) {
    if (!slot) return;
    slot.focus();
    const sel = window.getSelection();
    let range = savedRange ? savedRange.cloneRange() : null;
    const isInsideSlot = range &&
      (range.startContainer === slot || slot.contains(range.startContainer)) &&
      (range.endContainer === slot || slot.contains(range.endContainer));
    if (!isInsideSlot) {
      range = document.createRange();
      range.selectNodeContents(slot);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
    currentSlot = slot;
  }

  // ==================== 工具函数 ====================

  function createSlot() {
    const s = document.createElement('span');
    s.className = 'slot';
    s.contentEditable = 'true';
    return s;
  }

  // 焦点跟踪
  function onFocusIn(e) {
    if (e.target.classList && e.target.classList.contains('slot')) {
      currentSlot = e.target;
    }
  }

  // 点击编辑框空白处 → 聚焦到该编辑框第一个槽位
  function onEditorClick(e) {
    const ed = e.currentTarget;
    if (e.target === ed) {
      const firstSlot = ed.querySelector('.slot');
      if (firstSlot) placeCaretAtEnd(firstSlot);
    }
  }

  // ==================== 输入文本 ====================

  // 取当前光标之前、同一槽位内的文本，用于补隐式乘号
  function caretTextBefore(slot) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return slot.textContent || '';
    const r = sel.getRangeAt(0);
    if (!slot.contains(r.startContainer)) return slot.textContent || '';
    const probe = document.createRange();
    probe.selectNodeContents(slot);
    try { probe.setEnd(r.startContainer, r.startOffset); }
    catch (err) { return slot.textContent || ''; }
    return probe.toString();
  }

  function insertText(text) {
    const slot = getActiveSlot();
    if (!slot) return;

    // 数字/字母/括号/参数紧挨着输入时自动补乘号：a、b → a*b，2、( → 2*(
    if (options.implicitMul) {
      const before = caretTextBefore(slot).replace(/\s+$/, '');
      if (before && shouldInsertMul(before, text, false, false)) {
        text = '*' + text;
      }
    }

    setSlotText(slot, text);
  }

  // ==================== 数学结构插入（通用） ====================
  // 结构一律插到当前槽位的【下一个位置】，不吸收当前槽位的内容
  function insertStructure(opts) {
    const slot = getActiveSlot();
    if (!slot) return null;

    const wrapper = document.createElement('span');
    wrapper.className = 'formula-node';
    wrapper.contentEditable = 'false';
    // 必须 trim：否则模板里的换行/缩进会变成文本节点混进导出的表达式
    wrapper.innerHTML = opts.html.trim();

    const focusSlot = wrapper.querySelector(opts.focusSelector);

    const afterSlot = createSlot();
    slot.parentNode.insertBefore(wrapper, slot.nextSibling);
    slot.parentNode.insertBefore(afterSlot, wrapper.nextSibling);

    placeCaretAtEnd(focusSlot);
    return wrapper;
  }

  // 分数：分子 / 分母
  function insertFraction() {
    return insertStructure({
      html: `
        <span class="fraction">
          <span class="numerator-wrap"><span class="slot numerator" contenteditable="true"></span></span>
          <span class="bar"></span>
          <span class="denominator-wrap"><span class="slot denominator" contenteditable="true"></span></span>
        </span>
      `,
      focusSelector: '.numerator'
    });
  }

  // 幂：底数 + 指数
  function insertPower() {
    return insertStructure({
      html: `
        <span class="power">
          <span class="slot base" contenteditable="true"></span>
          <sup class="slot exponent" contenteditable="true"></sup>
        </span>
      `,
      focusSelector: '.exponent'
    });
  }

  // 被开方部分的模板：新结构外面套 .radicand-wrap，旧结构直接把槽位当 .radicand
  function radicandTemplate() {
    return options.radicalWrap
      ? '<span class="radicand-wrap"><span class="slot radicand" contenteditable="true"></span></span>'
      : '<span class="slot radicand" contenteditable="true"></span>';
  }

  // 平方根 √
  // 被开方部分外面套 .radicand-wrap：横线画在 wrap 上，
  // 嵌套结构插进 wrap 内部时横线才能跟着变长（monomial.html 的最终结构）
  function insertSqrt() {
    return insertStructure({
      html: `
        <span class="sqrt">
          <span class="sqrt-symbol">√</span>
          ${radicandTemplate()}
        </span>
      `,
      focusSelector: '.radicand'
    });
  }

  // n 次方根 ⁿ√
  function insertRoot() {
    return insertStructure({
      html: `
        <span class="root">
          <sup class="slot root-index" contenteditable="true"></sup>
          <span class="sqrt-symbol">√</span>
          ${radicandTemplate()}
        </span>
      `,
      focusSelector: '.root-index'
    });
  }

  // ==================== 退格 ====================

  function slotIsEmpty(slot) {
    return slot.textContent.trim() === '' && !slot.querySelector('.formula-node');
  }

  function removeStructure(wrapper) {
    const parent = wrapper.parentNode;
    const next = wrapper.nextElementSibling;
    wrapper.remove();
    if (next && next.classList && next.classList.contains('slot')) {
      placeCaretAtStart(next);
    } else if (parent && parent.classList && parent.classList.contains('slot')) {
      placeCaretAtEnd(parent);
    } else if (parent && parent.querySelector) {
      const s = parent.querySelector('.slot');
      if (s) placeCaretAtEnd(s);
    }
    saveEditorSelection();
  }

  function backspace() {
    const slot = getActiveSlot();
    if (!slot) return;
    slot.focus();

    if (slotIsEmpty(slot)) {
      const wrapper = slot.closest('.formula-node');
      if (wrapper) {
        removeStructure(wrapper);
        return;
      }
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      placeCaretAtEnd(slot);
    }
    document.execCommand('delete');
    saveEditorSelection();
  }

  // 清空当前所在的那个编辑框
  function clearEditor() {
    const slot = getActiveSlot();
    const editor = slot ? slot.closest(options.editorSelector) : null;
    if (!editor) return;
    editor.innerHTML = '<span class="slot" contenteditable="true"></span>';
    currentSlot = editor.querySelector('.slot');
    placeCaretAtEnd(currentSlot);
  }

  // 清空指定编辑框（按 data-editor 名字或元素）
  function clearByName(name) {
    const ed = (typeof name === 'string') ? byName(name) : name;
    if (!ed) return;
    ed.innerHTML = '<span class="slot" contenteditable="true"></span>';
    currentSlot = ed.querySelector('.slot');
    placeCaretAtEnd(currentSlot);
  }

  // ==================== 隐式乘法判定 ====================

  // 判断节点本身或其内部是否包含数学结构（分数、根式、幂）
  function isStructureNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const cls = node.classList;
    if (cls.contains('fraction') || cls.contains('sqrt') ||
        cls.contains('root') || cls.contains('power')) return true;
    if (cls.contains('formula-node')) {
      return Array.from(node.children).some(c => isStructureNode(c));
    }
    return false;
  }

  // 判断左右两段之间是否需要插入乘号
  function shouldInsertMul(leftText, rightText, leftIsStruct, rightIsStruct) {
    if (!leftText || !rightText) return false;
    const leftLast = leftText[leftText.length - 1];
    const rightFirst = rightText[0];
    const isDigit = c => c >= '0' && c <= '9';
    const isLetter = c => /[a-zA-Z]/.test(c);

    const leftOk = leftIsStruct || isDigit(leftLast) || isLetter(leftLast) || leftLast === ')';
    if (!leftOk) return false;

    const rightOk = rightIsStruct || isDigit(rightFirst) || isLetter(rightFirst) ||
                    rightFirst === '(' || rightFirst === '√';
    if (!rightOk) return false;

    // 纯数字 + 纯数字：视为同一数字的不同槽位（如 "3" 与 "2" 应合为 "32"）
    if (!leftIsStruct && !rightIsStruct && isDigit(leftLast) && isDigit(rightFirst)) {
      return false;
    }

    return true;
  }

  // ==================== 导出公式（带隐式乘法） ====================

  function engine() {
    if (typeof Polynomial === 'undefined') {
      throw new Error('formula-editor.js 依赖 Polynomial，请先引入 document/polynomial.js');
    }
    return Polynomial;
  }

  function exportFormula(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    if (node.classList.contains('slot')) {
      return exportChildrenWithMul(node.childNodes).trim();
    }
    if (node.classList.contains('fraction')) {
      const children = Array.from(node.children);
      const barIndex = children.findIndex(child => child.classList.contains('bar'));
      if (barIndex === -1) return '';
      const num = exportChildrenWithMul(children.slice(0, barIndex));
      const den = exportChildrenWithMul(children.slice(barIndex + 1));
      return engine().formatFraction(num, den);
    }
    if (node.classList.contains('power')) {
      const children = Array.from(node.children);
      const expNode = children.find(child => child.classList.contains('exponent'));
      const baseNodes = children.filter(child => child !== expNode);
      const base = exportChildrenWithMul(baseNodes);
      const exp = exportFormula(expNode);
      return engine().formatPower(base, exp);
    }
    if (node.classList.contains('sqrt')) {
      const children = Array.from(node.children);
      const radicandNodes = children.filter(child => !child.classList.contains('sqrt-symbol'));
      const radicand = exportChildrenWithMul(radicandNodes);
      return engine().formatSqrt(radicand);
    }
    if (node.classList.contains('root')) {
      const children = Array.from(node.children);
      const symbolIndex = children.findIndex(child => child.classList.contains('sqrt-symbol'));
      if (symbolIndex === -1) return '';
      const index = exportChildrenWithMul(children.slice(0, symbolIndex));
      const radicand = exportChildrenWithMul(children.slice(symbolIndex + 1));
      return engine().formatRoot(index, radicand);
    }
    return exportChildrenWithMul(node.childNodes);
  }

  // 遍历子节点并自动插入隐式乘号
  function exportChildrenWithMul(nodes) {
    let result = '';
    let prevIsStruct = false;
    for (const child of nodes) {
      const text = exportFormula(child);
      if (!text) continue;
      const curIsStruct = isStructureNode(child);
      if (result && shouldInsertMul(result, text, prevIsStruct, curIsStruct)) {
        result += '*';
      }
      result += text;
      prevIsStruct = curIsStruct;
    }
    return result;
  }

  // ==================== 读取编辑框 ====================

  function byName(name) {
    return document.querySelector(options.editorSelector + '[data-editor="' + name + '"]');
  }

  // 按 data-editor 名字读取内容（distance2/3、linedistance2、tetrahedron 的 readCoord）
  function readByName(name) {
    const ed = byName(name);
    if (!ed) return '';
    return exportFormula(ed).trim();
  }

  // 读取编辑框内容；不传参数时读当前（或第一个）编辑框
  function readEditor(target) {
    let ed = null;
    if (target) {
      ed = (typeof target === 'string') ? byName(target) : target;
    } else {
      const slot = getActiveSlot();
      ed = slot ? slot.closest(options.editorSelector) : null;
      if (!ed) ed = document.querySelector(options.editorSelector);
    }
    if (!ed) return '';
    return exportFormula(ed).trim();
  }

  // 把一段表达式化简成规范字符串；空输入按 0 处理（各距离页面的 normalizeExpr）
  // 化简统一走 Polynomial.simplifyExpression
  function normalize(expr, emptyAsZero) {
    const s = (expr || '').trim();
    if (!s) return emptyAsZero === false ? '' : '0';
    try {
      const r = engine().simplifyExpression(s);
      const rs = (r === undefined || r === null) ? '' : String(r).trim();
      return rs || s;
    } catch (err) {
      console.warn('表达式化简失败，按原样使用：', s, err);
      return s;
    }
  }

  // ==================== 参数运算的兜底 ====================

  // Polynomial 化简失败时不一定抛错，也会返回 '错误: ...' 字符串
  function isErrorText(text) {
    return /^错误[:：]/.test(String(text == null ? '' : text).trim());
  }

  // 化简一段表达式，失败（抛错或返回 '错误: ...'）时原样返回
  function trySimplify(expr) {
    const s = String(expr == null ? '' : expr).trim();
    if (!s) return '0';
    const r = normalize(s, false);
    return (r && !isErrorText(r)) ? r : s;
  }

  // 整块化简不动时，把 (A)/(B) 拆成 d(A,B)：分子分母各自往往还能化简，
  // 而且渲染器会把它画成真正的分式（否则只能显示成 “÷”）
  function asFractionIfAny(expr) {
    const text = String(expr == null ? '' : expr).trim();
    if (!text) return '0';
    let parts = null;
    try {
      parts = engine().splitTopLevel(text, ['/']);
    } catch (err) {
      parts = null;
    }
    if (parts && parts.length === 2 && parts[1].op === '/') {
      return engine().formatFraction(trySimplify(parts[0].value), trySimplify(parts[1].value));
    }
    return trySimplify(text);
  }

  // 精确根式的兜底写法：Polynomial 的 √ 化简失败时（典型情况是分母含参数，
  // 例如点线距离里 k = a），直接写成 sqrt(被开方数) 的精确形式，
  // 仍然是一个可以继续渲染的公式，而不是一句错误提示。
  function exactSqrt(radicand) {
    const raw = String(radicand == null ? '' : radicand).trim() || '0';
    const whole = normalize(raw, false);
    const inner = (whole && !isErrorText(whole)) ? whole : asFractionIfAny(raw);
    return engine().formatSqrt(inner);
  }

  // 安全的开方：先走 Polynomial.sqrt()，失败时退回 exactSqrt()
  function sqrt(radicand) {
    const Polynomial = engine();
    let out = null;
    try {
      out = new Polynomial(String(radicand)).sqrt();
    } catch (err) {
      console.warn('开方化简失败，改用精确根式：', radicand, err);
    }
    if (out === null || isErrorText(out)) {
      if (out) console.warn('开方未化简，改用精确根式：', out);
      return exactSqrt(radicand);
    }
    return out;
  }

  // ==================== 结果渲染转发 ====================

  function render(expr) {
    if (typeof FormulaRender !== 'undefined') return FormulaRender.safe(expr);
    const span = document.createElement('span');
    span.textContent = expr;
    return span;
  }

  function setResult(expr, label, container) {
    const box = container || document.getElementById('result');
    if (!box) return null;
    if (typeof FormulaRender !== 'undefined') {
      return FormulaRender.setResult(box, expr, label);
    }
    box.textContent = (label ? label + ' ' : '') + expr;
    return box;
  }

  // ==================== 键盘导航 ====================

  function onKeyDown(e) {
    if (!options.bindArrowKeys) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const ae = document.activeElement;
    if (!ae || !ae.classList || !ae.classList.contains('slot')) return;

    const key = e.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;

    const slot = ae;
    const slots = getAllSlots();
    const idx = slots.indexOf(slot);
    if (idx === -1) return;

    if (key === 'ArrowLeft' && isCaretAtStart(slot)) {
      if (idx > 0) {
        e.preventDefault();
        placeCaretAtEnd(slots[idx - 1]);
      }
    } else if (key === 'ArrowRight' && isCaretAtEnd(slot)) {
      if (idx < slots.length - 1) {
        e.preventDefault();
        placeCaretAtStart(slots[idx + 1]);
      }
    } else if (key === 'Home') {
      e.preventDefault();
      placeCaretAtStart(slots[0]);
    } else if (key === 'End') {
      e.preventDefault();
      placeCaretAtEnd(slots[slots.length - 1]);
    }
  }

  function moveCaret(direction) {
    const slot = getActiveSlot();
    if (!slot) return;

    slot.focus();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      placeCaretAtEnd(slot);
      return;
    }

    const slots = getAllSlots();
    const idx = slots.indexOf(slot);

    if (direction === 'left' && isCaretAtStart(slot)) {
      if (idx > 0) placeCaretAtEnd(slots[idx - 1]);
      return;
    }
    if (direction === 'right' && isCaretAtEnd(slot)) {
      if (idx !== -1 && idx < slots.length - 1) placeCaretAtStart(slots[idx + 1]);
      return;
    }

    if (typeof sel.modify === 'function') {
      sel.modify('move', direction === 'left' ? 'backward' : 'forward', 'character');
    } else {
      if (direction === 'left') placeCaretAtStart(slot);
      else placeCaretAtEnd(slot);
    }
    saveEditorSelection();
  }

  // ==================== 键盘按键分发 ====================

  function onKeypadMouseDown(e) {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    saveEditorSelection();
    e.preventDefault();   // 保住编辑框里的选区
  }

  function onKeypadClick(e) {
    const btn = e.target.closest('.btn');
    if (!btn) return;

    if (btn.dataset.key !== undefined) {
      insertText(btn.dataset.key);
      return;
    }

    switch (btn.dataset.action) {
      case 'frac': insertFraction(); break;
      case 'pow': insertPower(); break;
      case 'sqrt': insertSqrt(); break;
      case 'root': insertRoot(); break;
      case 'backspace': backspace(); break;
      case 'clear': clearEditor(); break;
      case 'cursor-left': moveCaret('left'); break;
      case 'cursor-right': moveCaret('right'); break;
      default: break;
    }
  }

  // ==================== 初始化 ====================

  function init(opts) {
    Object.assign(options, opts || {});

    document.addEventListener('focusin', onFocusIn);

    allEditors().forEach((ed) => {
      ed.addEventListener('click', onEditorClick);
    });

    const keypad = document.querySelector(options.keypadSelector);
    if (keypad) {
      keypad.addEventListener('mousedown', onKeypadMouseDown);
      keypad.addEventListener('click', onKeypadClick);
    }

    if (options.bindArrowKeys) {
      document.addEventListener('keydown', onKeyDown);
    }

    if (options.submitSelector) {
      const btn = document.querySelector(options.submitSelector);
      if (btn && typeof options.onSubmit === 'function') {
        btn.addEventListener('click', options.onSubmit);
      }
    }

    if (options.autoFocus) {
      const focusFirst = function () {
        currentSlot = document.querySelector(options.editorSelector + ' .slot');
        if (currentSlot) currentSlot.focus();
      };
      if (document.readyState === 'complete') focusFirst();
      else window.addEventListener('load', focusFirst);
    }

    return FormulaEditor;
  }

  return {
    init: init,
    options: options,

    // 编辑框 / 槽位
    editorOf: editorOf,
    allEditors: allEditors,
    getActiveSlot: getActiveSlot,
    getAllSlots: getAllSlots,
    createSlot: createSlot,
    placeCaretAtEnd: placeCaretAtEnd,
    placeCaretAtStart: placeCaretAtStart,
    saveEditorSelection: saveEditorSelection,

    // 输入
    insertText: insertText,
    insertStructure: insertStructure,
    insertFraction: insertFraction,
    insertPower: insertPower,
    insertSqrt: insertSqrt,
    insertRoot: insertRoot,

    // 删除
    backspace: backspace,
    clearEditor: clearEditor,
    clearByName: clearByName,

    // 导出 / 读取
    exportFormula: exportFormula,
    exportChildrenWithMul: exportChildrenWithMul,
    isStructureNode: isStructureNode,
    shouldInsertMul: shouldInsertMul,
    readEditor: readEditor,
    readByName: readByName,
    editorByName: byName,
    normalize: normalize,

    // 参数运算兜底（开方化简失败时给出精确根式）
    exactSqrt: exactSqrt,
    sqrt: sqrt,

    // 渲染转发（需要 formula-render.js）
    render: render,
    setResult: setResult,

    // 光标移动
    moveCaret: moveCaret
  };
})();
