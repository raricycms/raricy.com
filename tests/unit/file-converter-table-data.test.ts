// ─────────────────────────────────────────────────────────────────────────────
// file-converter-table-data.test.ts —— 表格 / 数据能力区的单元测试。
//
// 【这组用例钉的是什么】（全是「猜错一次就是静默改数据」的高发区）
//   · CSV / TSV 的 RFC4180：内嵌逗号 / 换行 / 双引号往返一致；未闭合引号必须
//     报 corrupt，而不是产出一行似是而非的垃圾。
//   · 类型推断边界：前导零编号、>15 位有效数字、日期一律保持文本 ——
//     猜错一次就是用户数据的静默改变（roadmap §8.2 / §8.3）。
//   · 各格式 → Table → 各格式 的往返一致（空值 / 布尔 / 数字要对齐）。
//   · XLSX 在 node 里真读真写：公式只取缓存值（notice 必写）、日期按序列号导出、
//     多工作表只转选中那张。
//   · 类别契约：边 id / 参数键 / 动态选项 / estimateOutput / probe 与登记册一致。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  assertTableSize,
  arraysToTable,
  cellToText,
  decodeUtf8,
  guessCell,
  listXlsxSheets,
  MAX_TABLE_COLUMNS,
  normalizeColumns,
  parseDelimitedText,
  parseJsonText,
  parseNdjsonText,
  parseXlsx,
  parseXmlText,
  parseYamlText,
  recordsToTable,
  rowsToTable,
  sanitizeSheetName,
  serializeDelimited,
  stripBom,
  tableToJsonText,
  tableToNdjsonText,
  tableToRecords,
  tableToXlsx,
  tableToXml,
  tableToYaml,
  type Cell,
  type Table,
} from '@/lib/file-converter/engines/table-data';
import { LIMITS } from '@/lib/file-converter/formats';
import { registryProblems } from '@/lib/file-converter/registry';
import { CATEGORY } from '@/lib/file-converter/categories/table';
import type { InspectInfo, ParamOption } from '@/lib/file-converter/types';

function table(columns: string[], rows: Table['rows']): Table {
  return { columns, rows };
}

/** 捕获同步抛出的 ConvertError 形状（错误是普通对象，不是 Error 子类）。 */
function caught(fn: () => unknown): { kind?: string; message?: string } {
  try {
    fn();
  } catch (e) {
    return e as { kind?: string; message?: string };
  }
  throw new Error('期望抛出错误，但没有');
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<{ kind?: string; message?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { kind?: string; message?: string };
  }
  throw new Error('期望抛出错误，但没有');
}

/** 读 edge 上的 select 参数并按 info 展开选项。 */
function readonlyOptions(spec: { options?: unknown }, info: InspectInfo | null): ParamOption[] {
  const o = spec.options;
  if (typeof o === 'function') return (o as (i: InspectInfo | null) => ParamOption[])(info);
  return (o as ParamOption[]) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────

describe('guessCell —— 类型推断边界', () => {
  it('普通数字与布尔会被识别', () => {
    expect(guessCell('42')).toBe(42);
    expect(guessCell('-3.5')).toBe(-3.5);
    expect(guessCell('1e3')).toBe(1000);
    expect(guessCell('0')).toBe(0);
    expect(guessCell('true')).toBe(true);
    expect(guessCell('TRUE')).toBe(true);
    expect(guessCell('False')).toBe(false);
    expect(guessCell('')).toBeNull();
  });

  it('前导零编号始终是文本（账号 / 订单号不能被吃前导零）', () => {
    expect(guessCell('00123')).toBe('00123');
    expect(guessCell('007')).toBe('007');
    expect(guessCell('0')).toBe(0); // 单个 0 是数
  });

  it('超过 15 位有效数字的长数字保持文本（普通 Number 会丢精度）', () => {
    expect(guessCell('123456789012345')).toBe(123456789012345); // 15 位：可用
    expect(guessCell('1234567890123456')).toBe('1234567890123456'); // 16 位：保持文本
    expect(guessCell('12345678901234567890')).toBe('12345678901234567890');
  });

  it('日期与奇怪写法一律保持文本（猜了就是静默错）', () => {
    expect(guessCell('2024-01-01')).toBe('2024-01-01');
    expect(guessCell('12:30')).toBe('12:30');
    expect(guessCell('1,000')).toBe('1,000');
    expect(guessCell('0x10')).toBe('0x10');
    expect(guessCell('+5')).toBe('+5');
    expect(guessCell('.5')).toBe('.5');
    expect(guessCell('1.')).toBe('1.');
    expect(guessCell(' 1')).toBe(' 1');
  });
});

describe('cellToText / stripBom / decodeUtf8', () => {
  it('cellToText：空值为空串、布尔小写、数字十进制', () => {
    expect(cellToText(null)).toBe('');
    expect(cellToText(true)).toBe('true');
    expect(cellToText(false)).toBe('false');
    expect(cellToText(0)).toBe('0');
    expect(cellToText(1.5)).toBe('1.5');
    expect(cellToText('x')).toBe('x');
  });

  it('stripBom 只去开头 BOM', () => {
    expect(stripBom('﻿abc')).toBe('abc');
    expect(stripBom('a﻿b')).toBe('a﻿b');
  });

  it('decodeUtf8 对非 UTF-8 字节报 corrupt（不带着乱码继续）', () => {
    expect(decodeUtf8(new TextEncoder().encode('中文 ok'))).toBe('中文 ok');
    expect(caught(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00]))).kind).toBe('corrupt');
  });
});

describe('parseDelimitedText —— RFC4180', () => {
  it('基本与 CRLF / LF 混用', () => {
    expect(parseDelimitedText('a,b,c\n1,2,3\n', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseDelimitedText('a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('引号：内嵌逗号 / 内嵌换行 / 双写转义', () => {
    expect(parseDelimitedText('"a,b",c\n', ',')).toEqual([['a,b', 'c']]);
    expect(parseDelimitedText('"l1\nl2",x\n', ',')).toEqual([['l1\nl2', 'x']]);
    expect(parseDelimitedText('"say ""hi""",x\n', ',')).toEqual([['say "hi"', 'x']]);
  });

  it('TSV 只认制表符，逗号是普通字符', () => {
    expect(parseDelimitedText('a,b\tc\n1\t2\n', '\t')).toEqual([
      ['a,b', 'c'],
      ['1', '2'],
    ]);
  });

  it('末尾空行丢弃、中间空行保留、开头 BOM 跳过', () => {
    expect(parseDelimitedText('a,b\n1,2\n\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimitedText('a\n\nb\n', ',')).toEqual([['a'], [''], ['b']]);
    expect(parseDelimitedText('﻿a,b\n', ',')).toEqual([['a', 'b']]);
  });

  it('引号未闭合报 corrupt（不产出似是而非的行）', () => {
    const e = caught(() => parseDelimitedText('"abc\ndef', ','));
    expect(e.kind).toBe('corrupt');
    expect(e.message).toContain('引号');
  });
});

describe('normalizeColumns / rowsToTable', () => {
  it('空列名补「列N」，重复列名加序号', () => {
    expect(normalizeColumns(['a', 'a', ''], 3).columns).toEqual(['a', 'a_2', '列3']);
    expect(normalizeColumns(null, 2).columns).toEqual(['列1', '列2']);
  });

  it('带表头解析 + 类型识别', () => {
    const parsed = rowsToTable(
      [
        ['a', 'b'],
        ['1', '2'],
      ],
      { header: true, guessTypes: true }
    );
    expect(parsed.table).toEqual(table(['a', 'b'], [[1, 2]]));
    expect(parsed.notices).toEqual([]);
  });

  it('不带表头时列为「列N」', () => {
    expect(rowsToTable([['1', '2']], { header: false, guessTypes: true }).table).toEqual(
      table(['列1', '列2'], [[1, 2]])
    );
  });

  it('guessTypes=false 时全部按文本', () => {
    const parsed = rowsToTable([['a'], ['00123']], { header: true, guessTypes: false });
    expect(parsed.table.rows).toEqual([['00123']]);
  });

  it('长短行补齐并给 notice', () => {
    const parsed = rowsToTable([['a', 'b'], ['1'], ['2', '3', '4']], { header: true, guessTypes: true });
    expect(parsed.table.columns).toEqual(['a', 'b', '列3']);
    expect(parsed.table.rows).toEqual([
      [1, null, null],
      [2, 3, 4],
    ]);
    expect(parsed.notices.some((n) => n.includes('不一致'))).toBe(true);
  });

  it('空输入给空表，不抛', () => {
    expect(rowsToTable([], { header: true, guessTypes: true }).table).toEqual({ columns: [], rows: [] });
  });

  it('列数超过上限立刻拒绝', () => {
    const wide = [new Array(MAX_TABLE_COLUMNS + 1).fill('x')];
    expect(caught(() => rowsToTable(wide, { header: true, guessTypes: false })).kind).toBe('oversize');
  });
});

describe('serializeDelimited', () => {
  it('表头行 + 数据行，CRLF 结尾', () => {
    expect(serializeDelimited(table(['a', 'b'], [[1, 'x']]), ',', { header: true })).toBe('a,b\r\n1,x\r\n');
    expect(serializeDelimited(table(['a', 'b'], [[1, 'x']]), ',', { header: false })).toBe('1,x\r\n');
  });

  it('含分隔符 / 引号 / 换行的字段加引号，引号双写', () => {
    const t = table(['c'], [['a,b'], ['say "hi"'], ['l1\nl2']]);
    expect(serializeDelimited(t, ',', { header: false })).toBe(
      '"a,b"\r\n"say ""hi"""\r\n"l1\nl2"\r\n'
    );
  });

  it('空表（无列、无表头）输出空串', () => {
    expect(serializeDelimited(table([], []), ',', { header: false })).toBe('');
  });

  it('往返一致（内嵌逗号 / 引号 / 换行 / 空值 / 数字 / 布尔）', () => {
    const t = table(
      ['a', 'b', 'c'],
      [
        ['a,b', 'say "hi"', 'l1\nl2'],
        [null, 42, true],
      ]
    );
    const csv = serializeDelimited(t, ',', { header: true });
    const back = rowsToTable(parseDelimitedText(csv, ','), { header: true, guessTypes: true });
    expect(back.table).toEqual(t);
  });
});

describe('JSON', () => {
  it('对象数组 → 表（键并集为列，缺失为 null）', () => {
    const parsed = parseJsonText('[{"a":1,"b":"x"},{"a":2}]');
    expect(parsed.table).toEqual(
      table(['a', 'b'], [
        [1, 'x'],
        [2, null],
      ])
    );
  });

  it('对象包一层数组（{data:[...]}）识别并给 notice', () => {
    const parsed = parseJsonText('{"data":[{"a":1}]}');
    expect(parsed.table).toEqual(table(['a'], [[1]]));
    expect(parsed.notices[0]).toContain('顶层是对象');
  });

  it('嵌套对象 / 数组的单元格展开为 JSON 文本并给 notice', () => {
    const parsed = parseJsonText('[{"a":{"x":1}}]');
    expect(parsed.table.rows).toEqual([['{"x":1}']]);
    expect(parsed.notices.some((n) => n.includes('嵌套'))).toBe(true);
  });

  it('没有表格含义的形态报 unsupported', () => {
    expect(caught(() => parseJsonText('[1,2,3]')).kind).toBe('unsupported');
    expect(caught(() => parseJsonText('{"a":1}')).kind).toBe('unsupported');
    expect(caught(() => parseJsonText('{"a":[{"x":1}],"b":[{"y":2}]}')).kind).toBe('unsupported');
  });

  it('非法 JSON 报 corrupt', () => {
    expect(caught(() => parseJsonText('{oops')).kind).toBe('corrupt');
  });

  it('tableToJsonText 往返一致，空值是 null', () => {
    const t = table(['a', 'b'], [
      [1, 'x'],
      [null, true],
    ]);
    expect(JSON.parse(tableToJsonText(t))).toEqual([
      { a: 1, b: 'x' },
      { a: null, b: true },
    ]);
    expect(parseJsonText(tableToJsonText(t)).table).toEqual(t);
  });
});

describe('NDJSON', () => {
  it('逐行解析，空行跳过', () => {
    const parsed = parseNdjsonText('{"a":1}\n{"a":2}\n\n');
    expect(parsed.table).toEqual(table(['a'], [[1], [2]]));
  });

  it('坏行报 corrupt 并报行号', () => {
    const e = caught(() => parseNdjsonText('{"a":1}\nnope'));
    expect(e.kind).toBe('corrupt');
    expect(e.message).toContain('第 2 行');
  });

  it('非对象行报 unsupported', () => {
    expect(caught(() => parseNdjsonText('5\n')).kind).toBe('unsupported');
  });

  it('tableToNdjsonText 一行一条、末尾换行；往返一致', () => {
    const t = table(['a', 'b'], [
      [1, 'x'],
      [2, null],
    ]);
    expect(tableToNdjsonText(t)).toBe('{"a":1,"b":"x"}\n{"a":2,"b":null}\n');
    expect(parseNdjsonText(tableToNdjsonText(t)).table).toEqual(t);
    expect(tableToNdjsonText(table(['a'], []))).toBe('');
  });
});

describe('YAML', () => {
  it('记录数组 → 表；null 保留', async () => {
    const parsed = await parseYamlText('- a: 1\n  b: x\n- a: 2\n  b: y\n');
    expect(parsed.table).toEqual(
      table(['a', 'b'], [
        [1, 'x'],
        [2, 'y'],
      ])
    );
    expect((await parseYamlText('- a: null\n')).table.rows).toEqual([[null]]);
  });

  it('非数组形态报 unsupported', async () => {
    expect((await caughtAsync(() => parseYamlText('a: 1\n'))).kind).toBe('unsupported');
  });

  it('tableToYaml 往返一致', async () => {
    const t = table(['a', 'b'], [
      [1, 'x'],
      [null, true],
    ]);
    expect((await parseYamlText(await tableToYaml(t))).table).toEqual(t);
  });
});

describe('XML（约定式映射）', () => {
  it('我们自己的约定往返一致（含转义）', async () => {
    const t = table(['a', 'b'], [
      ['x&y', '<z>'],
      ['q"r', 1],
    ]);
    const back = await parseXmlText(tableToXml(t), { guessTypes: true });
    expect(back.table).toEqual(t);
  });

  it('列名里的引号经属性转义后能读回', async () => {
    const t = table(['a"b'], [[1]]);
    const back = await parseXmlText(tableToXml(t), { guessTypes: true });
    expect(back.table.columns).toEqual(['a"b']);
  });

  it('外来 XML：把重复子元素当行', async () => {
    const back = await parseXmlText(
      '<people><person><name>A</name><age>1</age></person><person><name>B</name><age>2</age></person></people>',
      { guessTypes: true }
    );
    expect(back.table).toEqual(
      table(['name', 'age'], [
        ['A', 1],
        ['B', 2],
      ])
    );
  });

  it('单元格上除 name 外的属性被丢弃并给 notice', async () => {
    const back = await parseXmlText('<rows><row><col name="a" unit="kg">1</col></row></rows>', {
      guessTypes: false,
    });
    expect(back.table).toEqual(table(['a'], [['1']]));
    expect(back.notices.some((n) => n.includes('属性'))).toBe(true);
  });

  it('XML 语法错误报 corrupt', async () => {
    const e = await caughtAsync(() => parseXmlText('<rows><row>', { guessTypes: true }));
    expect(e.kind).toBe('corrupt');
  });
});

describe('recordsToTable / tableToRecords / arraysToTable', () => {
  it('列名空 / 重名走同一条规范化', () => {
    const parsed = recordsToTable([{ '': 1, x: 2 }, { x: 3 }]);
    expect(parsed.table.columns).toEqual(['列1', 'x']);
  });

  it('tableToRecords 与 columns 对齐', () => {
    expect(tableToRecords(table(['a', 'b'], [[1, 2]]))).toEqual([{ a: 1, b: 2 }]);
  });

  it('arraysToTable 保留已带类型（不再识别）', () => {
    const parsed = arraysToTable([['a', 'b'], [1, null]], { header: true });
    expect(parsed.table).toEqual(table(['a', 'b'], [[1, null]]));
  });
});

describe('assertTableSize / 限额常量', () => {
  it('行 / 列超上限报 oversize', () => {
    const tooManyRows = { columns: ['a'], rows: { length: LIMITS.table.maxRows + 1 } } as unknown as Table;
    expect(caught(() => assertTableSize(tooManyRows)).kind).toBe('oversize');
    const tooManyCols = { columns: new Array(MAX_TABLE_COLUMNS + 1).fill('c'), rows: [] } as unknown as Table;
    expect(caught(() => assertTableSize(tooManyCols)).kind).toBe('oversize');
    expect(() => assertTableSize(table(['a'], [[1]]))).not.toThrow();
  });
});

describe('XLSX（node 真读真写）', () => {
  it('往返一致：文本 / 数字 / 布尔 / 空值 / 表名', async () => {
    const t = table(
      ['name', 'qty', 'ok'],
      [
        ['苹果', 3, true],
        [null, 4.5, false],
      ]
    );
    const bytes = await tableToXlsx(t, { header: true, sheetName: '数据' });
    expect(bytes).toBeInstanceOf(Uint8Array);
    const parsed = await parseXlsx(bytes, { header: true });
    expect(parsed.table.columns).toEqual(['name', 'qty', 'ok']);
    expect(parsed.table.rows).toEqual([
      ['苹果', 3, true],
      [null, 4.5, false],
    ]);
    expect(parsed.sheetName).toBe('数据');
    expect(parsed.sheetCount).toBe(1);
  });

  it('多工作表：listXlsxSheets 列出，只转选中那张并给 notice', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a'], [1]]), 'SheetOne');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['b'], [2]]), 'SheetTwo');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    expect(await listXlsxSheets(bytes)).toEqual(['SheetOne', 'SheetTwo']);

    const parsed = await parseXlsx(bytes, { header: true, sheet: 'SheetTwo' });
    expect(parsed.sheetName).toBe('SheetTwo');
    expect(parsed.table).toEqual(table(['b'], [[2]]));
    expect(parsed.notices.some((n) => n.includes('仅转换'))).toBe(true);
  });

  it('找不到的工作表名退回第一张（不抛）', async () => {
    const bytes = await tableToXlsx(table(['a'], [[1]]), { header: true, sheetName: 'S1' });
    const parsed = await parseXlsx(bytes, { header: true, sheet: '不存在' });
    expect(parsed.sheetName).toBe('S1');
  });

  it('公式只取缓存值并给 notice（公式文本不保留）', async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([[1, 2, 3]]);
    ws['C1'] = { t: 'n', v: 3, f: 'A1+B1' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    const parsed = await parseXlsx(bytes, { header: false });
    expect(parsed.table).toEqual(table(['列1', '列2', '列3'], [[1, 2, 3]]));
    expect(parsed.notices.some((n) => n.includes('公式'))).toBe(true);
  });

  it('损坏的 xlsx 字节报 corrupt', async () => {
    // 截断的 ZIP 头（PK\x03\x04 后无有效结构）：xlsx 会抛「Unsupported ZIP file」，
    // 被 parseXlsx 归为 corrupt。注意随机短字节会被 xlsx 宽容地当成空工作簿，
    // 不能用来测这条路径。
    const truncatedZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0]);
    const e = await caughtAsync(() => parseXlsx(truncatedZip, { header: true }));
    expect(e.kind).toBe('corrupt');
  });

  it('sanitizeSheetName：去非法字符、截 31 字符、空名兜底', () => {
    expect(sanitizeSheetName('a/b:c*d?e[f]g\\h')).toBe('a b c d e f g h');
    expect(sanitizeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(sanitizeSheetName('   ')).toBe('Sheet1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('类别契约（categories/table.ts）', () => {
  it('登记册校验无问题', () => {
    expect(registryProblems([CATEGORY])).toEqual([]);
  });

  it('类别元信息与单文件任务', () => {
    expect(CATEGORY.key).toBe('table');
    expect(CATEGORY.maxFilesPerTask).toBe(1);
    for (const ext of ['.xlsx', '.csv', '.tsv', '.json', '.ndjson', '.yaml', '.xml']) {
      expect(CATEGORY.accept).toContain(ext);
    }
  });

  it('七条边 id 严格、from 覆盖七种输入、method=map、status=live', () => {
    const expected = [
      'table:to-csv',
      'table:to-tsv',
      'table:to-xlsx',
      'table:to-json',
      'table:to-ndjson',
      'table:to-yaml',
      'table:to-xml',
    ];
    expect(CATEGORY.edges.map((e) => e.id)).toEqual(expected);
    const kinds = ['csv', 'tsv', 'xlsx', 'json', 'ndjson', 'yaml', 'xml'];
    for (const e of CATEGORY.edges) {
      expect(e.method).toBe('map');
      expect(e.status).toBe('live');
      expect(typeof e.run).toBe('function');
      expect(e.from.sort()).toEqual([...kinds].sort());
      expect(e.id.endsWith(`-${e.to}`)).toBe(true);
    }
  });

  it('每条边都带 sheet / header / guessTypes 三个参数，形状与默认值正确', () => {
    for (const e of CATEGORY.edges) {
      expect(e.params.map((p) => p.key)).toEqual(['sheet', 'header', 'guessTypes']);
      const sheet = e.params.find((p) => p.key === 'sheet')!;
      const header = e.params.find((p) => p.key === 'header')!;
      const guess = e.params.find((p) => p.key === 'guessTypes')!;
      expect(sheet.type).toBe('select');
      expect(sheet.defaultValue).toBe('__first');
      expect(header.type).toBe('checkbox');
      expect(header.defaultValue).toBe(true);
      expect(guess.type).toBe('checkbox');
      expect(guess.defaultValue).toBe(true);
      expect(guess.advanced).toBe(true);
    }
  });

  it('sheet 动态选项：无 info 时兜底「第一个工作表」，有 info 时列出工作表', () => {
    const sheet = CATEGORY.edges[0].params.find((p) => p.key === 'sheet')!;
    expect(readonlyOptions(sheet, null)).toEqual([{ value: '__first', label: '第一个工作表' }]);
    const info = { sheets: ['A', 'B'] } as InspectInfo;
    expect(readonlyOptions(sheet, info)).toEqual([
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B' },
    ]);
  });

  it('estimateOutput：文本族按体积粗估，xlsx 返回 null', () => {
    const csvEdge = CATEGORY.edges.find((e) => e.id === 'table:to-csv')!;
    const xlsxEdge = CATEGORY.edges.find((e) => e.id === 'table:to-xlsx')!;
    const info = { size: 1000 } as InspectInfo;
    expect(csvEdge.estimateOutput!(info, {})).toBe(1200);
    expect(xlsxEdge.estimateOutput!(info, {})).toBeNull();
  });

  it('probe：非 xlsx 返回 {}；xlsx 读出工作表名单；超限跳过', async () => {
    const csvInfo = { sniff: { kind: 'csv' }, name: 'a.csv', size: 0 } as unknown as InspectInfo;
    const stubFile = (bytes: Uint8Array) =>
      ({
        size: bytes.length,
        name: 'a.xlsx',
        arrayBuffer: async () => bytes.buffer,
      }) as unknown as File;

    expect(await CATEGORY.probe!(stubFile(new Uint8Array()), csvInfo)).toEqual({});

    const bytes = await tableToXlsx(table(['a'], [[1]]), { header: true, sheetName: 'S1' });
    const xlsxInfo = { sniff: { kind: 'xlsx' }, name: 'a.xlsx', size: bytes.length } as unknown as InspectInfo;
    expect(await CATEGORY.probe!(stubFile(bytes), xlsxInfo)).toEqual({ sheets: ['S1'] });

    const bigInfo = {
      sniff: { kind: 'xlsx' },
      name: 'a.xlsx',
      size: LIMITS.table.maxBytes + 1,
    } as unknown as InspectInfo;
    const bigStub = { size: LIMITS.table.maxBytes + 1, name: 'a.xlsx', arrayBuffer: async () => bytes.buffer } as unknown as File;
    expect(await CATEGORY.probe!(bigStub, bigInfo)).toEqual({});
  });
});

// 类型守卫：Cell 的联合类型在测试里被正确使用（避免误删导出）。
const _cellCheck: Cell = null;
void _cellCheck;
