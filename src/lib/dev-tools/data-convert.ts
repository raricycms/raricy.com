// ─────────────────────────────────────────────────────────────────────────────
// dev-tools/data-convert.ts —— JSON / YAML / CSV 互转的纯逻辑（零 React、node 可直接 import）
//
// 【YAML 为什么用 JSON_SCHEMA 读】
//   js-yaml 默认 schema 会把 `2020-01-01` 解析成 Date 对象、把 `yes` 解析成布尔。
//   本工具的目标格式是 **JSON**，所以用 `yaml.JSON_SCHEMA`（js-yaml 内置）读：
//   只认 JSON 能表达的那几种类型，日期保持原字符串、`yes` 保持字符串。
//   代价是 YAML 特有类型（时间戳、`!!binary` 等）不会自动转换 —— 这属于有损项，
//   页面上的 `DATA_CONVERT_LOSS_NOTES` 里写明了。
//   写 YAML 用 `yaml.dump` 并关掉 refs（`noRefs: true`），避免输出 `&a` / `*a` 这类
//   只在 YAML 内有效的锚点；注释与排版本就存不住（YAML 数据结构里没有它们）。
//
// 【CSV 为什么自己写】
//   没有引依赖：解析只需要「引号内可含逗号/换行、`""` 表示一个引号」这几条，
//   生成只需要「必要处加引号、引号翻倍」。RFC 4180 之外的方言（分隔符、BOM、
//   行尾）都在下面显式处理，行为可测。
//
// 【有损项集中在 DATA_CONVERT_LOSS_NOTES】
//   页面直接把它渲染成「有损项」清单，单测检查它非空 —— 写不出「这次丢了什么」
//   就说明这条转换没写完（本项目格式转换器那条纪律）。
// ─────────────────────────────────────────────────────────────────────────────

import yaml from 'js-yaml';
import { parseJsonText, type JsonParseResult } from './json';

// ── 错误类型 ─────────────────────────────────────────────────────────────────

/** 用户可读的转换错误。页面只展示 `message`，不展示堆栈。 */
export class DataConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataConvertError';
  }
}

// ── 格式与分隔符词汇（页面下拉框与校验读同一份）─────────────────────────────

export type DataFormat = 'json' | 'yaml' | 'csv';

export const DATA_FORMAT_OPTIONS: ReadonlyArray<{ value: DataFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'csv', label: 'CSV' },
];

/** 写入 CSV 时真正使用的分隔符。 */
export type CsvDelimiter = ',' | '\t' | ';';

/** 读取 CSV 时可选「自动识别」。 */
export type CsvDelimiterOption = CsvDelimiter | 'auto';

export const CSV_DELIMITER_OPTIONS: ReadonlyArray<{ value: CsvDelimiterOption; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: ',', label: '逗号 ,' },
  { value: '\t', label: '制表符 Tab' },
  { value: ';', label: '分号 ;' },
];

export const DATA_CONVERT_LOSS_NOTES: readonly string[] = [
  'YAML → 其他：注释、锚点 / 别名（&a / *a）会丢失；多文档（---）与 !!binary 等非 JSON 标签会在解析阶段直接报错（当前口径是拒绝，不是静默丢弃）。YAML 特有类型按 JSON 兼容模式读取（日期保持原字符串，yes/no 保持字符串）。',
  '其他 → YAML：字段顺序按对象顺序输出，原 YAML 的注释与排版不保留。',
  'CSV → 其他：每个单元格都变成字符串，数字、布尔、null 无法自动还原（读回来是 "123" / "true"）。',
  '其他 → CSV：只接受「对象数组」；嵌套的对象 / 数组会被压成一段 JSON 文本，读回来是字符串。',
  'CSV 本身：列数不一致时缺的补空串、多出来的列丢弃；重复或空表头会被自动改成唯一列名。',
];

// ── 分隔符识别 ───────────────────────────────────────────────────────────────

/**
 * 按**第一行引号外**出现的次数猜分隔符。
 *
 * 只认逗号 / 制表符 / 分号：从 Excel 直接粘贴过来的是制表符分隔，从其他工具复制
 * 的常见分号分隔（欧洲习惯）。猜不出时退回逗号（最通用）。
 *
 * 引号规则必须与 `parseCsv` 一致（R3-494）：只有**字段开头**的 `"` 才开引号、
 * 字段内的 `""` 是转义。旧实现「任何 `"` 都翻转状态」会被单元格里一个落单引号
 * 整行带偏（制表符分隔的文本被判成逗号 → 整行变 1 列）。
 */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  let comma = 0;
  let tab = 0;
  let semicolon = 0;
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i += 1; // `""` 转义
        else inQuotes = false;
      }
      continue;
    }
    if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      continue;
    }
    if (c === '\n' || c === '\r') break;
    if (c === ',') comma++;
    else if (c === '\t') tab++;
    else if (c === ';') semicolon++;
    atFieldStart = false;
  }
  if (tab > comma && tab >= semicolon) return '\t';
  if (semicolon > comma && semicolon > tab) return ';';
  return ',';
}

// ── CSV 解析 ─────────────────────────────────────────────────────────────────

export interface CsvParseResult {
  rows: string[][];
  /** 实际使用的分隔符（自动识别时也回报出来，页面可显示）。 */
  delimiter: CsvDelimiter;
}

/**
 * 解析 CSV 文本。
 *
 * 支持的规则（RFC 4180 为主 + 两条宽容处理）：
 *   · 引号内的逗号、换行都算单元格内容；
 *   · `""` 表示一个双引号；
 *   · 引号只在**单元格开头**开启（`a"b` 里的引号按字面处理，宽待手工数据）；
 *   · 行尾 CRLF / CR / LF 都认，BOM 去掉；
 *   · 末尾空行忽略（粘贴时常带）。
 *
 * 引号没闭合会抛 DataConvertError（并给出开始行号），因为这种情况继续猜下去
 * 只会把后面所有内容吞进一个单元格，用户看到的会是「莫名其妙只有一行」。
 */
export function parseCsv(text: string, options: { delimiter?: CsvDelimiterOption } = {}): CsvParseResult {
  const delimiter: CsvDelimiter =
    options.delimiter !== undefined && options.delimiter !== 'auto'
      ? options.delimiter
      : detectCsvDelimiter(text);

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoteStartLine = 1;
  let line = 1;

  const pushRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (inQuotes) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (c === '\r') {
        if (source[i + 1] === '\n') i++;
        field += '\n';
        line++;
      } else if (c === '\n') {
        field += '\n';
        line++;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === '') {
      inQuotes = true;
      quoteStartLine = line;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\r') {
      if (source[i + 1] === '\n') i++;
      pushRow();
      line++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      line++;
      continue;
    }
    field += c;
  }

  if (inQuotes) {
    throw new DataConvertError(`CSV 第 ${quoteStartLine} 行开始的引号没有闭合，检查一下成对的 "`);
  }
  if (field !== '' || row.length > 0) pushRow();

  // 末尾的空行（常见于从表格软件复制）不算数据。
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }

  return { rows, delimiter };
}

// ── CSV 行 ↔ 对象数组 ────────────────────────────────────────────────────────

export interface CsvObjects {
  headers: string[];
  objects: Array<Record<string, string>>;
}

/** 表头去重：空表头补 `columnN`，重名的加 `_2` / `_3`（否则对象键会静默互相覆盖）。 */
function uniqueHeaders(raw: string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  raw.forEach((name, index) => {
    const base = name.trim() || `column${index + 1}`;
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    used.add(candidate);
    out.push(candidate);
  });
  return out;
}

/**
 * 第一行当表头，其余行转成对象数组。
 *
 * 列数不一致时：缺的补空串，多出来的丢弃（这属于有损项，见 DATA_CONVERT_LOSS_NOTES）。
 * 全空的行直接跳过 —— 空行在表格里通常只是排版。
 */
export function csvRowsToObjects(rows: string[][]): CsvObjects {
  if (rows.length === 0) throw new DataConvertError('CSV 内容为空');
  if (rows[0].length === 0) throw new DataConvertError('CSV 第一行没有可用的列名');

  const headers = uniqueHeaders(rows[0]);
  const objects: Array<Record<string, string>> = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((cell) => cell === '')) continue;
    objects.push(
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
    );
  }
  return { headers, objects };
}

export interface CsvToJsonResult {
  json: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  delimiter: CsvDelimiter;
}

/** CSV → JSON 文本（对象数组）。 */
export function csvToJson(text: string, options: { delimiter?: CsvDelimiterOption } = {}): CsvToJsonResult {
  if (text.trim() === '') throw new DataConvertError('CSV 输入为空');
  const { rows, delimiter } = parseCsv(text, options);
  const { headers, objects } = csvRowsToObjects(rows);
  return {
    json: JSON.stringify(objects, null, 2),
    rowCount: objects.length,
    columnCount: headers.length,
    headers,
    delimiter,
  };
}

// ── 对象数组 → CSV ───────────────────────────────────────────────────────────

function describeJsonKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  switch (typeof value) {
    case 'object':
      return '对象';
    case 'string':
      return '字符串';
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔值';
    default:
      return '无法转换的值';
  }
}

function needsCsvQuote(text: string, delimiter: CsvDelimiter): boolean {
  return (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.startsWith(' ') ||
    text.endsWith(' ')
  );
}

/** 单元格 → CSV 文本。嵌套值写成一段 JSON 文本（有损项已在页面上写明）。 */
function formatCsvCell(value: unknown, delimiter: CsvDelimiter): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (typeof value === 'object') {
    const serialized = JSON.stringify(value);
    text = serialized === undefined ? '' : serialized;
  } else text = String(value);

  return needsCsvQuote(text, delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface JsonToCsvResult {
  csv: string;
  columns: string[];
  rowCount: number;
}

/**
 * 对象数组（`Record<string, unknown>[]`）→ CSV。
 *
 * 顶层不是**非空的对象数组**时给明确错误（JSON→CSV 这条边没有「猜」的余地：
 * 一个对象没有列的概念，一个数组的数组没有列名）。
 * 列取所有对象 key 的并集（保持首次出现顺序），缺失的单元格写空串。
 */
export function jsonToCsv(value: unknown, options: { delimiter?: CsvDelimiter } = {}): JsonToCsvResult {
  const delimiter = options.delimiter ?? ',';

  if (!Array.isArray(value)) {
    throw new DataConvertError(
      `JSON→CSV 需要顶层是对象数组，当前顶层是${describeJsonKind(value)}`,
    );
  }
  if (value.length === 0) {
    throw new DataConvertError('JSON→CSV 需要非空的对象数组，当前数组是空的');
  }

  const objects: Array<Record<string, unknown>> = [];
  value.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new DataConvertError(
        `JSON→CSV 需要数组里每一项都是对象，第 ${index + 1} 项是${describeJsonKind(item)}`,
      );
    }
    objects.push(item as Record<string, unknown>);
  });

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const item of objects) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  if (columns.length === 0) throw new DataConvertError('对象里没有任何字段，无法生成 CSV');

  const lines: string[] = [columns.map((column) => formatCsvCell(column, delimiter)).join(delimiter)];
  for (const item of objects) {
    lines.push(columns.map((column) => formatCsvCell(item[column], delimiter)).join(delimiter));
  }
  return { csv: lines.join('\n'), columns, rowCount: objects.length };
}

// ── YAML ────────────────────────────────────────────────────────────────────

function formatYamlError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message ? `YAML 解析失败：\n${message}` : 'YAML 解析失败';
}

function loadYaml(text: string): unknown {
  if (text.trim() === '') throw new DataConvertError('YAML 输入为空');
  try {
    // JSON_SCHEMA：只产出 JSON 能表达的类型（日期保持字符串、yes/no 不当布尔）。
    return yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new DataConvertError(formatYamlError(error));
  }
}

export interface YamlToJsonResult {
  json: string;
  value: unknown;
}

/** YAML → JSON 文本。 */
export function yamlToJson(text: string): YamlToJsonResult {
  const value = loadYaml(text);
  if (value === undefined) throw new DataConvertError('YAML 里没有可转换的内容');
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new DataConvertError('YAML 内容无法表示成 JSON');
  return { json, value };
}

/** JSON 可表达的值 → YAML 文本。 */
export function jsonToYaml(value: unknown): string {
  if (value === undefined) throw new DataConvertError('没有可转换的内容');
  return yaml.dump(value, { indent: 2, lineWidth: -1, noRefs: true });
}

// ── 统一入口 ─────────────────────────────────────────────────────────────────

function formatJsonParseError(result: Extract<JsonParseResult, { ok: false }>): string {
  const where = result.location
    ? `（第 ${result.location.line} 行第 ${result.location.column} 列）`
    : '';
  return `JSON 解析失败：${result.message}${where}`;
}

export interface DataConvertOptions {
  /** CSV 一侧的分隔符；`auto` 只影响读取，写入时退回逗号。 */
  csvDelimiter?: CsvDelimiterOption;
}

export interface DataConvertStats {
  rowCount?: number;
  columnCount?: number;
}

export interface DataConvertResult {
  output: string;
  stats: DataConvertStats;
}

/**
 * JSON / YAML / CSV 互转的统一入口。
 *
 * 失败一律抛 `DataConvertError`（message 是给用户看的中文），页面 catch 后只渲染
 * message —— 不把 `JSON.parse` / js-yaml 的裸异常（带英文堆栈）漏到界面上。
 */
export function convertData(
  input: string,
  from: DataFormat,
  to: DataFormat,
  options: DataConvertOptions = {},
): DataConvertResult {
  if (from === to) throw new DataConvertError('源格式与目标格式相同，请选择不同的格式');
  if (input.trim() === '') throw new DataConvertError('输入为空，先粘贴要转换的内容');

  if (from === 'json') {
    const parsed = parseJsonText(input);
    if (!parsed.ok) throw new DataConvertError(formatJsonParseError(parsed));
    return serializeValue(parsed.value, to, options);
  }

  if (from === 'yaml') {
    const value = loadYaml(input);
    if (value === undefined) throw new DataConvertError('YAML 里没有可转换的内容');
    return serializeValue(value, to, options);
  }

  // from === 'csv'（to 不可能是 csv，前面已挡掉同格式）
  const { rows } = parseCsv(input, { delimiter: options.csvDelimiter });
  const { headers, objects } = csvRowsToObjects(rows);
  const stats: DataConvertStats = { rowCount: objects.length, columnCount: headers.length };

  if (to === 'json') return { output: JSON.stringify(objects, null, 2), stats };
  // to === 'yaml'：分隔符只影响 CSV 的读写，写 YAML 时用不到。
  return { output: jsonToYaml(objects), stats };
}

/** 把已解析成 JSON 值的数据写成目标格式。 */
function serializeValue(value: unknown, to: DataFormat, options: DataConvertOptions): DataConvertResult {
  if (to === 'json') {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) throw new DataConvertError('内容无法表示成 JSON');
    return { output: json, stats: {} };
  }
  if (to === 'yaml') return { output: jsonToYaml(value), stats: {} };

  const delimiter: CsvDelimiter =
    options.csvDelimiter !== undefined && options.csvDelimiter !== 'auto' ? options.csvDelimiter : ',';
  const { csv, rowCount, columns } = jsonToCsv(value, { delimiter });
  return { output: csv, stats: { rowCount, columnCount: columns.length } };
}
