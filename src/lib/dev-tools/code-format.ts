// ─────────────────────────────────────────────────────────────────────────────
// code-format.ts —— 「代码格式化」的纯逻辑（JSON / JavaScript / TypeScript / CSS / HTML / XML）
//
// 【这是什么、页面文案必须照这个说】
//   一个**基于词法的「基础缩进格式化」**：
//     · JSON：`JSON.parse` + `JSON.stringify`（真解析，语法错误会报出来）；
//     · JS / TS：花括号缩进与分号换行，**正确跳过**字符串、模板串、正则字面量、注释
//       —— 它们的内容一个字符都不改；
//     · CSS：花括号缩进、声明换行，保留字符串与注释原文；
//     · HTML / XML：标签缩进，`<pre>` / `<textarea>` / `<script>` / `<style>` 的
//       **内部原文整段保留**（不做重新缩进）。
//   它**不是** Prettier：不换行超长表达式、不重排对象键、不处理 ASI 边界、不对齐
//   等号。别在页面上写「专业级格式化」。
//
// 【为什么不用现成库】仓库红线不允许新增 npm 依赖；而且这些工具要在浏览器里跑、
// 不上传任何内容。词法级方案对「粘贴一段代码、看缩进」这个用途足够，代价是上面
// 那些已知限制 —— 限制写在页面上，不假装没有。
//
// 【不变式】
//   · 本文件不取「现在」、不碰 DOM、不读环境，node 单测可直接 import。
//   · 格式化失败只发生在 JSON 解析；其余语言一律尽力输出（不抛「无法格式化」）。
//   · 缩进一律用空格（2 或 4），不混制表符。
// ─────────────────────────────────────────────────────────────────────────────

export type CodeLanguage = 'json' | 'javascript' | 'typescript' | 'css' | 'html' | 'xml';

export const CODE_LANGUAGES: ReadonlyArray<{ value: CodeLanguage; label: string; hint: string }> = [
  { value: 'json', label: 'JSON', hint: '用 JSON.parse 校验后重新序列化；语法错误会给出位置。' },
  { value: 'javascript', label: 'JavaScript', hint: '花括号缩进、分号换行；跳过字符串 / 模板串 / 正则 / 注释。' },
  { value: 'typescript', label: 'TypeScript', hint: '同 JavaScript；类型标注会被当作普通词法单元保留。' },
  { value: 'css', label: 'CSS', hint: '花括号缩进、声明换行；选择器与值按源码空白保留。' },
  { value: 'html', label: 'HTML', hint: '标签缩进；pre / textarea / script / style 内部原文整段保留。' },
  { value: 'xml', label: 'XML', hint: '标签缩进；注释、CDATA 与处理指令原样保留。' },
];

export function formatCode(source: string, language: CodeLanguage, indentSize: 2 | 4): string {
  switch (language) {
    case 'json':
      return formatJson(source, indentSize);
    case 'javascript':
    case 'typescript':
      return formatJavaScript(source, indentSize);
    case 'css':
      return formatCss(source, indentSize);
    case 'html':
      return formatMarkup(source, indentSize, 'html');
    case 'xml':
      return formatMarkup(source, indentSize, 'xml');
    default: {
      const unreachable: never = language;
      throw new Error(`未知的格式化语言：${String(unreachable)}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 公共小工具
// ═════════════════════════════════════════════════════════════════════════════

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON
// ═════════════════════════════════════════════════════════════════════════════

/** 解析后再序列化；语法错误原样抛出（`at position N` 是最有用的定位信息）。 */
export function formatJson(source: string, indentSize: number): string {
  const trimmed = source.trim();
  if (trimmed === '') return '';
  const parsed: unknown = JSON.parse(trimmed);
  return JSON.stringify(parsed, null, indentSize);
}

// ═════════════════════════════════════════════════════════════════════════════
// JavaScript / TypeScript
// ═════════════════════════════════════════════════════════════════════════════

type JsTokenType =
  | 'word'
  | 'number'
  | 'string'
  | 'template'
  | 'regex'
  | 'line-comment'
  | 'block-comment'
  | 'punct'
  | 'operator';

interface JsToken {
  type: JsTokenType;
  text: string;
}

const JS_IDENTIFIER_START = /[A-Za-z_$\u0080-\uFFFF]/;
const JS_IDENTIFIER_PART = /[\w$\u0080-\uFFFF]/;

/** 这些词后面的 `/` 才可能是正则字面量的开头（否则是除号）。 */
const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw',
]);

const JS_MULTI_OPERATORS = [
  '>>>=', '===', '!==', '>>>', '**=', '&&=', '||=', '??=', '=>', '==', '!=',
  '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '>>', '::',
];

/** 扫描单/双引号字符串，返回结束位置（结尾引号之后）。 */
function scanQuoted(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    // 单/双引号字符串不允许裸换行；坏输入下到行尾就停，避免死循环。
    if (src[i] === '\n') return i;
    i += 1;
  }
  return src.length;
}

/** 扫描模板串（含 `${}` 里的嵌套字符串 / 模板 / 花括号），返回结束位置。 */
function scanTemplate(src: string, start: number): number {
  let i = start + 1;
  let exprDepth = 0;
  let braceDepth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (exprDepth === 0) {
      if (ch === '`') return i + 1;
      if (ch === '$' && src[i + 1] === '{') {
        exprDepth += 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // 处于 `${ ... }` 内部
    if (ch === "'" || ch === '"') {
      i = scanQuoted(src, i);
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(src, i);
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (braceDepth === 0) {
        exprDepth -= 1;
      } else {
        braceDepth -= 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return src.length;
}

/** 扫描正则字面量；不是合法正则（比如遇到换行）返回 null，调用方按除号处理。 */
function scanRegexLiteral(src: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return null;
    if (inClass) {
      if (ch === ']') inClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return null;
}

function tokenizeJavaScript(src: string): JsToken[] {
  const tokens: JsToken[] = [];
  let i = 0;
  let lastSignificant: JsToken | null = null;

  const push = (token: JsToken): void => {
    tokens.push(token);
    if (token.type !== 'line-comment' && token.type !== 'block-comment') {
      lastSignificant = token;
    }
  };

  const regexAllowedHere = (): boolean => {
    const prev = lastSignificant;
    if (!prev) return true;
    if (prev.type === 'operator') return true;
    if (prev.type === 'punct') {
      return prev.text === '(' || prev.text === '[' || prev.text === '{' || prev.text === ',' || prev.text === ';';
    }
    if (prev.type === 'word') return REGEX_PRECEDING_WORDS.has(prev.text);
    return false;
  };

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j += 1;
      push({ type: 'line-comment', text: src.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end === -1 ? src.length : end + 2;
      push({ type: 'block-comment', text: src.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const j = scanQuoted(src, i);
      push({ type: 'string', text: src.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === '`') {
      const j = scanTemplate(src, i);
      push({ type: 'template', text: src.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const match =
        /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(
          src.slice(i)
        );
      if (match) {
        push({ type: 'number', text: match[0] });
        i += match[0].length;
        continue;
      }
    }

    if (JS_IDENTIFIER_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && JS_IDENTIFIER_PART.test(src[j])) j += 1;
      push({ type: 'word', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // `...` 必须在标点 `.` 之前识别。
    if (src.startsWith('...', i)) {
      push({ type: 'operator', text: '...' });
      i += 3;
      continue;
    }

    if (ch === '/' && regexAllowedHere()) {
      const end = scanRegexLiteral(src, i);
      if (end !== null) {
        push({ type: 'regex', text: src.slice(i, end) });
        i = end;
        continue;
      }
    }

    if ('{}()[];,.:'.includes(ch)) {
      push({ type: 'punct', text: ch });
      i += 1;
      continue;
    }

    const multi = JS_MULTI_OPERATORS.find((op) => src.startsWith(op, i));
    if (multi) {
      push({ type: 'operator', text: multi });
      i += multi.length;
      continue;
    }

    push({ type: 'operator', text: ch });
    i += 1;
  }

  return tokens;
}

const JS_BLOCK_KEYWORDS = new Set([
  'else', 'try', 'finally', 'do', 'switch', 'catch', 'class', 'interface', 'enum',
  'namespace', 'function', 'static', 'get', 'set', 'constructor', 'async',
]);

/** 这些词后面紧跟 `{` 是**对象字面量**而不是语句块。 */
const JS_OBJECT_KEYWORDS = new Set([
  'return', 'yield', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in',
  'of', 'instanceof', 'await', 'as', 'satisfies', 'default', 'import', 'export',
]);

const JS_CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

const JS_UNARY_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'instanceof', 'new',
  'yield', 'await', 'throw',
]);

/** 数组字面量 / 下标前的空格判定：`= [1]`、`return [1]` 有空格；`a[0]` 没有。 */
const JS_SPACE_BEFORE_BRACKET_WORDS = new Set([...JS_OBJECT_KEYWORDS, 'const', 'let', 'var', 'type', 'readonly', 'declare']);

function shouldSpaceBeforeParen(prev: JsToken | null): boolean {
  if (!prev) return false;
  if (prev.type === 'word') return JS_CONTROL_KEYWORDS.has(prev.text) || JS_OBJECT_KEYWORDS.has(prev.text);
  // 一元运算符紧贴括号：`!(x)`；二元 / 赋值 / 箭头两侧有空格：`= (x)`、`=> (x)`。
  if (prev.type === 'operator') return prev.text !== '!' && prev.text !== '~' && prev.text !== '...';
  if (prev.type === 'punct') return false;
  return true;
}

function shouldSpaceBeforeBracket(prev: JsToken | null): boolean {
  if (!prev) return false;
  if (prev.type === 'word') return JS_SPACE_BEFORE_BRACKET_WORDS.has(prev.text);
  if (prev.type === 'operator') return prev.text !== '!' && prev.text !== '~' && prev.text !== '...';
  if (prev.type === 'punct') return prev.text === ',' || prev.text === ';' || prev.text === ':';
  // 字符串 / 数字 / 正则 / 模板后面是下标：`arr[0]`、`"x"[0]` 都不空格。
  return false;
}

function isBlockBrace(prev: JsToken | null): boolean {
  if (!prev) return true;
  if (prev.type === 'punct') {
    if (prev.text === ')' || prev.text === ';' || prev.text === '{' || prev.text === '}') return true;
    return false;
  }
  if (prev.type === 'operator') return prev.text === '=>';
  if (prev.type === 'word') {
    if (JS_BLOCK_KEYWORDS.has(prev.text)) return true;
    if (JS_OBJECT_KEYWORDS.has(prev.text)) return false;
    // 普通标识符后面跟 `{`：`class Foo {` 这类语句块。
    return true;
  }
  return false;
}

export function formatJavaScript(source: string, indentSize: number): string {
  const tokens = tokenizeJavaScript(source);
  if (tokens.length === 0) return '';

  const unit = ' '.repeat(indentSize);
  const out: string[] = [];
  let current = '';
  let lineLevel = 0;
  let level = 0;
  let spacePending = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let ternaryDepth = 0;
  /** 每个打开的 `(` 是不是 `for (...)` 的头部 —— 只有那里的分号不换行。 */
  const parenKinds: Array<'for' | 'other'> = [];
  const braceKinds: Array<'block' | 'object'> = [];

  const flush = (): void => {
    if (current === '') return;
    out.push(unit.repeat(lineLevel) + current.replace(/[ \t]+$/, ''));
    current = '';
  };

  const write = (text: string, attach = false): void => {
    if (current === '') {
      lineLevel = level;
      current = text;
      return;
    }
    if (!attach && spacePending) current += ' ';
    current += text;
  };

  /** 模板串 / 多行块注释含真实换行：首行随缩进，内部原文整段保留。 */
  const appendMultiline = (text: string, attach = false): void => {
    if (!text.includes('\n')) {
      write(text, attach);
      return;
    }
    const parts = text.split('\n');
    write(parts[0], attach);
    flush();
    for (let k = 1; k < parts.length; k += 1) out.push(parts[k]);
    spacePending = true;
  };

  const isUnaryContext = (prev: JsToken | null): boolean => {
    if (!prev) return true;
    if (prev.type === 'operator') return prev.text !== '++' && prev.text !== '--';
    if (prev.type === 'punct') {
      return prev.text === '(' || prev.text === '[' || prev.text === '{' || prev.text === ',' || prev.text === ';' || prev.text === ':';
    }
    if (prev.type === 'word') return JS_UNARY_PRECEDING_WORDS.has(prev.text);
    return false;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;

    // ── 注释 ────────────────────────────────────────────────────────────────
    if (token.type === 'line-comment') {
      write(token.text, false);
      flush();
      spacePending = false;
      continue;
    }
    if (token.type === 'block-comment') {
      appendMultiline(token.text, false);
      spacePending = true;
      continue;
    }

    // ── 标点 ────────────────────────────────────────────────────────────────
    if (token.type === 'punct') {
      switch (token.text) {
        case '{': {
          const emptyPair = next !== null && next.type === 'punct' && next.text === '}';
          const attachBrace = prev !== null && prev.type === 'punct' && (prev.text === '(' || prev.text === '[');
          write('{', attachBrace);
          braceKinds.push(isBlockBrace(prev) ? 'block' : 'object');
          if (!emptyPair) {
            flush();
            level += 1;
          }
          spacePending = false;
          break;
        }
        case '}': {
          const emptyPair = prev !== null && prev.type === 'punct' && prev.text === '{';
          braceKinds.pop();
          if (!emptyPair) {
            flush();
            level = Math.max(0, level - 1);
          }
          write('}', true);
          // `}` 之后：能接在后面的符号紧贴，接不上的换行。
          if (!next) {
            spacePending = false;
          } else if (
            next.type === 'punct' &&
            (next.text === ';' || next.text === ',' || next.text === ')' || next.text === ']' || next.text === '}' || next.text === '(' || next.text === '.')
          ) {
            spacePending = false;
          } else if (next.type === 'operator' && next.text === '=>') {
            spacePending = true;
          } else if (
            next.type === 'word' &&
            (next.text === 'else' || next.text === 'catch' || next.text === 'finally' || next.text === 'while' || next.text === 'from' || next.text === 'as' || next.text === 'satisfies')
          ) {
            spacePending = true;
          } else {
            flush();
            spacePending = false;
          }
          break;
        }
        case '(': {
          parenKinds.push(prev !== null && prev.type === 'word' && prev.text === 'for' ? 'for' : 'other');
          write('(', !shouldSpaceBeforeParen(prev));
          spacePending = false;
          parenDepth += 1;
          break;
        }
        case ')': {
          write(')', true);
          parenKinds.pop();
          parenDepth = Math.max(0, parenDepth - 1);
          spacePending = true;
          break;
        }
        case '[': {
          write('[', !shouldSpaceBeforeBracket(prev));
          spacePending = false;
          bracketDepth += 1;
          break;
        }
        case ']': {
          write(']', true);
          bracketDepth = Math.max(0, bracketDepth - 1);
          spacePending = true;
          break;
        }
        case ',': {
          write(',', true);
          spacePending = false;
          const innermost = braceKinds.length > 0 ? braceKinds[braceKinds.length - 1] : null;
          if (parenDepth > 0 || bracketDepth > 0) {
            spacePending = true;
          } else if (innermost === 'object') {
            flush();
          } else {
            spacePending = true;
          }
          break;
        }
        case ';': {
          write(';', true);
          // 只有 `for (a; b; c)` 头部的分号留在同一行；其他任何位置（包括函数调用
          // 参数里的箭头函数体内）都换行 —— 用 parenDepth>0 判会把后者错成行内。
          const inForHeader = parenKinds.length > 0 && parenKinds[parenKinds.length - 1] === 'for';
          if (inForHeader) {
            spacePending = true;
          } else {
            flush();
            spacePending = false;
          }
          break;
        }
        case '.': {
          write('.', true);
          spacePending = false;
          break;
        }
        case ':': {
          const optionalType = prev !== null && prev.type === 'operator' && prev.text === '?';
          if (optionalType) {
            // 可选属性 / 参数里的冒号：紧贴 `?`，后面要有空格（`name?: string`）。
            write(':', true);
            spacePending = true;
          } else if (ternaryDepth > 0) {
            write(':', false);
            ternaryDepth -= 1;
            spacePending = true;
          } else {
            write(':', true);
            spacePending = true;
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    // ── 运算符 ──────────────────────────────────────────────────────────────
    if (token.type === 'operator') {
      const op = token.text;
      if (op === '?.' || op === '::') {
        write(op, true);
        spacePending = false;
      } else if (op === '!') {
        write('!', false);
        spacePending = false;
      } else if (op === '~') {
        write('~', false);
        spacePending = false;
      } else if (op === '++' || op === '--') {
        write(op, true);
        spacePending = false;
      } else if (op === '...') {
        write('...', false);
        spacePending = false;
      } else if (op === '=>') {
        write('=>', false);
        spacePending = true;
      } else if (op === '?') {
        // TypeScript 的可选属性 / 参数：`name?: string`，问号要紧贴名字。
        // 三元运算符的 `?` 后面跟的是表达式而不是 `:`，所以用「下一个 token」区分。
        const optionalMember = next !== null && next.type === 'punct' && next.text === ':';
        write('?', optionalMember);
        spacePending = !optionalMember;
        if (!optionalMember) ternaryDepth += 1;
      } else if ((op === '-' || op === '+') && isUnaryContext(prev)) {
        write(op, false);
        spacePending = false;
      } else {
        write(op, false);
        spacePending = true;
      }
      continue;
    }

    // ── 字符串 / 模板 / 正则 / 数字 / 词 ────────────────────────────────────
    if (token.type === 'string' || token.type === 'template' || token.type === 'regex') {
      appendMultiline(token.text, false);
      spacePending = true;
      continue;
    }
    if (token.type === 'number' || token.type === 'word') {
      write(token.text, false);
      spacePending = true;
      continue;
    }
  }

  flush();
  return out.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// CSS
// ═════════════════════════════════════════════════════════════════════════════

type CssTokenType = 'word' | 'number' | 'string' | 'comment' | 'punct' | 'operator';

interface CssToken {
  type: CssTokenType;
  text: string;
  /** 源码里这个 token 之前是否有空白（选择器后代组合符 / 值内分隔靠它还原）。 */
  wsBefore: boolean;
}

const CSS_MULTI_OPERATORS = ['::', '~=', '|=', '^=', '$=', '*=', '==', '!=', '>=', '<='];

function scanCssUrl(src: string, start: number): number {
  // start 指向 `(`；扫到配对的 `)`（引号内的括号不算）。
  let i = start + 1;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === ')') return i + 1;
    i += 1;
  }
  return src.length;
}

function tokenizeCss(src: string): CssToken[] {
  const tokens: CssToken[] = [];
  let i = 0;
  let wsBefore = false;

  const push = (token: CssToken): void => {
    tokens.push(token);
    wsBefore = false;
  };

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      wsBefore = true;
      i += 1;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end === -1 ? src.length : end + 2;
      push({ type: 'comment', text: src.slice(i, j), wsBefore });
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const j = scanQuoted(src, i);
      push({ type: 'string', text: src.slice(i, j), wsBefore });
      i = j;
      continue;
    }

    // 数字（可带单位 / 百分比）：`10px`、`1.5rem`、`100%`、`.5em`。
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const match = /^(?:\d*\.?\d+)(?:[eE][+-]?\d+)?(?:[a-zA-Z%]+)?/.exec(src.slice(i));
      if (match) {
        push({ type: 'number', text: match[0], wsBefore });
        i += match[0].length;
        continue;
      }
    }

    // 标识符：允许 `-webkit-` / `--var` / `@media` / `#id` / `#fff`。
    const identifierStart = /[a-zA-Z_@#\u0080-\uFFFF]/.test(ch) || (ch === '-' && /[a-zA-Z_\-\u0080-\uFFFF]/.test(src[i + 1] ?? ''));
    if (identifierStart) {
      let j = i + 1;
      while (j < src.length && /[\w\-\u0080-\uFFFF]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      // `url(...)` 整段原样保留：URL 里的 `://`、括号不能被格式化拆坏。
      if (text.toLowerCase() === 'url' && src[j] === '(') {
        const end = scanCssUrl(src, j);
        push({ type: 'word', text: src.slice(i, end), wsBefore });
        i = end;
        continue;
      }
      push({ type: 'word', text, wsBefore });
      i = j;
      continue;
    }

    const multi = CSS_MULTI_OPERATORS.find((op) => src.startsWith(op, i));
    if (multi) {
      push({ type: 'operator', text: multi, wsBefore });
      i += multi.length;
      continue;
    }

    if ('{}();,:[]'.includes(ch)) {
      push({ type: 'punct', text: ch, wsBefore });
      i += 1;
      continue;
    }

    push({ type: 'operator', text: ch, wsBefore });
    i += 1;
  }

  return tokens;
}

/** 从 `:` 往后看：先遇到 `{` 说明这是选择器里的伪类，先遇到 `;`/`}` 说明是声明。 */
function isSelectorColon(tokens: readonly CssToken[], colonIndex: number): boolean {
  for (let i = colonIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'punct' && token.text === '{') return true;
    if (token.type === 'punct' && (token.text === ';' || token.text === '}')) return false;
  }
  return false;
}

export function formatCss(source: string, indentSize: number): string {
  const tokens = tokenizeCss(source);
  if (tokens.length === 0) return '';

  const unit = ' '.repeat(indentSize);
  const out: string[] = [];
  let current = '';
  let lineLevel = 0;
  let level = 0;
  let spacePending = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  const flush = (): void => {
    if (current === '') return;
    out.push(unit.repeat(lineLevel) + current.replace(/[ \t]+$/, ''));
    current = '';
  };

  /** 写一段文本。`space` 决定前面是否补一个空格（行首不补）。 */
  const write = (text: string, space: boolean): void => {
    if (current === '') {
      lineLevel = level;
      current = text;
      return;
    }
    if (space && !current.endsWith(' ')) current += ' ';
    current += text;
  };

  const appendMultiline = (text: string, space: boolean): void => {
    if (!text.includes('\n')) {
      write(text, space);
      return;
    }
    const parts = text.split('\n');
    write(parts[0], space);
    flush();
    for (let k = 1; k < parts.length; k += 1) out.push(parts[k]);
    spacePending = true;
  };

  /** 值 token 之前的空格判定：源码有空白，或上一步要求补空格（如声明冒号后）。 */
  const valueSpace = (wsBefore: boolean): boolean => current !== '' && (spacePending || wsBefore);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.type === 'comment') {
      appendMultiline(token.text, valueSpace(token.wsBefore));
      spacePending = true;
      continue;
    }

    if (token.type === 'punct') {
      switch (token.text) {
        case '{': {
          write('{', current !== '');
          flush();
          level += 1;
          spacePending = false;
          break;
        }
        case '}': {
          // 最后一条声明没写分号时补上（格式化器的常规输出），再另起一行写 `}`。
          if (current !== '' && current.includes(':') && !current.trimEnd().endsWith(';') && parenDepth === 0 && bracketDepth === 0) {
            current += ';';
          }
          flush();
          level = Math.max(0, level - 1);
          write('}', false);
          flush();
          spacePending = false;
          break;
        }
        case ';': {
          write(';', false);
          flush();
          spacePending = false;
          break;
        }
        case ':': {
          const declaration = parenDepth > 0 || !isSelectorColon(tokens, i);
          write(':', false);
          spacePending = declaration;
          break;
        }
        case ',': {
          const declarationContext = parenDepth > 0 || bracketDepth > 0 || current.includes(':');
          write(',', false);
          if (declarationContext) {
            spacePending = true;
          } else {
            flush();
            spacePending = false;
          }
          break;
        }
        case '(': {
          write('(', valueSpace(token.wsBefore));
          spacePending = false;
          parenDepth += 1;
          break;
        }
        case ')': {
          write(')', false);
          parenDepth = Math.max(0, parenDepth - 1);
          spacePending = true;
          break;
        }
        case '[': {
          write('[', valueSpace(token.wsBefore));
          spacePending = false;
          bracketDepth += 1;
          break;
        }
        case ']': {
          write(']', false);
          bracketDepth = Math.max(0, bracketDepth - 1);
          spacePending = true;
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (token.type === 'operator') {
      const op = token.text;
      if (op === '.' || op === '::') {
        // 类选择器 / 伪元素：紧贴，除非源码里本来就有空白（后代选择器）。
        write(op, current !== '' && token.wsBefore);
        spacePending = false;
      } else if (bracketDepth > 0 && (op === '=' || op.endsWith('='))) {
        // 属性选择器 `[type="text"]` 里的等号两边不空格。
        write(op, false);
        spacePending = false;
      } else if (op === '!') {
        write('!', valueSpace(token.wsBefore));
        spacePending = false;
      } else {
        write(op, valueSpace(token.wsBefore));
        spacePending = true;
      }
      continue;
    }

    if (token.type === 'word' || token.type === 'number' || token.type === 'string') {
      appendMultiline(token.text, valueSpace(token.wsBefore));
      spacePending = true;
      continue;
    }
  }

  flush();
  return out.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML / XML
// ═════════════════════════════════════════════════════════════════════════════

type MarkupTokenType = 'open' | 'close' | 'text' | 'comment' | 'doctype' | 'cdata' | 'pi' | 'raw-inner';

interface MarkupToken {
  type: MarkupTokenType;
  raw: string;
  /** 标签名（小写）；非标签 token 为空串。 */
  name: string;
}

/** HTML 里不需要闭合标签的元素。 */
const HTML_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** HTML 的行内元素：它们与其间的文本留在同一行（否则 `world</strong>!` 会被拆成两行）。 */
const HTML_INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'area', 'audio', 'b', 'bdi', 'bdo', 'br', 'button', 'canvas',
  'cite', 'code', 'data', 'del', 'dfn', 'em', 'embed', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'map', 'mark', 'meter', 'object', 'output',
  'picture', 'progress', 'q', 'ruby', 's', 'samp', 'select', 'small', 'source',
  'span', 'strong', 'sub', 'sup', 'time', 'track', 'u', 'var', 'video', 'wbr',
]);

/** HTML 里内容必须原样保留的元素（JS / CSS / 预格式文本）。 */
const HTML_RAW_ELEMENTS = new Set(['pre', 'textarea', 'script', 'style']);

/** 找一个标签的 `>`，跳过引号里的内容。 */
function findTagEnd(src: string, start: number): number {
  let i = start + 1;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '>') return i + 1;
    i += 1;
  }
  return src.length;
}

function tagNameOf(raw: string): string {
  const match = /^<\/?\s*([^\s/>]+)/.exec(raw);
  return match ? match[1].toLowerCase() : '';
}

function tokenizeMarkup(src: string, mode: 'html' | 'xml'): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  let i = 0;

  const push = (type: MarkupTokenType, raw: string, name = ''): void => {
    tokens.push({ type, raw, name });
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      push('text', src.slice(i));
      break;
    }
    if (lt > i) push('text', src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const j = end === -1 ? src.length : end + 3;
      push('comment', src.slice(lt, j));
      i = j;
      continue;
    }

    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const j = end === -1 ? src.length : end + 3;
      push('cdata', src.slice(lt, j));
      i = j;
      continue;
    }

    if (/^<!doctype/i.test(src.slice(lt, lt + 9))) {
      const j = findTagEnd(src, lt);
      push('doctype', src.slice(lt, j));
      i = j;
      continue;
    }

    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      const j = end === -1 ? findTagEnd(src, lt) : end + 2;
      push('pi', src.slice(lt, j));
      i = j;
      continue;
    }

    if (src.startsWith('</', lt)) {
      const j = findTagEnd(src, lt);
      const raw = src.slice(lt, j);
      push('close', raw, tagNameOf(raw));
      i = j;
      continue;
    }

    if (/^<[A-Za-z_]/.test(src.slice(lt, lt + 2))) {
      const j = findTagEnd(src, lt);
      const raw = src.slice(lt, j);
      const name = tagNameOf(raw);
      push('open', raw, name);
      i = j;

      // HTML 的 raw 元素：内部原文整段保留，不做词法解析。
      if (mode === 'html' && HTML_RAW_ELEMENTS.has(name) && !raw.trimEnd().endsWith('/>')) {
        const closeRe = new RegExp(`</\\s*${escapeRegExp(name)}\\s*>`, 'i');
        const rest = src.slice(i);
        const match = closeRe.exec(rest);
        if (match) {
          push('raw-inner', rest.slice(0, match.index));
          push('close', match[0], name);
          i += match.index + match[0].length;
          continue;
        }
      }
      continue;
    }

    // 孤立的 `<`（正文里的比较符等）当普通文本。
    push('text', '<');
    i = lt + 1;
  }

  return tokens;
}

export function formatMarkup(source: string, indentSize: number, mode: 'html' | 'xml'): string {
  const tokens = tokenizeMarkup(source, mode);
  if (tokens.length === 0) return '';

  const unit = ' '.repeat(indentSize);
  const out: string[] = [];
  let level = 0;
  const stack: string[] = [];
  /** 当前正在拼的行（行内元素与文本都追加到这里）；空串表示还没有行。 */
  let current = '';
  let currentLevel = 0;

  const indentOf = (depth: number): string => unit.repeat(Math.max(0, depth));
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
  /** 行内文本保留首尾各一个空白，不 trim —— 否则 `Hello <strong>` 的空格会丢。 */
  const collapseInline = (text: string): string => text.replace(/\s+/g, ' ');

  const flush = (): void => {
    if (current === '') return;
    out.push(indentOf(currentLevel) + current);
    current = '';
  };

  /** 追加到当前行；没有当前行时，以当前缩进级别开一行。 */
  const append = (text: string): void => {
    if (text === '') return;
    if (current === '') {
      currentLevel = level;
      current = text;
      return;
    }
    current += text;
  };

  const pushLine = (text: string): void => {
    flush();
    out.push(indentOf(level) + text);
  };

  /** 原文块（raw 元素 / CDATA / 多行注释）：首行随缩进，内部行原样保留。 */
  const pushRawBlock = (text: string): void => {
    flush();
    const parts = text.split('\n');
    out.push(indentOf(level) + parts[0]);
    for (let k = 1; k < parts.length; k += 1) out.push(parts[k]);
  };

  const isInline = (name: string): boolean => mode === 'html' && HTML_INLINE_ELEMENTS.has(name);

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === 'open') {
      const selfClosing = token.raw.trimEnd().endsWith('/>');
      const isVoid = mode === 'html' && HTML_VOID_ELEMENTS.has(token.name);

      if (selfClosing || isVoid) {
        if (isInline(token.name)) append(token.raw);
        else pushLine(token.raw);
        i += 1;
        continue;
      }

      // raw 元素：`<pre>...</pre>` 整段原文输出。
      const inner = tokens[i + 1];
      const close = tokens[i + 2];
      if (inner && inner.type === 'raw-inner' && close && close.type === 'close') {
        pushRawBlock(token.raw + inner.raw + close.raw);
        i += 3;
        continue;
      }

      // 行内元素：与上下文留在同一行。
      if (isInline(token.name)) {
        append(token.raw);
        i += 1;
        continue;
      }

      const n1 = tokens[i + 1];
      const n2 = tokens[i + 2];

      // 空元素：`<p></p>`。
      if (n1 && n1.type === 'close' && n1.name === token.name) {
        pushLine(token.raw + n1.raw);
        i += 2;
        continue;
      }

      // 只有一段文本子节点：`<p>Hello</p>` 保持一行。
      if (n1 && n1.type === 'text' && n2 && n2.type === 'close' && n2.name === token.name) {
        const text = collapse(n1.raw);
        if (text !== '' && text.length <= 100) {
          pushLine(token.raw + text + n2.raw);
          i += 3;
          continue;
        }
      }

      pushLine(token.raw);
      stack.push(token.name);
      level += 1;
      i += 1;
      continue;
    }

    if (token.type === 'close') {
      if (isInline(token.name)) {
        append(token.raw);
        i += 1;
        continue;
      }
      flush();
      const index = stack.lastIndexOf(token.name);
      if (index >= 0) {
        const popped = stack.length - index;
        stack.length = index;
        level = Math.max(0, level - popped);
      } else {
        level = Math.max(0, level - 1);
      }
      pushLine(token.raw);
      i += 1;
      continue;
    }

    if (token.type === 'text') {
      if (mode === 'xml') {
        const text = token.raw.trim();
        if (text !== '') {
          if (text.includes('\n')) pushRawBlock(text);
          else pushLine(text);
        }
      } else {
        // HTML：纯空白文本只是源码缩进，忽略；但两个**行内**元素之间的空白是可见的
        // 词间空格（`</span> <span>`），不能丢 —— 补一个空格进当前行。
        if (token.raw.trim() === '') {
          const nextToken = tokens[i + 1];
          const nextIsInline =
            nextToken !== undefined &&
            (nextToken.type === 'open' || nextToken.type === 'close') &&
            isInline(nextToken.name);
          if (current !== '' && nextIsInline) append(' ');
        } else {
          const text = current === '' ? collapseInline(token.raw).trimStart() : collapseInline(token.raw);
          append(text);
        }
      }
      i += 1;
      continue;
    }

    if (token.type === 'comment' || token.type === 'doctype' || token.type === 'cdata' || token.type === 'pi') {
      if (token.raw.includes('\n')) pushRawBlock(token.raw);
      else pushLine(token.raw);
      i += 1;
      continue;
    }

    // 理论上 raw-inner 已在 open 分支被消费；兜底原样输出。
    pushLine(token.raw);
    i += 1;
  }

  flush();
  return out.join('\n');
}
