// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/table-data.ts —— 表格 / 结构化数据的公共中间表示与
// 各格式读写内核（roadmap §8）。
//
// 【它是什么】一切表格转换都走「解析 → Table → 序列化」：
//   Table = { columns: string[]; rows: Cell[][] }，Cell = string | number | boolean | null。
//   列与行的映射规则（空值 / 重复列名 / 类型识别 / 嵌套内容）全部集中在这一处，
//   类别层（categories/table.ts）只做参数解析、限额与阶段推进。
//
// 【纪律】
//   · 零 DOM：函数只吃 string / Uint8Array，吐 string / Uint8Array / Table，
//     node 环境的单元测试直接驱动。
//   · 重引擎一律函数内 `await import(...)`（xlsx / js-yaml / fast-xml-parser）——
//     静态引入会把它们卷进每个页面的主包。手写的 CSV / JSON / NDJSON 解析与
//     XML 序列化是同步纯函数。
//   · 错误一律抛 { kind, message, detail? }（ConvertError 形状）；行数 / 列数
//     上限在解析过程中即判（超限立刻停，不把整个文件建完再扔）。
//   · 日期**不猜**（猜了就是静默错）：文本族输入的 "2024-01-01" 永远是文本；
//     Excel 日期单元格以序列号数字导出并给 notice；YAML 的显式时间戳转 ISO 文本
//     并给 notice。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from '../formats';
import type { ConvertError } from '../types';

// ─── 中间表示 ────────────────────────────────────────────────────────────────

export type Cell = string | number | boolean | null;

export interface Table {
  columns: string[];
  /** 每行长度恒等于 columns.length（解析时已补齐）。 */
  rows: Cell[][];
}

export interface ParsedTable {
  table: Table;
  /** 解析阶段实际发生的保留 / 损失说明（结果页照实列出）。 */
  notices: string[];
}

/** 列数上限（LIMITS.table 只有字节与行数，列上限由本模块自定并自测）。 */
export const MAX_TABLE_COLUMNS = 2000;

type CancelProbe = (() => boolean) | undefined;

function fail(kind: ConvertError['kind'], message: string, detail?: string): never {
  throw { kind, message, detail } satisfies ConvertError;
}

function errDetail(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1500);
}

function checkCancelled(isCancelled: CancelProbe): void {
  if (isCancelled?.()) fail('cancelled', '已取消');
}

/** 行 / 列上限，解析后立即调用（runner）+ 解析过程中即判（本模块各 parser）。 */
export function assertTableSize(table: Table): void {
  if (table.rows.length > LIMITS.table.maxRows) {
    fail('oversize', `共 ${table.rows.length} 行，超过 ${LIMITS.table.maxRows} 行上限`);
  }
  if (table.columns.length > MAX_TABLE_COLUMNS) {
    fail('oversize', `共 ${table.columns.length} 列，超过 ${MAX_TABLE_COLUMNS} 列上限`);
  }
}

/** UTF-8 解码（ fatal：非 UTF-8 输入明确报错，不带着乱码继续）。 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('corrupt', '文件不是有效的 UTF-8 文本；请先在「文本」标签页把它转成 UTF-8 编码');
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── 类型识别（guessTypes）─────────────────────────────────────────────────────
//
// 边界（单测钉住）：
//   · 前导零编号（"00123"）保持文本 —— 账号 / 订单号不能被吃掉前导零（roadmap §8.3）。
//   · 有效数字位 > 15 的一律保持文本 —— 普通 Number 丢精度（roadmap §8.2 大整数）。
//   · 指数 / 小数以外的奇怪写法（"+5" / ".5" / "1." / "1,000" / "0x10"）保持文本。
//   · 日期与时间一律不猜（"2024-01-01" / "12:30" 永远是文本）—— 猜了就是静默错。
//   · 空字段 → null（CSV 无法表达「空字符串」与「空值」的区别，统一按空值）。

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export function guessCell(s: string): Cell {
  if (s === '') return null;
  const lower = s.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (NUMBER_RE.test(s)) {
    // 有效数字位数：去掉符号 / 小数点 / 指数部分与前导零后数数字。
    const mantissa = s.split(/[eE]/)[0].replace(/^-/, '').replace('.', '');
    const significant = mantissa.replace(/^0+/, '');
    if (significant.length <= 15) {
      const n = Number(s);
      if (Number.isFinite(n)) return n;
    }
  }
  return s;
}

/** Cell → 文本（null → 空，布尔 → true/false，数字 → 十进制文本）。 */
export function cellToText(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'boolean') return c ? 'true' : 'false';
  return String(c);
}

// ─── 列名规范化（空名 → 列N；重名 → 加序号，两者都给 notice）────────────────────

export function normalizeColumns(
  headerRow: string[] | null,
  width: number
): { columns: string[]; renamed: string[] } {
  const columns: string[] = [];
  const renamed: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    let name = headerRow && i < headerRow.length ? headerRow[i] : '';
    if (name === '') name = `列${i + 1}`;
    if (seen.has(name)) {
      let k = (seen.get(name) ?? 1) + 1;
      let candidate = `${name}_${k}`;
      while (seen.has(candidate)) {
        k++;
        candidate = `${name}_${k}`;
      }
      seen.set(name, k);
      seen.set(candidate, 1);
      renamed.push(`第 ${i + 1} 列与前面的同名列「${name}」重复，已改名为「${candidate}」`);
      name = candidate;
    } else {
      seen.set(name, 1);
    }
    columns.push(name);
  }
  return { columns, renamed };
}

// ─── CSV / TSV（RFC4180：引号包裹、内嵌分隔符 / 换行、"" 转义）──────────────────

/**
 * 解析 CSV / TSV 文本为原始字段矩阵（全部是字符串，类型识别在 rowsToTable）。
 * 容错取向：字段中间的孤立引号按字面收；**引号未闭合**报 corrupt。
 * 文件末尾的换行不产生幻影行；尾部全空行丢弃（中间的空行保留）。
 */
export function parseDelimitedText(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      quoteLine = line;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      if (rows.length > LIMITS.table.maxRows + 1) {
        fail('oversize', `超过 ${LIMITS.table.maxRows} 行上限`);
      }
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i += 2;
      else i++;
      line++;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) fail('corrupt', `第 ${quoteLine} 行的引号没有闭合，文件可能损坏`);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((f) => f === '')) rows.pop();
  return rows;
}

export interface RowsToTableOptions {
  /** 首行是表头。 */
  header: boolean;
  /** 自动识别数字 / 布尔（仅文本族输入；见 guessCell 的边界）。 */
  guessTypes: boolean;
  isCancelled?: CancelProbe;
}

/** 原始字段矩阵 → Table（补列名、去重列名、长短行补齐、类型识别）。 */
export function rowsToTable(raw: string[][], opts: RowsToTableOptions): ParsedTable {
  const notices: string[] = [];
  if (raw.length === 0) return { table: { columns: [], rows: [] }, notices };
  let width = 0;
  for (const r of raw) if (r.length > width) width = r.length;
  if (width > MAX_TABLE_COLUMNS) fail('oversize', `共 ${width} 列，超过 ${MAX_TABLE_COLUMNS} 列上限`);

  let headerRow: string[] | null = null;
  let dataRaw = raw;
  if (opts.header) {
    headerRow = raw[0];
    dataRaw = raw.slice(1);
  }
  const { columns, renamed } = normalizeColumns(headerRow, width);
  notices.push(...renamed);

  let ragged = false;
  const rows: Cell[][] = [];
  for (let i = 0; i < dataRaw.length; i++) {
    if (i % 4096 === 0) checkCancelled(opts.isCancelled);
    const r = dataRaw[i];
    if (r.length !== width) ragged = true;
    const out: Cell[] = new Array(width);
    for (let j = 0; j < width; j++) {
      const f = j < r.length ? r[j] : '';
      out[j] = opts.guessTypes ? guessCell(f) : f;
    }
    rows.push(out);
    if (rows.length > LIMITS.table.maxRows) {
      fail('oversize', `共 ${raw.length} 行，超过 ${LIMITS.table.maxRows} 行上限`);
    }
  }
  if (ragged) {
    notices.push(
      opts.header
        ? '各行字段数不一致：较短的行已补空值，超出表头宽度的列已自动补列名'
        : '各行字段数不一致：较短的行已补空值'
    );
  }
  return { table: { columns, rows }, notices };
}

/** 序列化为 CSV / TSV（RFC4180：含分隔符 / 引号 / 换行的字段加引号，引号双写）。 */
export function serializeDelimited(
  table: Table,
  delimiter: ',' | '\t',
  opts: { header: boolean }
): string {
  const quote = (s: string): string =>
    s.includes(delimiter) || s.includes('"') || s.includes('\r') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  const lines: string[] = [];
  if (opts.header) lines.push(table.columns.map(quote).join(delimiter));
  for (const row of table.rows) {
    lines.push(row.map((c) => quote(cellToText(c))).join(delimiter));
  }
  return lines.length === 0 ? '' : lines.join('\r\n') + '\r\n';
}

// ─── JSON / NDJSON / YAML 共用的「记录数组 → Table」────────────────────────────

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

interface NormalizeState {
  nested: boolean;
  dates: boolean;
}

/** 任意 JSON 值 → Cell：嵌套对象 / 数组展开为 JSON 文本；Date → ISO 文本。 */
function normalizeValue(v: unknown, guess: boolean, state: NormalizeState): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return guess ? guessCell(v) : v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Date) {
    state.dates = true;
    return v.toISOString();
  }
  state.nested = true;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface RecordsToTableOptions {
  /** 只对字符串单元格生效（XML 输入传用户参数；JSON / YAML 有原生类型，恒 false）。 */
  guessTypes?: boolean;
  isCancelled?: CancelProbe;
}

/** 记录数组 → Table：列 = 键的并集（首见顺序），缺失键 → null。 */
export function recordsToTable(
  records: Record<string, unknown>[],
  opts: RecordsToTableOptions = {}
): ParsedTable {
  const notices: string[] = [];
  const seen = new Set<string>();
  const rawColumns: string[] = [];
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        rawColumns.push(k);
      }
    }
  }
  if (rawColumns.length > MAX_TABLE_COLUMNS) {
    fail('oversize', `共 ${rawColumns.length} 列，超过 ${MAX_TABLE_COLUMNS} 列上限`);
  }
  // JSON 键可能是 '' —— 与 CSV 空表头走同一条「列N」规范化。
  const { columns, renamed } = normalizeColumns(rawColumns, rawColumns.length);
  notices.push(...renamed);
  // 若列名被规范化（空名 / 重名），行按键原名取，写到规范化后的槽位。
  const state: NormalizeState = { nested: false, dates: false };
  const rows: Cell[][] = [];
  for (let i = 0; i < records.length; i++) {
    if (i % 4096 === 0) checkCancelled(opts.isCancelled);
    const rec = records[i];
    const out: Cell[] = new Array(columns.length);
    for (let j = 0; j < columns.length; j++) {
      out[j] = normalizeValue(rec[rawColumns[j]], opts.guessTypes ?? false, state);
    }
    rows.push(out);
    if (rows.length > LIMITS.table.maxRows) {
      fail('oversize', `共 ${records.length} 行，超过 ${LIMITS.table.maxRows} 行上限`);
    }
  }
  if (state.nested) notices.push('含嵌套对象 / 数组的单元格已展开为 JSON 文本');
  if (state.dates) notices.push('日期值已转换为 ISO 格式文本');
  return { table: { columns, rows }, notices };
}

/** Table → 记录数组（JSON / NDJSON / YAML 输出共用）。 */
export function tableToRecords(table: Table): Record<string, Cell>[] {
  return table.rows.map((r) => {
    const o: Record<string, Cell> = {};
    for (let i = 0; i < table.columns.length; i++) o[table.columns[i]] = r[i];
    return o;
  });
}

/**
 * Table → JSON 文本（顶层数组，每个对象一排；空单元格是 null）。
 * 缩进两格是为了让结果页的文本预览可读，`JSON.parse` 不关心缩进。
 * 递归结构不会被引入 —— 单元格值只有 string / number / boolean / null。
 * 空表（只有列名没有数据行）输出 `[]`，不与「输出为空」的失败判据混淆。
 */
export function tableToJsonText(table: Table): string {
  return `${JSON.stringify(tableToRecords(table), null, 2)}\n`;
}

/**
 * Table → NDJSON 文本（每行一个 JSON 对象，行间 `\n`，末尾一个 `\n`）。
 * 每行必须自成一行：所以这里**不缩进**（多行缩进会破坏「一行一条记录」）。
 * 没有数据行时输出空串 —— 空的 NDJSON 是合法表示，由执行层按「输出为空」处理。
 */
export function tableToNdjsonText(table: Table): string {
  const records = tableToRecords(table);
  return records.length === 0 ? '' : `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

// ─── JSON ────────────────────────────────────────────────────────────────────
//
// 形态规则（roadmap §8.2，没有「天然映射」的形态明确拒绝而不是猜）：
//   · 顶层数组 + 元素全是对象 → 记录数组。
//   · 顶层对象且**恰好一个**数组字段 → 取该字段（{data:[...]} 一层识别）+ notice。
//   · 其余（纯值、纯值数组、多个数组字段、没有数组字段的对象）→ unsupported。

export function parseJsonText(text: string): ParsedTable {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch (e) {
    return fail('corrupt', '不是有效的 JSON，无法解析', errDetail(e));
  }
  if (Array.isArray(data)) {
    if (!data.every(isPlainRecord)) {
      return fail(
        'unsupported',
        'JSON 数组的元素必须都是对象（形如 [{"列": 值}, …]）；纯数字 / 字符串数组没有表格含义'
      );
    }
    return recordsToTable(data as Record<string, unknown>[]);
  }
  if (isPlainRecord(data)) {
    const arrayKeys = Object.keys(data).filter((k) => Array.isArray(data[k]));
    if (arrayKeys.length === 1) {
      const key = arrayKeys[0];
      const arr = data[key] as unknown[];
      if (!arr.every(isPlainRecord)) {
        return fail('unsupported', `「${key}」字段的数组元素必须都是对象`);
      }
      const parsed = recordsToTable(arr as Record<string, unknown>[]);
      parsed.notices.unshift(`顶层是对象：已取「${key}」字段作为记录数组，该对象的其它字段未包含`);
      return parsed;
    }
    if (arrayKeys.length > 1) {
      return fail(
        'unsupported',
        `顶层对象包含多个数组字段（${arrayKeys.join('、')}），无法自动判断用哪个，请先拆出记录数组`
      );
    }
    return fail('unsupported', '顶层是对象但没有数组字段；支持「对象数组」或 {"data": […]} 形态');
  }
  return fail('unsupported', 'JSON 顶层必须是对象数组（或包一层的对象），纯数字 / 字符串没有表格含义');
}

// ─── NDJSON（逐行一个 JSON 对象）──────────────────────────────────────────────

export function parseNdjsonText(text: string): ParsedTable {
  const records: Record<string, unknown>[] = [];
  const lines = stripBom(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch (e) {
      return fail('corrupt', `第 ${i + 1} 行不是有效的 JSON，文件可能损坏`, errDetail(e));
    }
    if (!isPlainRecord(v)) {
      return fail('unsupported', `第 ${i + 1} 行不是 JSON 对象，无法映射为表格行`);
    }
    records.push(v);
    if (records.length > LIMITS.table.maxRows) {
      fail('oversize', `超过 ${LIMITS.table.maxRows} 行上限`);
    }
  }
  return recordsToTable(records);
}

// ─── YAML（js-yaml，动态 import；只支持「记录数组」形态）────────────────────────

export async function parseYamlText(text: string): Promise<ParsedTable> {
  const yaml = await import('js-yaml');
  let data: unknown;
  try {
    data = yaml.load(text);
  } catch (e) {
    return fail('corrupt', 'YAML 解析失败，文件可能损坏或语法有误', errDetail(e));
  }
  if (!Array.isArray(data)) {
    return fail('unsupported', '暂只支持「记录数组」形态的 YAML（顶层是 - 开头的列表，每项是键值对）');
  }
  if (!data.every(isPlainRecord)) {
    return fail('unsupported', 'YAML 数组的元素必须都是键值对对象');
  }
  return recordsToTable(data as Record<string, unknown>[]);
}

export async function tableToYaml(table: Table): Promise<string> {
  const yaml = await import('js-yaml');
  // noRefs：不出锚点 / 引用（锚点在读回时可能被解成共享对象，语义反而含糊）；
  // lineWidth: -1：长文本不折叠换行，保持一条记录一坨的可读形状。
  return yaml.dump(tableToRecords(table), { noRefs: true, lineWidth: -1 });
}

// ─── XML（fast-xml-parser，动态 import；约定式映射，不承诺任意 XML 无损往返）─────
//
// 输出约定：<rows><row><col name="列名">值</col>…</row>…</rows>
//   （列名任意文本都合法，所以放属性里而不是当标签名）。
// 输入规则（「尽量找重复子元素当行」，roadmap §8.2 要求显式规则）：
//   · 根元素下**恰好一种**重复子元素 → 每个重复元素一行；
//   · 根元素下只有一种子元素但没重复 → 唯一一行；
//   · 根元素下有多种子元素且都没重复 → 根本身当作唯一一行（子元素 = 单元格）；
//   · 根元素下有多种**重复**子元素 → 无法判断，unsupported。
// 单元格：子元素文本为值；列名取 `name` 属性（我们自己的约定），否则取标签名。
// 行 / 单元格上的其它属性不进表格（notice）；嵌套结构展开为 JSON 文本（notice）。

const XML_ATTR = '@_';
const XML_NAME_ATTR = '@_name';
const XML_TEXT = '#text';

interface XmlParseState {
  attrDropped: boolean;
  nested: boolean;
}

function xmlScalarText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function xmlOnlyAttributes(rec: Record<string, unknown>): boolean {
  return Object.keys(rec).every((k) => k.startsWith(XML_ATTR));
}

function xmlAssignCell(rec: Record<string, unknown>, v: unknown, tag: string, state: XmlParseState): void {
  if (isPlainRecord(v)) {
    const name = typeof v[XML_NAME_ATTR] === 'string' ? (v[XML_NAME_ATTR] as string) : tag;
    const childKeys = Object.keys(v).filter((k) => k !== XML_TEXT && !k.startsWith(XML_ATTR));
    if (childKeys.length > 0) {
      // 单元格里还有嵌套子元素 —— 整个展开为 JSON 文本，不静默丢。
      state.nested = true;
      rec[name] = JSON.stringify(v);
      return;
    }
    if (Object.keys(v).some((k) => k.startsWith(XML_ATTR) && k !== XML_NAME_ATTR)) state.attrDropped = true;
    rec[name] = XML_TEXT in v ? xmlScalarText(v[XML_TEXT]) : '';
    return;
  }
  if (Array.isArray(v)) {
    state.nested = true;
    rec[tag] = JSON.stringify(v);
    return;
  }
  rec[tag] = xmlScalarText(v);
}

function xmlRowToRecord(rv: unknown, rowTag: string, state: XmlParseState): Record<string, unknown> {
  if (!isPlainRecord(rv)) {
    // <item>文本</item> 这类标量行：单列，列名用行标签。
    return { [rowTag]: xmlScalarText(rv) };
  }
  const rec: Record<string, unknown> = {};
  for (const k of Object.keys(rv)) {
    if (k.startsWith(XML_ATTR)) {
      state.attrDropped = true;
      continue;
    }
    if (k === XML_TEXT) {
      // 行元素本身混有文本（混合内容）—— 不丢，按嵌套处理。
      state.nested = true;
      rec[rowTag] = xmlScalarText(rv[k]);
      continue;
    }
    const v = rv[k];
    if (Array.isArray(v)) {
      // 同行内同名子元素重复：我们自己的 <col name="…"> 约定下每个元素一个单元格；
      // 外来 XML 的重复子元素则是一格多值 —— 展开为 JSON 文本。
      if (v.every((el) => isPlainRecord(el) && (XML_NAME_ATTR in el || XML_TEXT in el || xmlOnlyAttributes(el)))) {
        for (const el of v) xmlAssignCell(rec, el, k, state);
      } else {
        state.nested = true;
        rec[k] = JSON.stringify(v);
      }
      continue;
    }
    xmlAssignCell(rec, v, k, state);
  }
  return rec;
}

export async function parseXmlText(
  text: string,
  opts: { guessTypes: boolean; isCancelled?: CancelProbe }
): Promise<ParsedTable> {
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  // fast-xml-parser 的 parse 对坏语法很宽容（可能静默产出垃圾），先显式校验。
  const verdict = XMLValidator.validate(text);
  if (verdict !== true) {
    return fail('corrupt', 'XML 语法有误，无法解析', `${verdict.err.msg}（第 ${verdict.err.line} 行）`);
  }
  const doc: unknown = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: XML_ATTR,
    parseTagValue: false, // 单元格一律先按文本读，类型识别统一走 guessCell
    parseAttributeValue: false,
    ignoreDeclaration: true,
    trimValues: true,
  }).parse(stripBom(text));

  const notices: string[] = ['XML 按「重复子元素当行」的约定解析，属约定式映射'];
  const empty: ParsedTable = { table: { columns: [], rows: [] }, notices };
  if (!isPlainRecord(doc)) return empty;
  const rootKeys = Object.keys(doc);
  if (rootKeys.length === 0) return empty;
  if (rootKeys.length > 1) return fail('unsupported', 'XML 必须有且仅有一个根元素');
  const rootVal = doc[rootKeys[0]];
  if (rootVal === '' || rootVal === null || rootVal === undefined) return empty;
  if (!isPlainRecord(rootVal)) return fail('unsupported', '根元素下没有可当作「行」的子元素');

  const childKeys = Object.keys(rootVal).filter((k) => !k.startsWith(XML_ATTR) && k !== XML_TEXT);
  if (childKeys.length === 0) return empty;
  const repeated = childKeys.filter((k) => Array.isArray(rootVal[k]));

  const state: XmlParseState = { attrDropped: false, nested: false };
  let records: Record<string, unknown>[];
  if (repeated.length === 1) {
    const rowTag = repeated[0];
    records = (rootVal[rowTag] as unknown[]).map((rv) => xmlRowToRecord(rv, rowTag, state));
  } else if (repeated.length === 0 && childKeys.length === 1) {
    // 只有一种子元素且没重复：唯一一行（我们自己序列化单行表时就是这形状）。
    const rowTag = childKeys[0];
    records = [xmlRowToRecord(rootVal[rowTag], rowTag, state)];
  } else if (repeated.length === 0) {
    // 多种子元素都没重复：根本身是唯一一行（<person><name>…</name><age>…</age></person>）。
    records = [xmlRowToRecord(rootVal, rootKeys[0], state)];
  } else {
    return fail(
      'unsupported',
      `根元素下有多种重复子元素（${repeated.join('、')}），无法自动判断哪个是行`
    );
  }
  if (state.attrDropped) notices.push('行 / 单元格元素上的 XML 属性未包含（列名只取 name 属性）');
  const parsed = recordsToTable(records, { guessTypes: opts.guessTypes, isCancelled: opts.isCancelled });
  return { table: parsed.table, notices: [...notices, ...parsed.notices] };
}

/** Table → XML（手写序列化：结构固定，转义就四个字符，比再拉一个 builder 可控）。 */
export function tableToXml(table: Table): string {
  const escText = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;');
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<rows>'];
  for (const row of table.rows) {
    const cells = row
      .map((c, i) => `<col name="${escAttr(table.columns[i])}">${escText(cellToText(c))}</col>`)
      .join('');
    lines.push(`  <row>${cells}</row>`);
  }
  lines.push('</rows>');
  return lines.join('\n') + '\n';
}

// ─── XLSX（xlsx 包，动态 import；node 与浏览器同一代码路径）─────────────────────

/** 只读工作表名单（probe 用；bookSheets 模式不解析单元格，快）。 */
export async function listXlsxSheets(bytes: Uint8Array): Promise<string[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', bookSheets: true });
  return wb.SheetNames ?? [];
}

export interface XlsxParsed extends ParsedTable {
  sheetName: string;
  sheetCount: number;
}

export interface XlsxParseOptions {
  /** 工作表名；'__first' / 缺省 / 找不到 = 第一个。 */
  sheet?: string;
  header: boolean;
  isCancelled?: CancelProbe;
}

/**
 * XLSX → Table。cellDates:false —— 日期单元格保持 Excel 序列号数字（猜日期是
 * 静默错，见文件头）；公式只拿缓存计算结果（sheet_to_json 给的就是缓存值），
 * 公式文本不保留 —— 两条都进 notices。
 */
export async function parseXlsx(bytes: Uint8Array, opts: XlsxParseOptions): Promise<XlsxParsed> {
  const XLSX = await import('xlsx');
  let wb;
  try {
    wb = XLSX.read(bytes, { type: 'array', cellDates: false });
  } catch (e) {
    return fail('corrupt', '无法读取 Excel 工作簿，文件可能损坏', errDetail(e));
  }
  const names: string[] = wb.SheetNames ?? [];
  if (names.length === 0) return fail('corrupt', '工作簿里没有任何工作表');
  const sheetName =
    opts.sheet && opts.sheet !== '__first' && names.includes(opts.sheet) ? opts.sheet : names[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return fail('corrupt', `找不到工作表「${sheetName}」`);

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  // 丢尾部全空行（范围里带的空白尾巴）
  while (aoa.length > 0 && (aoa[aoa.length - 1] ?? []).every((v) => v === null || v === undefined)) {
    aoa.pop();
  }

  const notices: string[] = [];
  if (names.length > 1) {
    notices.push(`工作簿共 ${names.length} 个工作表，仅转换「${sheetName}」，其余 ${names.length - 1} 个未转换`);
  }
  let hasFormula = false;
  let hasDate = false;
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const cell = ws[addr];
    if (!cell) continue;
    if (cell.f !== undefined) hasFormula = true;
    // 判「日期」只能靠数字格式串里的 y/m/d/h 记号（启发式，仅用于提示，不改数据）。
    if (!hasDate && cell.t === 'n' && typeof cell.z === 'string' && /[ymdh]/i.test(cell.z)) hasDate = true;
    if (hasFormula && hasDate) break;
  }
  if (hasFormula) {
    notices.push('公式按工作簿缓存的计算结果导出，公式文本本身不保留；若源文件未重算，数值可能不是最新的');
  }
  if (hasDate) notices.push('日期 / 时间单元格以 Excel 序列号数字导出，未转换为日期文本');
  if (Array.isArray(ws['!merges']) && ws['!merges'].length > 0) {
    notices.push('合并单元格已展开为普通单元格：仅左上角保留原值，其余位置为空值');
  }

  const parsed = arraysToTable(aoa, { header: opts.header, isCancelled: opts.isCancelled });
  return { ...parsed, notices: [...notices, ...parsed.notices], sheetName, sheetCount: names.length };
}

/** 已带类型的二维数组（xlsx 读出的 aoa）→ Table；不再做类型识别。 */
export function arraysToTable(
  aoa: unknown[][],
  opts: { header: boolean; isCancelled?: CancelProbe }
): ParsedTable {
  const notices: string[] = [];
  if (aoa.length === 0) return { table: { columns: [], rows: [] }, notices };
  let width = 0;
  for (const r of aoa) if (r && r.length > width) width = r.length;
  if (width > MAX_TABLE_COLUMNS) fail('oversize', `共 ${width} 列，超过 ${MAX_TABLE_COLUMNS} 列上限`);

  let headerRow: string[] | null = null;
  let data = aoa;
  if (opts.header) {
    headerRow = (aoa[0] ?? []).map((v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number' || typeof v === 'string') return String(v);
      return '';
    });
    data = aoa.slice(1);
  }
  const { columns, renamed } = normalizeColumns(headerRow, width);
  notices.push(...renamed);

  let ragged = false;
  const state: NormalizeState = { nested: false, dates: false };
  const rows: Cell[][] = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 4096 === 0) checkCancelled(opts.isCancelled);
    const r = data[i] ?? [];
    if (r.length !== width) ragged = true;
    const out: Cell[] = new Array(width);
    for (let j = 0; j < width; j++) {
      out[j] = normalizeValue(j < r.length ? r[j] : null, false, state);
    }
    rows.push(out);
    if (rows.length > LIMITS.table.maxRows) {
      fail('oversize', `共 ${aoa.length} 行，超过 ${LIMITS.table.maxRows} 行上限`);
    }
  }
  if (ragged) notices.push('各行宽度不一致：较短的行已补空值');
  if (state.nested) notices.push('含特殊内容的单元格已展开为 JSON 文本');
  return { table: { columns, rows }, notices };
}

/** Excel 工作表名约束：≤ 31 字符，禁用 [ ] : * ? / \ 。 */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned || 'Sheet1';
}

/**
 * Table → XLSX 字节。类型原生写入（数字 / 布尔是真单元格类型，null 是空单元格）；
 * 单张工作表，表名沿用输入表名（非 xlsx 输入为 Sheet1）。样式 / 列宽不生成。
 */
export async function tableToXlsx(
  table: Table,
  opts: { header: boolean; sheetName?: string }
): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const aoa: Cell[][] = [];
  if (opts.header) aoa.push([...table.columns]);
  for (const row of table.rows) aoa.push([...row]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(opts.sheetName ?? 'Sheet1'));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}
