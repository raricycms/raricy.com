// ─────────────────────────────────────────────────────────────────────────────
// dev-tools-data.test.ts —— 开发者工具「数据与格式」家族的纯逻辑单测
//
// 覆盖三块（全部 node 环境，不碰 DOM / prisma）：
//   · src/lib/dev-tools/json.ts         格式化 / 压缩 / 校验 / 错误定位 / 大小上限 / 节点数
//   · src/lib/dev-tools/data-convert.ts JSON / YAML / CSV 互转与有损项
//   · src/lib/dev-tools/diff.ts         行切分 / LCS / 统计 / unified diff / 行数上限
//
// 这些模块是页面里真正算数的部分：页面只负责把结果摆出来。所以这里断言到「具体
// 位置 / 具体字符串」，而不是「没抛异常」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  JSON_MAX_BYTES,
  countJsonNodes,
  exceedsJsonSizeLimit,
  findJsonSyntaxErrorPosition,
  formatJson,
  jsonLocationAt,
  minifyJson,
  parseJsonPath,
  parseJsonText,
  queryJsonPath,
  sortJsonKeys,
  utf8ByteLength,
} from '@/lib/dev-tools/json';
import {
  DataConvertError,
  convertData,
  csvRowsToObjects,
  csvToJson,
  jsonToCsv,
  jsonToYaml,
  parseCsv,
  yamlToJson,
} from '@/lib/dev-tools/data-convert';
import {
  DIFF_MAX_LINES,
  DiffLimitError,
  computeDiff,
  countLines,
  formatUnifiedDiff,
  splitLines,
} from '@/lib/dev-tools/diff';

// ── JSON ─────────────────────────────────────────────────────────────────────

describe('json 工具：格式化与压缩', () => {
  const sample = '{"b":[3,1],"a":{"d":2,"c":1}}';

  it('缩进 2 / 4 / Tab 各按档位输出', () => {
    const two = formatJson(sample, { indent: 2 });
    expect(two).toEqual({
      ok: true,
      output: '{\n  "b": [\n    3,\n    1\n  ],\n  "a": {\n    "d": 2,\n    "c": 1\n  }\n}',
    });

    const four = formatJson(sample, { indent: 4 });
    expect(four.ok && four.output.includes('\n    "b": [')).toBe(true);

    const tab = formatJson(sample, { indent: 'tab' });
    expect(tab.ok && tab.output.includes('\n\t"b": [')).toBe(true);
  });

  it('可选按键名排序（递归，数组保持原顺序）', () => {
    const result = formatJson(sample, { sortKeys: true });
    if (!result.ok) throw new Error('应当格式化成功');
    expect(result.output).toContain('"a"');
    expect(result.output.indexOf('"a"')).toBeLessThan(result.output.indexOf('"b"'));
    // 数组顺序不动
    expect(result.output).toContain('3,\n    1');
  });

  it('sortJsonKeys 不会把 __proto__ 当成原型赋值', () => {
    const sorted = sortJsonKeys(JSON.parse('{"__proto__":{"x":1},"b":2}'));
    expect(Object.keys(sorted as Record<string, unknown>)).toEqual(['__proto__', 'b']);
    expect(Object.getPrototypeOf(sorted)).toBe(Object.prototype);
  });

  it('压缩成一行', () => {
    expect(minifyJson('{ "a" : 1 }')).toEqual({ ok: true, output: '{"a":1}' });
  });

  it('空输入给「输入为空」而不是裸异常', () => {
    const result = parseJsonText('   \n\t');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不可能成功');
    expect(result.message).toBe('输入为空');
    expect(result.location).toBeNull();
  });
});

describe('json 工具：语法错误定位', () => {
  it('定位到行/列，并给出带插入符的片段', () => {
    const result = parseJsonText('{\n  "a": 1,\n}');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不可能成功');
    expect(result.location).not.toBeNull();
    if (!result.location) throw new Error('应当有定位');
    expect(result.location.line).toBe(3);
    expect(result.location.column).toBe(1);
    expect(result.location.snippet).toContain('^');
    expect(result.location.lineText).toBe('}');
    // 不把 V8 的英文裸异常直接给用户
    expect(result.message).toContain('属性名');
    expect(result.message).not.toContain('Unexpected');
  });

  it('超长行只截取错误位置附近的片段（插入符仍对齐）', () => {
    const long = `{"k":"${'x'.repeat(400)}" "next":1}`;
    const result = parseJsonText(long);
    expect(result.ok).toBe(false);
    if (result.ok || !result.location) throw new Error('应当报错且有定位');
    const [line, caretLine] = result.location.snippet.split('\n');
    // 片段宽度有上限（140），而不是把 400 多字符的整行原样吐出来
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.length).toBeLessThan(long.length);
    expect(caretLine.trim()).toBe('^');
    expect(caretLine.length).toBeGreaterThan(0);
  });

  it('把 `line N column M` 换回偏移（Safari / V8 有时只给行列）', () => {
    const location = jsonLocationAt('line1\nline2', 8);
    expect(location).toMatchObject({ line: 2, column: 3, position: 8 });
    expect(location.snippet).toBe('line2\n  ^');
  });

  it('兜底扫描能自己找到第一个出错位置', () => {
    expect(findJsonSyntaxErrorPosition('{"a":1 "b":2}')).toBe(7);
    expect(findJsonSyntaxErrorPosition('[1 2]')).toBe(3);
    expect(findJsonSyntaxErrorPosition('{"a":}')).toBe(5);
    expect(findJsonSyntaxErrorPosition('{"a":1,}')).toBe(7);
    expect(findJsonSyntaxErrorPosition('"abc')).toBe(4);
    expect(findJsonSyntaxErrorPosition('01')).toBe(1);
    expect(findJsonSyntaxErrorPosition('{"a":[1,{"b":null}]}')).toBeNull();
  });
});

describe('json 工具：大小上限与节点数', () => {
  it('5 MB 上限按 UTF-8 字节算', () => {
    expect(utf8ByteLength('中')).toBe(3);
    expect(exceedsJsonSizeLimit('{"a":1}')).toBe(false);
    expect(exceedsJsonSizeLimit('x'.repeat(JSON_MAX_BYTES + 1))).toBe(true);
    // UTF-16 码元数没超，但 UTF-8 字节数超了 —— 必须走精确判断
    const justOverInBytes = '中'.repeat(Math.floor(JSON_MAX_BYTES / 3) + 1);
    expect(exceedsJsonSizeLimit(justOverInBytes)).toBe(true);
  });

  it('节点数：数组元素 / 对象成员各算一个', () => {
    expect(countJsonNodes(null)).toBe(1);
    expect(countJsonNodes(1)).toBe(1);
    expect(countJsonNodes({ a: [1, 2], b: null })).toBe(5);
    expect(countJsonNodes([])).toBe(1);
  });
});

// ── JSONPath 子集 ────────────────────────────────────────────────────────────

describe('json 工具：JSONPath 子集', () => {
  const sample = {
    store: {
      book: [
        { title: 'A', price: 10, author: { name: 'x' } },
        { title: 'B', price: 20, author: { name: 'y' } },
      ],
      tags: ['a', 'b'],
    },
    'weird.key': 42,
  };

  function query(pathText: string): Array<{ path: string; value: unknown }> {
    const parsed = parseJsonPath(pathText);
    if (!parsed.ok) throw new Error(`路径解析失败：${parsed.message}`);
    return queryJsonPath(sample, parsed.tokens);
  }

  it('点号 / 括号路径都能取值', () => {
    expect(query('$')).toEqual([{ path: '$', value: sample }]);
    expect(query('$.store.tags[1]')).toEqual([{ path: '$.store.tags[1]', value: 'b' }]);
    expect(query("$.store['book'][0].title")).toEqual([
      { path: '$.store.book[0].title', value: 'A' },
    ]);
    expect(query('$["weird.key"]')).toEqual([{ path: '$["weird.key"]', value: 42 }]);
  });

  it('通配 [*] / .* 按文档顺序展开', () => {
    expect(query('$.store.tags[*]').map((hit) => hit.value)).toEqual(['a', 'b']);
    expect(query('$.store.*').map((hit) => hit.path)).toEqual(['$.store.book', '$.store.tags']);
  });

  it('递归下降 ..key / ..*', () => {
    expect(query('$..name').map((hit) => hit.value)).toEqual(['x', 'y']);
    expect(query('$..name').map((hit) => hit.path)).toEqual([
      '$.store.book[0].author.name',
      '$.store.book[1].author.name',
    ]);
    // ..* 只收后代、不含根
    const all = query('$..*');
    expect(all.map((hit) => hit.path)).toContain('$.store');
    expect(all.map((hit) => hit.path)).toContain('$.store.book[0].title');
    expect(all.some((hit) => hit.path === '$')).toBe(false);
  });

  it('越界下标与不存在的键给 0 处命中（不是错误）', () => {
    expect(query('$.store.tags[99]')).toEqual([]);
    expect(query('$.nope')).toEqual([]);
  });

  it('不支持的语法明确报错，而不是静默空结果', () => {
    const filter = parseJsonPath('$.book[?(@.price > 10)]');
    expect(filter.ok).toBe(false);
    if (filter.ok) throw new Error('应当拒绝过滤器');
    expect(filter.message).toContain('不支持');

    expect(parseJsonPath('$.a[1:3]').ok).toBe(false);
    expect(parseJsonPath('a.b').ok).toBe(false);
    expect(parseJsonPath('$.a[').ok).toBe(false);
    expect(parseJsonPath('').ok).toBe(false);
  });
});

// ── 数据转换 ─────────────────────────────────────────────────────────────────

describe('data-convert：CSV 解析', () => {
  it('基础表格 + 行尾 CRLF + BOM', () => {
    const { rows, delimiter } = parseCsv('\uFEFFa,b\r\n1,2\r\n');
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('引号内的逗号、换行与 `""` 转义', () => {
    const { rows } = parseCsv('a,b\n"x,y","line1\nline2"\n"he said ""hi""",2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y', 'line1\nline2'],
      ['he said "hi"', '2'],
    ]);
  });

  it('自动识别制表符 / 分号分隔', () => {
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
    expect(parseCsv('a;b\n1;2').delimiter).toBe(';');
    // R3-494：单元格里落单的 `"` 不能让分隔符识别整行失准（与 parseCsv 同一条引号规则：
    // 只有字段开头的引号才生效），否则制表符分隔会被误判成逗号、整行变 1 列。
    expect(parseCsv('a"b\tc\td\n1\t2\t3').delimiter).toBe('\t');
    expect(parseCsv('a"b\tc\td\n1\t2\t3').rows[0]).toEqual(['a"b', 'c', 'd']);
    // 显式指定优先于自动识别
    expect(parseCsv('a;b\n1;2', { delimiter: ',' }).rows).toEqual([
      ['a;b'],
      ['1;2'],
    ]);
  });

  it('引号没闭合给明确错误与起始行', () => {
    expect(() => parseCsv('a,b\n1,"oops')).toThrowError(DataConvertError);
    expect(() => parseCsv('a,b\n1,"oops')).toThrowError(/第 2 行/);
  });

  it('空输入 / 末尾空行', () => {
    expect(parseCsv('').rows).toEqual([]);
    expect(parseCsv('a,b\n1,2\n\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('data-convert：CSV ↔ JSON 对象数组', () => {
  it('第一行作表头，缺的列补空串', () => {
    const { headers, objects } = csvRowsToObjects([
      ['name', 'age'],
      ['alice', '18'],
      ['bob'],
      ['', ''],
    ]);
    expect(headers).toEqual(['name', 'age']);
    expect(objects).toEqual([
      { name: 'alice', age: '18' },
      { name: 'bob', age: '' },
    ]);
  });

  it('空表头补 columnN，重复表头去重（否则对象键静默覆盖）', () => {
    const { headers } = csvRowsToObjects([
      ['', 'a', 'a'],
      ['1', '2', '3'],
    ]);
    expect(headers).toEqual(['column1', 'a', 'a_2']);
  });

  it('CSV → JSON 输出对象数组', () => {
    const result = csvToJson('a,b\n1,2');
    expect(result.rowCount).toBe(1);
    expect(result.columnCount).toBe(2);
    expect(JSON.parse(result.json)).toEqual([{ a: '1', b: '2' }]);
  });

  it('JSON → CSV：必要时加引号、引号翻倍，null/嵌套有明确处理', () => {
    const result = jsonToCsv([
      { name: 'a,b', note: 'he said "hi"', n: 1, ok: true, nested: { x: 1 }, empty: null },
    ]);
    expect(result.columns).toEqual(['name', 'note', 'n', 'ok', 'nested', 'empty']);
    expect(result.csv).toBe('name,note,n,ok,nested,empty\n"a,b","he said ""hi""",1,true,"{""x"":1}",');
  });

  it('JSON → CSV：顶层不是对象数组时给明确错误', () => {
    expect(() => jsonToCsv({ a: 1 })).toThrowError(/顶层是对象/);
    expect(() => jsonToCsv([1, 2])).toThrowError(/第 1 项是数字/);
    expect(() => jsonToCsv([])).toThrowError(/非空/);
  });

  it('CSV 生成后能被自己读回来（往返一致，值都是字符串）', () => {
    const original = [{ a: 'x,y', b: 'line1\nline2' }];
    const { csv } = jsonToCsv(original);
    const roundTrip = JSON.parse(csvToJson(csv).json);
    expect(roundTrip).toEqual(original);
  });
});

describe('data-convert：YAML', () => {
  it('YAML → JSON：嵌套结构正确', () => {
    const result = yamlToJson('a: 1\nb:\n  - x\n  - y\n');
    expect(result.value).toEqual({ a: 1, b: ['x', 'y'] });
    expect(JSON.parse(result.json)).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('JSON_SCHEMA：日期保持字符串、yes/no 保持字符串（写给 JSON 的诚实口径）', () => {
    const result = yamlToJson('d: 2020-01-01\nflag: yes\n');
    expect(result.value).toEqual({ d: '2020-01-01', flag: 'yes' });
  });

  it('JSON → YAML', () => {
    expect(jsonToYaml({ a: 1, b: ['x'] })).toBe('a: 1\nb:\n  - x\n');
  });

  it('坏 YAML 不抛裸异常', () => {
    expect(() => yamlToJson('a: [1, 2')).toThrowError(DataConvertError);
    expect(() => yamlToJson('a: [1, 2')).toThrowError(/YAML 解析失败/);
  });
});

describe('data-convert：统一入口的六条边', () => {
  it('JSON ↔ YAML 往返', () => {
    const toYaml = convertData('{"a":[1,{"b":true}]}', 'json', 'yaml');
    const back = convertData(toYaml.output, 'yaml', 'json');
    expect(JSON.parse(back.output)).toEqual({ a: [1, { b: true }] });
  });

  it('JSON → CSV → JSON（值全变字符串）', () => {
    const toCsv = convertData('[{"a":1,"b":"x"},{"a":2,"b":"y"}]', 'json', 'csv');
    expect(toCsv.output).toBe('a,b\n1,x\n2,y');
    expect(toCsv.stats).toEqual({ rowCount: 2, columnCount: 2 });
    const back = convertData(toCsv.output, 'csv', 'json');
    expect(JSON.parse(back.output)).toEqual([
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ]);
  });

  it('CSV → YAML', () => {
    const result = convertData('a,b\n1,2', 'csv', 'yaml');
    expect(result.output).toBe("- a: '1'\n  b: '2'\n");
  });

  it('源与目标相同 / 输入为空 / JSON 语法错误都有明确文案', () => {
    expect(() => convertData('a: 1', 'yaml', 'yaml')).toThrowError(/相同/);
    expect(() => convertData('  ', 'json', 'yaml')).toThrowError(/输入为空/);
    expect(() => convertData('{oops}', 'json', 'yaml')).toThrowError(/JSON 解析失败/);
  });

  it('JSON → CSV 要求对象数组', () => {
    expect(() => convertData('{"a":1}', 'json', 'csv')).toThrowError(/对象数组/);
    expect(() => convertData('[1,2]', 'json', 'csv')).toThrowError(/每一项都是对象/);
  });

  it('显式分隔符用于写 CSV', () => {
    const result = convertData('[{"a":1,"b":2}]', 'json', 'csv', { csvDelimiter: ';' });
    expect(result.output).toBe('a;b\n1;2');
    // 选制表符时按制表符写
    expect(convertData('[{"a":1,"b":2}]', 'json', 'csv', { csvDelimiter: '\t' }).output).toBe(
      'a\tb\n1\t2',
    );
  });
});

// ── Diff ─────────────────────────────────────────────────────────────────────

describe('diff：行切分', () => {
  it('CRLF / CR / LF 都认，末尾换行不产生空行', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\rb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('countLines 与 splitLines().length 等价', () => {
    for (const text of ['', 'a', 'a\n', 'a\r\nb', 'a\n\nb', '\n', '\r\n', 'a\nb\n', '中\n文']) {
      expect(countLines(text)).toBe(splitLines(text).length);
    }
  });
});

describe('diff：逐行结果与统计', () => {
  it('完全一致', () => {
    const result = computeDiff('a\nb', 'a\nb');
    expect(result.identical).toBe(true);
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
    expect(result.hunks).toEqual([]);
    expect(formatUnifiedDiff(result)).toBe('');
  });

  it('替换一行：类型与行号都对', () => {
    const result = computeDiff('a\nb\nc', 'a\nx\nc');
    expect(result.identical).toBe(false);
    expect(result.stats).toEqual({ added: 1, removed: 1, unchanged: 2 });
    expect(result.lines.map((line) => line.type)).toEqual(['equal', 'remove', 'add', 'equal']);
    expect(result.lines[1]).toMatchObject({ type: 'remove', text: 'b', oldLine: 2, newLine: null });
    expect(result.lines[2]).toMatchObject({ type: 'add', text: 'x', oldLine: null, newLine: 2 });
    expect(result.lines[3]).toMatchObject({ oldLine: 3, newLine: 3 });
  });

  it('中途插入只产生新增行', () => {
    const result = computeDiff('a\nc', 'a\nb\nc');
    expect(result.stats).toEqual({ added: 1, removed: 0, unchanged: 2 });
    expect(result.lines[1]).toMatchObject({ type: 'add', text: 'b', newLine: 2, oldLine: null });
  });

  it('忽略大小写 / 行尾空白只影响比较，不改展示文本', () => {
    expect(computeDiff('A  \n', 'a\n').identical).toBe(false);
    const ignoreBoth = computeDiff('A  \n', 'a\n', {
      ignoreCase: true,
      ignoreTrailingWhitespace: true,
    });
    expect(ignoreBoth.identical).toBe(true);
    expect(ignoreBoth.lines[0].text).toBe('A  ');
  });

  it('上下文行数可调，hunk 会按上下文合并', () => {
    const left = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const right = ['A', 'b', 'c', 'd', 'e', 'f', 'G'].join('\n');
    expect(computeDiff(left, right, { context: 0 }).hunks.length).toBe(2);
    expect(computeDiff(left, right, { context: 3 }).hunks.length).toBe(1);
  });

  it('前端插入：hunk 的旧侧从 0,0 开始', () => {
    const result = computeDiff('', 'a\nb');
    expect(result.hunks.length).toBe(1);
    expect(result.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 });
  });
});

describe('diff：unified diff 与上限', () => {
  it('输出统一格式，且带换行结尾', () => {
    const diff = formatUnifiedDiff(computeDiff('a\nb\nc', 'a\nx\nc'));
    expect(diff).toContain('--- 原文本');
    expect(diff).toContain('+++ 新文本');
    expect(diff).toContain('@@ -1,3 +1,3 @@');
    expect(diff).toContain('-b');
    expect(diff).toContain('+x');
    expect(diff.endsWith('\n')).toBe(true);
  });

  it('行数上限 5000，超出抛 DiffLimitError（带哪一侧）', () => {
    const okText = 'x\n'.repeat(DIFF_MAX_LINES);
    expect(() => computeDiff(okText, 'y')).not.toThrow();

    const tooLong = 'x\n'.repeat(DIFF_MAX_LINES + 1);
    expect(() => computeDiff(tooLong, 'y')).toThrowError(DiffLimitError);
    try {
      computeDiff('y', tooLong);
    } catch (error) {
      expect(error).toBeInstanceOf(DiffLimitError);
      if (error instanceof DiffLimitError) {
        expect(error.side).toBe('right');
        expect(error.lineCount).toBe(DIFF_MAX_LINES + 1);
      }
    }
  });
});
