// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/table.ts —— 表格 / 数据能力区（roadmap §8）。
//
// 【范围】XLSX / CSV / TSV / JSON / NDJSON / YAML / XML 互转，全部经过公共
//   中间表示 Table（../engines/table-data.ts，零 DOM、可 node 单测）。
//   本文件只做：限额硬闸 → 参数解析 → 解析 → 序列化 → 阶段推进与错误形状。
//
// 【纪律】
//   · LIMITS.table 是硬上限：字节先判，行 / 列在解析过程中即判（超限立刻停）。
//   · 源与目标同格式**允许**转换（重排引号 / 类型规范化也是用途）—— hint 里写明。
//   · notices 如实列出每一项损失 / 保留（公式只求值、日期不猜、多工作表只转一张、
//     XML 约定式映射……），roadmap §15 的硬要求。
//   · 无任何网络请求；引擎资产不走 /static/converter/（本区全是本地 JS / WASM-free 库）。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, formatBytes } from '../formats';
import type {
  CategoryDef,
  ConvertError,
  ConvertResultData,
  EdgeDef,
  FileKind,
  InspectInfo,
  ParamSpec,
  RunContext,
} from '../types';
import { convertedName } from '../utils';
import {
  assertTableSize,
  decodeUtf8,
  listXlsxSheets,
  parseDelimitedText,
  parseJsonText,
  parseNdjsonText,
  parseXlsx,
  parseXmlText,
  parseYamlText,
  rowsToTable,
  serializeDelimited,
  tableToJsonText,
  tableToNdjsonText,
  tableToXlsx,
  tableToXml,
  tableToYaml,
  type ParsedTable,
  type Table,
} from '../engines/table-data';

// ─── 词汇 ────────────────────────────────────────────────────────────────────

type TableKind = Extract<FileKind, 'csv' | 'tsv' | 'xlsx' | 'json' | 'ndjson' | 'yaml' | 'xml'>;
type TableTarget = 'csv' | 'tsv' | 'xlsx' | 'json' | 'ndjson' | 'yaml' | 'xml';

const TABLE_KINDS: readonly TableKind[] = ['csv', 'tsv', 'xlsx', 'json', 'ndjson', 'yaml', 'xml'];

/** 单元格全部以文本进入的输入族（guessTypes 只对它们生效）。 */
const TEXT_FAMILY: ReadonlySet<TableKind> = new Set(['csv', 'tsv', 'xml']);

/** 目标侧的固定说明（edge.notices 与结果 notices 共用同一份）。 */
const TARGET_NOTICES: Record<TableTarget, string[]> = {
  csv: [
    '纯文本二维表：样式、格式与多余工作表不保留',
    '以 = 开头的文本单元格在 Excel 等软件中打开时会被当作公式（本工具未改动数据本身）',
  ],
  tsv: ['纯文本二维表（制表符分隔）：样式、格式与多余工作表不保留'],
  xlsx: ['仅写入一张工作表；原有样式、列宽与多余工作表不保留'],
  json: ['每行转成一个 JSON 对象，键为列名；空单元格输出为 null'],
  ndjson: ['每行输出一个 JSON 对象（行式 JSON）；空单元格输出为 null'],
  yaml: ['每行转成一个 YAML 记录；空单元格输出为 null'],
  xml: ['XML 使用约定结构 <rows><row><col name="列名">，属约定式映射，不保证与其它 XML 工具无损往返'],
};

// ─── 参数 ────────────────────────────────────────────────────────────────────

const SHEET_PARAM: ParamSpec = {
  key: 'sheet',
  label: '工作表（仅 Excel 输入）',
  type: 'select',
  options: (info: InspectInfo | null) => {
    const sheets = info?.sheets;
    return sheets && sheets.length > 0
      ? sheets.map((s) => ({ value: s, label: s }))
      : [{ value: '__first', label: '第一个工作表' }];
  },
  defaultValue: '__first',
  help: '仅当输入是 Excel 工作簿时生效；其余工作表不转换',
};

const HEADER_PARAM: ParamSpec = {
  key: 'header',
  label: '首行是表头',
  type: 'checkbox',
  defaultValue: true,
  help: '勾选：输入的第一行作为列名、输出写出表头行；对 JSON / NDJSON / YAML 输入仅影响输出是否带表头',
};

const GUESS_TYPES_PARAM: ParamSpec = {
  key: 'guessTypes',
  label: '自动识别数字与布尔',
  type: 'checkbox',
  defaultValue: true,
  advanced: true,
  help: '仅对 CSV / TSV / XML 纯文本输入生效；前导零编号、超长数字与日期始终保持文本',
};

const TABLE_PARAMS: ParamSpec[] = [SHEET_PARAM, HEADER_PARAM, GUESS_TYPES_PARAM];

// ─── runner ──────────────────────────────────────────────────────────────────

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

function boolParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}

function strParam(params: Record<string, unknown>, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && v !== '' ? v : fallback;
}

async function parseInput(
  ctx: RunContext,
  kind: TableKind,
  bytes: Uint8Array,
  opts: { header: boolean; guessTypes: boolean; sheet: string }
): Promise<{ parsed: ParsedTable; sheetName?: string }> {
  const isCancelled = () => ctx.signal.aborted;
  switch (kind) {
    case 'csv':
      return {
        parsed: rowsToTable(parseDelimitedText(decodeUtf8(bytes), ','), {
          header: opts.header,
          guessTypes: opts.guessTypes,
          isCancelled,
        }),
      };
    case 'tsv':
      return {
        parsed: rowsToTable(parseDelimitedText(decodeUtf8(bytes), '\t'), {
          header: opts.header,
          guessTypes: opts.guessTypes,
          isCancelled,
        }),
      };
    case 'json':
      return { parsed: parseJsonText(decodeUtf8(bytes)) };
    case 'ndjson':
      return { parsed: parseNdjsonText(decodeUtf8(bytes)) };
    case 'yaml':
      return { parsed: await parseYamlText(decodeUtf8(bytes)) };
    case 'xml':
      return { parsed: await parseXmlText(decodeUtf8(bytes), { guessTypes: opts.guessTypes, isCancelled }) };
    case 'xlsx': {
      const r = await parseXlsx(bytes, { sheet: opts.sheet, header: opts.header, isCancelled });
      return { parsed: r, sheetName: r.sheetName };
    }
  }
}

async function serializeOutput(
  target: TableTarget,
  table: Table,
  opts: { header: boolean; sheetName?: string }
): Promise<{ data: string | Uint8Array }> {
  switch (target) {
    case 'csv':
      return { data: serializeDelimited(table, ',', { header: opts.header }) };
    case 'tsv':
      return { data: serializeDelimited(table, '\t', { header: opts.header }) };
    case 'json':
      return { data: tableToJsonText(table) };
    case 'ndjson':
      return { data: tableToNdjsonText(table) };
    case 'yaml':
      return { data: await tableToYaml(table) };
    case 'xml':
      return { data: tableToXml(table) };
    case 'xlsx':
      return { data: await tableToXlsx(table, { header: opts.header, sheetName: opts.sheetName }) };
  }
}

async function runTableJob(ctx: RunContext, target: TableTarget): Promise<ConvertResultData> {
  const file = ctx.file;
  if (file.size > LIMITS.table.maxBytes) {
    throw {
      kind: 'oversize',
      message: `文件 ${formatBytes(file.size)} 超过 ${formatBytes(LIMITS.table.maxBytes)} 上限`,
    } satisfies ConvertError;
  }
  const kind = ctx.inspect?.sniff.kind as TableKind | undefined;
  if (!kind || !TABLE_KINDS.includes(kind)) {
    throw {
      kind: 'unsupported',
      message: '无法识别的表格文件（支持 XLSX / CSV / TSV / JSON / NDJSON / YAML / XML）',
    } satisfies ConvertError;
  }

  throwIfAborted(ctx.signal);
  // 本区引擎是按需动态 import 的本地 JS 库（xlsx 最大），加载阶段几乎瞬时。
  ctx.onPhase('loading-engine');
  const header = boolParam(ctx.params, 'header', true);
  const guessTypes = boolParam(ctx.params, 'guessTypes', true);
  const sheet = strParam(ctx.params, 'sheet', '__first');
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(ctx.signal);

  ctx.onPhase('probing');
  const { parsed, sheetName } = await parseInput(ctx, kind, bytes, { header, guessTypes, sheet });
  throwIfAborted(ctx.signal);
  assertTableSize(parsed.table);
  if (parsed.table.columns.length === 0) {
    throw { kind: 'corrupt', message: '文件里没有任何表格数据' } satisfies ConvertError;
  }

  ctx.onPhase('converting');
  const { data } = await serializeOutput(target, parsed.table, { header, sheetName });
  throwIfAborted(ctx.signal);

  const fmt = FORMATS[target];
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: `${fmt.mime};charset=utf-8` })
      : new Blob([data as BlobPart], { type: fmt.mime });
  const name = convertedName(file.name, fmt.ext, new Set());

  const notices: string[] = [...parsed.notices];
  if (TEXT_FAMILY.has(kind)) {
    notices.unshift(
      guessTypes
        ? '数字与布尔已按内容自动识别；前导零编号、超长数字与日期一律保持文本'
        : '已按参数关闭类型识别：所有单元格按原文本处理'
    );
  }
  if (kind === 'xlsx' && !guessTypes) {
    notices.push('「自动识别数字与布尔」仅对文本输入生效：Excel 单元格已按工作簿原值导出');
  }
  notices.push(...TARGET_NOTICES[target]);

  return {
    outputs: [{ blob, name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: file.size,
    outputSize: blob.size,
    notices,
    previewKind: target === 'xlsx' ? 'none' : 'text',
  };
}

// ─── 边定义 ──────────────────────────────────────────────────────────────────

function tableEdge(p: {
  id: string;
  target: TableTarget;
  label: string;
  group: string;
}): EdgeDef {
  return {
    id: p.id,
    label: p.label,
    from: [...TABLE_KINDS],
    to: p.target,
    method: 'map',
    notices: TARGET_NOTICES[p.target],
    params: TABLE_PARAMS,
    // 文本族目标按输入体积粗估（结构膨胀有限）；xlsx 是二进制容器，估不出。
    estimateOutput:
      p.target === 'xlsx' ? () => null : (info) => Math.round(info.size * 1.2),
    run: (ctx) => runTableJob(ctx, p.target),
    status: 'live',
    group: p.group,
  };
}

export const CATEGORY: CategoryDef = {
  key: 'table',
  label: '表格 / 数据',
  hint:
    'XLSX / CSV / TSV / JSON / NDJSON / YAML / XML 互转（≤ 20 MiB、≤ 20 万行、≤ 2000 列）。' +
    '源与目标相同也允许转换（可用于统一引号与类型规范化）。公式只导出缓存计算结果，' +
    '日期一律不自动识别，多工作表只转选中的一张 —— 结果页会如实列出。文件只在本机处理。',
  accept: '.xlsx,.csv,.tsv,.json,.jsonl,.ndjson,.yaml,.yml,.xml',
  maxFilesPerTask: 1,
  edges: [
    tableEdge({ id: 'table:to-csv', target: 'csv', label: 'CSV（便于表格软件打开）', group: '电子表格' }),
    tableEdge({ id: 'table:to-tsv', target: 'tsv', label: 'TSV（制表符分隔，便于粘贴）', group: '电子表格' }),
    tableEdge({ id: 'table:to-xlsx', target: 'xlsx', label: 'XLSX（Excel 工作簿）', group: '电子表格' }),
    tableEdge({ id: 'table:to-json', target: 'json', label: 'JSON（给程序处理）', group: '程序数据' }),
    tableEdge({ id: 'table:to-ndjson', target: 'ndjson', label: 'NDJSON（每行一条记录，适合流式处理）', group: '程序数据' }),
    tableEdge({ id: 'table:to-yaml', target: 'yaml', label: 'YAML（可读的配置式文本）', group: '结构化文本' }),
    tableEdge({ id: 'table:to-xml', target: 'xml', label: 'XML（约定结构 rows/row/col）', group: '结构化文本' }),
  ],
  // probe：xlsx 输入读工作表名单（bookSheets 模式，不解析单元格）；其它格式无
  // 需要探测的信息。失败降级 {}，菜单照常（sheet 参数退回「第一个工作表」）。
  probe: async (file, info) => {
    try {
      if (info.sniff.kind !== 'xlsx') return {};
      if (file.size > LIMITS.table.maxBytes) return {};
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sheets = await listXlsxSheets(bytes);
      return sheets.length > 0 ? { sheets } : {};
    } catch {
      return {};
    }
  },
};
