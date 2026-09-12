// ─────────────────────────────────────────────────────────────────────────────
// cli-output.test.ts —— 显示宽度与表格渲染
//
// 【为什么单独钉】这是中文站，用 String.length 补空格必然错位：
// '中文标题'.length === 4，实际占 8 列。这类错误 tsc 不管、build 不报，
// 只会在运维盯着表格时表现为「列没对齐」—— 而错位到一定程度就无法阅读了。
//
// 断言一律是**逐字**的：宽度算法的偏差只有在具体字符串上才看得出来。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  displayWidth,
  padTo,
  renderKv,
  renderTable,
  stripAnsi,
  truncateTo,
} from '../../scripts/cli/output';

const RED = (s: string): string => `\x1b[31m${s}\x1b[0m`;

describe('displayWidth', () => {
  it('ASCII 一个字符算 1 列', () => {
    expect(displayWidth('ab')).toBe(2);
    expect(displayWidth('abc123')).toBe(6);
  });

  it('汉字算 2 列（这正是 String.length 会算错的地方）', () => {
    expect('中文标题'.length).toBe(4); // UTF-16 码元数
    expect(displayWidth('中文标题')).toBe(8); // 实际列宽
  });

  it('中英混排按各自宽度累加', () => {
    expect(displayWidth('文章 abc')).toBe(4 + 1 + 3);
  });

  it('全角标点算 2 列', () => {
    expect(displayWidth('（一）')).toBe(6);
  });

  it('emoji 算 2 列（代理对不能被拆成两个 1）', () => {
    expect(displayWidth('🐟')).toBe(2);
  });

  it('ANSI 转义不计入宽度', () => {
    expect(displayWidth(RED('中文'))).toBe(4);
    expect(displayWidth(RED('ab'))).toBe(2);
  });

  it('空串是 0', () => {
    expect(displayWidth('')).toBe(0);
  });
});

describe('stripAnsi', () => {
  it('剥掉颜色码，保留正文', () => {
    expect(stripAnsi(RED('错误：xxx'))).toBe('错误：xxx');
  });

  it('无颜色时原样返回', () => {
    expect(stripAnsi('普通文本')).toBe('普通文本');
  });
});

describe('truncateTo', () => {
  it('不超宽时原样返回（不加省略号）', () => {
    expect(truncateTo('中文', 4)).toBe('中文');
  });

  it('超宽时按显示宽度截断并以 … 收尾', () => {
    // 目标宽度 4：汉字各占 2，只能放 1 个 + 省略号
    expect(truncateTo('中文标题', 4)).toBe('中…');
  });

  it('ANSI 不参与宽度计算，但会被剥掉', () => {
    expect(truncateTo(RED('中文标题'), 4)).toBe('中…');
  });

  it('宽度不足以放任何字符时只留省略号', () => {
    expect(truncateTo('中文', 1)).toBe('…');
  });
});

describe('padTo', () => {
  it('左对齐按显示宽度补到目标宽度', () => {
    expect(padTo('中文', 8)).toBe('中文' + ' '.repeat(4));
    expect(padTo('ab', 8)).toBe('ab' + ' '.repeat(6));
  });

  it('右对齐补在前面', () => {
    expect(padTo('中文', 8, 'right')).toBe(' '.repeat(4) + '中文');
  });

  it('已经够宽就不补', () => {
    expect(padTo('中文标题', 4)).toBe('中文标题');
  });
});

describe('renderTable', () => {
  const columns = [
    { key: 'title', title: '标题' },
    { key: 'n', title: '数', align: 'right' as const },
  ];

  it('列宽按显示宽度对齐（中英混排的逐字断言）', () => {
    const lines = renderTable(columns, [
      { title: '中文', n: 1 },
      { title: 'ab', n: 22 },
    ]);
    // 表头 '标题'(4 列) + 2 空格 + '数'(2 列) = 8 列，分隔线因此是 8 个短横
    expect(lines).toEqual(['标题  数', '────────', '中文   1', 'ab    22']);
  });

  it('表头与分隔线的列宽一致', () => {
    const lines = renderTable(columns, [{ title: 'x', n: 1 }]);
    expect(displayWidth(lines[0])).toBe(displayWidth(lines[1]));
  });

  it('空结果给一行提示，而不是只有表头的空表', () => {
    expect(renderTable(columns, [], { emptyText: '（没有匹配）' })).toEqual(['（没有匹配）']);
  });

  it('单元格里的换行折成空格（否则正文会把表格撑烂）', () => {
    const lines = renderTable([{ key: 'content', title: '正文' }], [
      { content: '第一行\n第二行\n\n第三行' },
    ]);
    expect(lines[2]).toContain('第一行 第二行 第三行');
    expect(lines[2]).not.toContain('\n');
  });

  it('null / undefined / 空串统一显示为 —', () => {
    const lines = renderTable([{ key: 'a', title: 'A' }], [{ a: null }, { a: '' }, { a: undefined }]);
    expect(lines.slice(2)).toEqual(['—', '—', '—']);
  });

  it('超长单元格按 maxWidth 截断', () => {
    const lines = renderTable([{ key: 't', title: '标题', maxWidth: 5 }], [
      { t: '这是一个非常长的中文标题' },
    ]);
    expect(lines[2]).toBe('这是…');
  });
});

describe('renderKv', () => {
  it('键列按最长键对齐', () => {
    expect(renderKv([['用户名', 'alice'], ['角色', 'owner']])).toEqual(['用户名  alice', '角色    owner']);
  });

  it('缺值显示为 —', () => {
    expect(renderKv([['禁言至', null]])).toEqual(['禁言至  —']);
  });
});
