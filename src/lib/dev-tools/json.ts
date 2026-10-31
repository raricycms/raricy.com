// ─────────────────────────────────────────────────────────────────────────────
// dev-tools/json.ts —— JSON 工具的纯逻辑（零依赖、零 React、node 可直接 import）
//
// 【为什么错误定位要自己算】
//   `JSON.parse` 抛出的 `SyntaxError` 只有一句英文 message，而且**不同引擎给的信息量
//   不一样**：V8（Chrome / Node 22）多数情况带 `at position 12`，有时还带
//   `(line 1 column 13)`；Safari 会带 `line 1 column 13`；老实现干脆什么都不带。
//   直接把这句 message 甩给用户，等于让用户自己数第几个字符。
//   所以这里分三级：
//     1. 从 message 里抠 `position`（最准，直接是 UTF-16 偏移）；
//     2. 抠 `line N column M`（抠到了就换算回偏移，顺便能给出片段）；
//     3. 都没有 → 用本文件里的 `findJsonSyntaxErrorPosition()` 重新扫一遍，找到第一个
//        解析不下去的位置。它是**兜底**，不替代 JSON.parse（能 parse 成功的绝不用它）。
//   最终统一产出 `JsonErrorLocation`（行、列、附近片段 + 插入符），页面只负责渲染。
//
// 【为什么不用 `new Date()` / 格式化时间】
//   `tests/unit/db-time-guard.test.ts` 对 src/lib 静态禁了无参 new Date()。本模块
//   确实一个时间概念都没有，所以天然不碰。
//
// 【5 MB 上限】
//   浏览器里一次格式化几十 MB 的 JSON 会让主线程卡死，而这是纯前端工具、没有后端
//   兜底。上限做成常量，页面文案与校验读同一个数（`JSON_MAX_BYTES`）。
// ─────────────────────────────────────────────────────────────────────────────

/** 输入大小上限：5 MB（UTF-8 字节数）。页面提示与校验都读这个常量。 */
export const JSON_MAX_BYTES = 5 * 1024 * 1024;

/** 格式化时的缩进档位。`tab` 输出一个制表符，数字档位就是空格数。 */
export type JsonIndent = 2 | 4 | 'tab';

export interface JsonFormatOptions {
  /** 默认 2 空格。 */
  indent?: JsonIndent;
  /** 递归按 key 排序（数组保持原顺序）。 */
  sortKeys?: boolean;
}

/** 语法错误的定位结果（行、列都是 1 基）。 */
export interface JsonErrorLocation {
  /** UTF-16 偏移（0 基），已 clamp 到文本长度。 */
  position: number;
  line: number;
  column: number;
  /** 出错那一行被截取后的片段（超长行只留出错位置附近）。 */
  lineText: string;
  /** 两行文本：上面是片段，下面一行的对应列是 `^`。直接塞进 `<pre>`。 */
  snippet: string;
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string; location: JsonErrorLocation | null };

export type JsonEditResult =
  | { ok: true; output: string }
  | { ok: false; message: string; location: JsonErrorLocation | null };

// ── 大小限制 ─────────────────────────────────────────────────────────────────

/** UTF-8 字节数。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 是否超过 5 MB。
 *
 * 每个 UTF-16 码元最多编码成 3 个 UTF-8 字节（代理对是 2 码元 → 4 字节，更省），
 * 所以 `length * 3 <= 上限` 时**一定**没超 —— 先走这个零成本判断，避免每敲一个键
 * 都把整段文本编码一遍。
 */
export function exceedsJsonSizeLimit(text: string): boolean {
  if (text.length * 3 <= JSON_MAX_BYTES) return false;
  return utf8ByteLength(text) > JSON_MAX_BYTES;
}

// ── 错误 message → 中文（不把裸异常给用户）──────────────────────────────────

/**
 * V8 / SpiderMonkey / JavaScriptCore 的 message 关键字 → 一句能指导修改的话。
 * 认不出来时给一句通用说明（位置信息仍然会由 location 给出，不会丢）。
 */
function friendlyJsonMessage(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes('unexpected end of json') || msg.includes('end of json')) {
    return 'JSON 意外结束：可能缺少右括号、右方括号、引号或某个值';
  }
  if (msg.includes('double-quoted property name') || msg.includes('property name')) {
    return '对象的属性名必须用双引号包裹，成员之间要有逗号';
  }
  if (msg.includes("expected ',' or '}'") || msg.includes("expected ',' or ']'")) {
    return '成员之间缺少逗号，或括号不匹配';
  }
  if (msg.includes("expected ':'")) {
    return '属性名后缺少冒号';
  }
  if (msg.includes('unexpected non-whitespace') || msg.includes('after json') || msg.includes('extra data')) {
    return 'JSON 结束之后还有多余内容';
  }
  if (msg.includes('unterminated string')) {
    return '字符串没有闭合（缺少右引号）';
  }
  if (msg.includes('bad control character') || msg.includes('control character')) {
    return '字符串里有未转义的控制字符（换行、制表符等要写成 \\n / \\t）';
  }
  if (msg.includes('invalid number') || msg.includes('bad number')) {
    return '数字格式不合法';
  }
  if (msg.includes('unexpected token')) {
    return '出现了意外的字符（JSON 不接受注释、单引号、尾逗号，也不接受没加引号的键）';
  }
  return 'JSON 语法不正确';
}

interface ExtractedErrorInfo {
  position: number | null;
  line: number | null;
  column: number | null;
}

function extractErrorInfo(message: string): ExtractedErrorInfo {
  const posMatch = /position\s+(\d+)/i.exec(message);
  const lineColMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  return {
    position: posMatch ? Number(posMatch[1]) : null,
    line: lineColMatch ? Number(lineColMatch[1]) : null,
    column: lineColMatch ? Number(lineColMatch[2]) : null,
  };
}

// ── 兜底扫描：JSON.parse 的 message 里什么都没给时，自己找第一个出错位置 ───────

/** 内部信号：扫描器只在失败点抛出它，由 findJsonSyntaxErrorPosition 收口。 */
class JsonScanFailure {
  constructor(readonly position: number) {}
}

/**
 * 扫出第一个不能继续解析的字符偏移（0 基）；完全合法时返回 `null`。
 *
 * 这是一个**宽松度对齐 JSON.parse** 的递归下降扫描器：只做定位，不构造值。
 * 比 JSON.parse 宽松的地方一处都没有 —— 它专门用来「在 parse 已经失败之后
 * 找一个更精确的位置」，宽松了反而会找不到。
 */
export function findJsonSyntaxErrorPosition(input: string): number | null {
  const len = input.length;
  let pos = 0;

  function fail(at: number): never {
    throw new JsonScanFailure(Math.max(0, Math.min(at, len)));
  }

  function skipWs(): void {
    while (pos < len) {
      const c = input[pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos++;
      else break;
    }
  }

  function expectLiteral(word: string): void {
    for (let k = 0; k < word.length; k++) {
      if (input[pos + k] !== word[k]) fail(pos + k);
    }
    pos += word.length;
  }

  function parseString(): void {
    pos++; // 开引号
    while (pos < len) {
      const c = input[pos];
      if (c === '"') {
        pos++;
        return;
      }
      if (c === '\\') {
        const esc = input[pos + 1];
        if (esc === undefined) fail(len);
        if (esc === 'u') {
          for (let k = 0; k < 4; k++) {
            const hex = input[pos + 2 + k];
            const isHex = hex !== undefined && /[0-9a-fA-F]/.test(hex);
            if (!isHex) fail(pos + 2 + k);
          }
          pos += 6;
        } else if ('"\\/bfnrt'.includes(esc)) {
          pos += 2;
        } else {
          fail(pos + 1);
        }
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fail(pos); // 裸控制字符
      pos++;
    }
    fail(len); // 没有右引号
  }

  function parseNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(pos));
    if (!match || match[0].length === 0) fail(pos);
    const end = pos + match[0].length;
    if (end < len && !' \t\n\r,]}'.includes(input[end])) fail(end);
    pos = end;
  }

  function parseObject(): void {
    pos++; // {
    skipWs();
    if (input[pos] === '}') {
      pos++;
      return;
    }
    for (;;) {
      skipWs();
      if (input[pos] !== '"') fail(pos);
      parseString();
      skipWs();
      if (input[pos] !== ':') fail(pos);
      pos++;
      skipWs();
      parseValue();
      skipWs();
      const c = input[pos];
      if (c === ',') {
        pos++;
        continue;
      }
      if (c === '}') {
        pos++;
        return;
      }
      fail(pos);
    }
  }

  function parseArray(): void {
    pos++; // [
    skipWs();
    if (input[pos] === ']') {
      pos++;
      return;
    }
    for (;;) {
      skipWs();
      parseValue();
      skipWs();
      const c = input[pos];
      if (c === ',') {
        pos++;
        continue;
      }
      if (c === ']') {
        pos++;
        return;
      }
      fail(pos);
    }
  }

  function parseValue(): void {
    const c = input[pos];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') return expectLiteral('true');
    if (c === 'f') return expectLiteral('false');
    if (c === 'n') return expectLiteral('null');
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    fail(pos);
  }

  try {
    skipWs();
    if (pos >= len) return len;
    parseValue();
    skipWs();
    if (pos < len) return pos; // 值之后还有多余内容
    return null;
  } catch (e) {
    if (e instanceof JsonScanFailure) return e.position;
    throw e;
  }
}

// ── 位置 → 行/列/片段 ────────────────────────────────────────────────────────

/** 片段最多显示多少个字符（超长行只截出错位置附近的一段）。 */
const SNIPPET_MAX_WIDTH = 140;
/** 截断时，出错位置左边保留多少个字符。 */
const SNIPPET_LEFT_PADDING = 60;

/** 把 0 基偏移换成一个可渲染的定位块（行、列、片段、插入符）。 */
export function jsonLocationAt(text: string, position: number): JsonErrorLocation {
  const clamped = Math.max(0, Math.min(position, text.length));

  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  let lineEnd = text.indexOf('\n', clamped);
  if (lineEnd === -1) lineEnd = text.length;
  if (lineEnd > lineStart && text[lineEnd - 1] === '\r') lineEnd--;

  const column = clamped - lineStart + 1;

  let segStart = lineStart;
  let segEnd = lineEnd;
  const width = segEnd - segStart;
  if (width > SNIPPET_MAX_WIDTH) {
    const caretRel = clamped - lineStart;
    const maxShift = width - SNIPPET_MAX_WIDTH;
    const shift = Math.max(0, Math.min(caretRel - SNIPPET_LEFT_PADDING, maxShift));
    segStart = lineStart + shift;
    segEnd = segStart + SNIPPET_MAX_WIDTH;
  }

  const rawSegment = text.slice(segStart, segEnd);
  const caretOffset = clamped - segStart;
  // 制表符在 <pre> 里宽度不定，统一展开成 4 个空格再算插入符位置。
  const expanded = rawSegment.replace(/\t/g, '    ');
  const caretColumn = rawSegment.slice(0, caretOffset).replace(/\t/g, '    ').length;
  const snippet = `${expanded}\n${' '.repeat(caretColumn)}^`;

  return { position: clamped, line, column, lineText: expanded, snippet };
}

/** `line N column M` → 0 基偏移（用于 message 只带行列、不带 position 的引擎）。 */
function positionFromLineColumn(text: string, line: number, column: number): number {
  let currentLine = 1;
  let offset = 0;
  while (currentLine < line && offset < text.length) {
    if (text.charCodeAt(offset) === 10) currentLine++;
    offset++;
  }
  return Math.min(offset + Math.max(0, column - 1), text.length);
}

// ── 解析 / 格式化 / 压缩 ─────────────────────────────────────────────────────

/**
 * 解析一段 JSON 文本。
 *
 * 空输入（含纯空白）单独报「输入为空」—— 此时 JSON.parse 会抛
 * `Unexpected end of JSON input`，对用户毫无信息量。
 */
export function parseJsonText(input: string): JsonParseResult {
  // 部分编辑器会带上 BOM；JSON.parse 不认它。去掉后再解析，位置以去掉 BOM 的文本计。
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === '') {
    return { ok: false, message: '输入为空', location: null };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const raw = e instanceof Error ? e.message : '';
    const info = extractErrorInfo(raw);
    let position: number | null = info.position;
    if (position === null && info.line !== null && info.column !== null) {
      position = positionFromLineColumn(text, info.line, info.column);
    }
    if (position === null) {
      position = findJsonSyntaxErrorPosition(text);
    }
    const location = position === null ? null : jsonLocationAt(text, position);
    return { ok: false, message: friendlyJsonMessage(raw), location };
  }
}

/** 递归按 key 排序；数组顺序保持原样。用 Object.fromEntries 安全写入（避免 `__proto__` 赋值陷阱）。 */
export function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonKeys(item));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortJsonKeys(item)]));
  }
  return value;
}

/** 格式化：解析 → 可选排序 → JSON.stringify。失败时返回语法错误，不抛异常。 */
export function formatJson(input: string, options: JsonFormatOptions = {}): JsonEditResult {
  const parsed = parseJsonText(input);
  if (!parsed.ok) return parsed;
  const value = options.sortKeys === true ? sortJsonKeys(parsed.value) : parsed.value;
  const indent = options.indent === 'tab' ? '\t' : (options.indent ?? 2);
  return { ok: true, output: JSON.stringify(value, null, indent) };
}

/** 压缩成一行。失败时返回语法错误，不抛异常。 */
export function minifyJson(input: string): JsonEditResult {
  const parsed = parseJsonText(input);
  if (!parsed.ok) return parsed;
  return { ok: true, output: JSON.stringify(parsed.value) };
}

/** 节点数（数组元素 / 对象成员各算一个）。树形查看器用它判断「是否超过 2000」。 */
export function countJsonNodes(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    count++;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (current !== null && typeof current === 'object') {
      for (const item of Object.values(current as Record<string, unknown>)) stack.push(item);
    }
  }
  return count;
}

// ── JSONPath 子集 ────────────────────────────────────────────────────────────
//
// 只实现「查值」需要的四种子集语法，**不**实现过滤器 / 切片 / 函数：
//   $            根
//   .key         对象成员（也接受 ['key'] / ["key"]）
//   [0]          数组下标
//   [*] / .*     通配（数组元素 / 对象成员）
//   ..key / ..*  递归下降
// 不是「将就能用」的裁剪：解析器会明确拒绝 `[?()]`、`[1:3]`、`[0,1]`、`@` 这些
// 语法，并给出「不支持」的提示，而不是静默返回空结果（空结果与「没命中」长得一样）。

export type JsonPathToken =
  | { type: 'key'; key: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }
  | { type: 'recursive'; key: string | null };

export type JsonPathParseResult =
  | { ok: true; tokens: JsonPathToken[] }
  | { ok: false; message: string };

/** 查询结果最多展示多少条（页面切片用；查询本身返回全部）。 */
export const JSON_PATH_RESULT_LIMIT = 500;

/** 页面上「支持的写法」清单（诚实说明的唯一副本）。 */
export const JSON_PATH_SUPPORTED_SYNTAX: ReadonlyArray<{ syntax: string; meaning: string }> = [
  { syntax: '$', meaning: '根节点' },
  { syntax: '.key / [\'key\'] / ["key"]', meaning: '对象的成员' },
  { syntax: '[0]', meaning: '数组下标（负数不支持）' },
  { syntax: '[*] / .*', meaning: '通配：数组的所有元素 / 对象的所有成员' },
  { syntax: '..key', meaning: '递归下降：任意深度上同名的成员，按文档顺序列出' },
  { syntax: '..*', meaning: '递归下降：所有后代节点的值（不含根自己）' },
];

/** 页面上「不支持」清单。 */
export const JSON_PATH_UNSUPPORTED: readonly string[] = [
  '过滤表达式 [?(@.age > 18)]',
  '数组切片 [1:3] 与联合下标 [0,1]',
  '函数调用（如 length()、min()）与脚本表达式',
  '当前节点 @、父节点 ^ 等其它定位符',
];

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** 把「对象键」拼成规范路径：能当标识符就 `.key`，否则用 `["key"]`。 */
function joinPathKey(base: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function joinPathIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析路径。必须 `$` 开头；空键名、未闭合方括号、不支持的方括号表达式都会报错，
 * 错误信息里带上第几个字符，方便对齐输入框。
 */
export function parseJsonPath(input: string): JsonPathParseResult {
  const path = input.trim();
  if (path === '') return { ok: false, message: '路径为空，先输入类似 $.a.b[0] 的路径' };
  if (!path.startsWith('$')) {
    return { ok: false, message: '路径必须以 $ 开头，例如 $.a.b[0] 或 $..name' };
  }

  const tokens: JsonPathToken[] = [];
  let i = 1;

  const readName = (): string => {
    const start = i;
    while (i < path.length) {
      const c = path[i];
      if (c === '.' || c === '[' || c === ']') break;
      i++;
    }
    return path.slice(start, i);
  };

  while (i < path.length) {
    const c = path[i];

    if (c === '.') {
      if (path[i + 1] === '.') {
        i += 2;
        if (path[i] === '*') {
          tokens.push({ type: 'recursive', key: null });
          i++;
          continue;
        }
        const name = readName();
        if (name === '') {
          return { ok: false, message: `第 ${i + 1} 个字符处缺少键名（.. 后面要跟键名或 *）` };
        }
        tokens.push({ type: 'recursive', key: name });
        continue;
      }
      i++;
      if (path[i] === '*') {
        tokens.push({ type: 'wildcard' });
        i++;
        continue;
      }
      const name = readName();
      if (name === '') {
        return { ok: false, message: `第 ${i + 1} 个字符处缺少键名` };
      }
      tokens.push({ type: 'key', key: name });
      continue;
    }

    if (c === '[') {
      const close = path.indexOf(']', i + 1);
      if (close === -1) {
        return { ok: false, message: '方括号没有闭合（缺少 ]）' };
      }
      const inner = path.slice(i + 1, close).trim();
      i = close + 1;

      if (inner === '*') {
        tokens.push({ type: 'wildcard' });
        continue;
      }
      if (/^\d+$/.test(inner)) {
        tokens.push({ type: 'index', index: Number(inner) });
        continue;
      }
      const quote = inner[0];
      if ((quote === "'" || quote === '"') && inner.length >= 2 && inner[inner.length - 1] === quote) {
        const body = inner.slice(1, -1);
        tokens.push({ type: 'key', key: body.replace(/\\(.)/g, '$1') });
        continue;
      }
      if (inner === '') return { ok: false, message: '方括号里是空的' };
      return {
        ok: false,
        message: `不支持的方括号表达式 [${inner}]：这里只支持 [0]、[*] 与 ['key']`,
      };
    }

    return {
      ok: false,
      message: `第 ${i + 1} 个字符「${c}」无法识别（支持 $、.key、[0]、[*]、..key）`,
    };
  }

  return { ok: true, tokens };
}

export interface JsonPathHit {
  /** 规范化的路径（例如 `$.items[0].name`、`$["a b"]`）。 */
  path: string;
  value: unknown;
}

function ownKey(node: unknown, key: string): boolean {
  return isRecord(node) && Object.prototype.hasOwnProperty.call(node, key);
}

/** 递归下降收集。`seen` 防住调用方传进来的环（JSON.parse 出来的值不会有环）。 */
function collectRecursive(
  node: unknown,
  basePath: string,
  key: string | null,
  out: JsonPathHit[],
  seen: WeakSet<object>,
): void {
  if (key !== null && ownKey(node, key)) {
    out.push({ path: joinPathKey(basePath, key), value: (node as Record<string, unknown>)[key] });
  }

  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (key === null) {
    // ..*：只收后代（不含当前节点自己），先序。
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        const childPath = joinPathIndex(basePath, index);
        out.push({ path: childPath, value: child });
        collectRecursive(child, childPath, null, out, seen);
      });
    } else if (isRecord(node)) {
      for (const [childKey, childValue] of Object.entries(node)) {
        const childPath = joinPathKey(basePath, childKey);
        out.push({ path: childPath, value: childValue });
        collectRecursive(childValue, childPath, null, out, seen);
      }
    }
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((child, index) => collectRecursive(child, joinPathIndex(basePath, index), key, out, seen));
  } else {
    for (const [childKey, childValue] of Object.entries(node)) {
      collectRecursive(childValue, joinPathKey(basePath, childKey), key, out, seen);
    }
  }
}

/**
 * 按 token 序列查询。返回**全部**命中（页面负责限制展示条数）。
 * 没有任何命中时返回空数组 —— 这本身就是正常结果（页面显示「0 处命中」）。
 */
export function queryJsonPath(root: unknown, tokens: JsonPathToken[]): JsonPathHit[] {
  let current: JsonPathHit[] = [{ path: '$', value: root }];

  for (const token of tokens) {
    const next: JsonPathHit[] = [];
    for (const hit of current) {
      if (token.type === 'key') {
        if (ownKey(hit.value, token.key)) {
          next.push({
            path: joinPathKey(hit.path, token.key),
            value: (hit.value as Record<string, unknown>)[token.key],
          });
        }
      } else if (token.type === 'index') {
        if (Array.isArray(hit.value) && token.index < hit.value.length) {
          next.push({
            path: joinPathIndex(hit.path, token.index),
            value: hit.value[token.index],
          });
        }
      } else if (token.type === 'wildcard') {
        if (Array.isArray(hit.value)) {
          hit.value.forEach((child, index) => {
            next.push({ path: joinPathIndex(hit.path, index), value: child });
          });
        } else if (isRecord(hit.value)) {
          for (const [key, child] of Object.entries(hit.value)) {
            next.push({ path: joinPathKey(hit.path, key), value: child });
          }
        }
      } else {
        collectRecursive(hit.value, hit.path, token.key, next, new WeakSet());
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  return current;
}
