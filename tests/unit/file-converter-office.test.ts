// ─────────────────────────────────────────────────────────────────────────────
// file-converter-office.test.ts —— Office 文档能力区（node 环境）。
//
// 【为什么是 node】DOCX 的构建（docx 包）与读取（mammoth）都不需要 DOM，
//   node 下能跑真正的往返：用 docx 包造一份文档 → 用 mammoth 读回来。这条往返
//   钉住两件事：① 我们的块级模型 → docx 段落映射是对的；② 读路径能拿回文字。
//
// 【分层】把「纯逻辑」（分段 / HTML → 块 / 块 → Markdown / mammoth 消息折算）与
//   「引擎往返」分开测：纯逻辑失败一眼看出是映射错，往返失败才怀疑库。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  blocksToMarkdown,
  buildDocxFromBlocks,
  docxToHtml,
  docxToText,
  htmlToBlocks,
  htmlToMarkdown,
  mammothMessagesToNotices,
  textToBlocks,
} from '@/lib/file-converter/engines/office';
import { CATEGORY, ebookExtraEdges } from '@/lib/file-converter/categories/office';
import { registryProblems } from '@/lib/file-converter/registry';
import type { CategoryDef } from '@/lib/file-converter/types';

// ─── 纯逻辑：纯文本分段 ────────────────────────────────────────────────────────

describe('textToBlocks 分段', () => {
  it('按空行切段，段内单换行保留', () => {
    const blocks = textToBlocks('第一段\n第二行\n\n第二段\n\n\n第三段');
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true);
    const first = blocks[0] as { kind: 'paragraph'; spans: { text: string }[] };
    expect(first.spans[0].text).toBe('第一段\n第二行');
  });

  it('忽略纯空白段与 CRLF', () => {
    const blocks = textToBlocks('A\r\n\r\n \r\n\r\nB');
    expect(blocks).toHaveLength(2);
  });

  it('空文本 → 无块', () => {
    expect(textToBlocks('')).toEqual([]);
    expect(textToBlocks('\n\n\n')).toEqual([]);
  });
});

// ─── 纯逻辑：HTML → 块 → Markdown ─────────────────────────────────────────────

describe('htmlToBlocks / blocksToMarkdown', () => {
  it('解析标题、段落、强调、列表', () => {
    const blocks = htmlToBlocks(
      '<h2>小节</h2><p>段落 <strong>粗</strong> 与 <em>斜</em>。</p><ul><li>一</li><li>二</li></ul>'
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'listItem', 'listItem']);
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('## 小节');
    expect(md).toContain('**粗**');
    expect(md).toContain('*斜*');
    expect(md).toContain('- 一');
    expect(md).toContain('- 二');
  });

  it('有序列表带序号，嵌套项层级缩进', () => {
    const blocks = htmlToBlocks('<ol><li>甲<ul><li>子</li></ul></li><li>乙</li></ol>');
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('1. 甲');
    expect(md).toContain('  - 子');
    expect(md).toContain('2. 乙');
  });

  it('链接与图片映射成 Markdown', () => {
    const html = '<p><a href="https://x.test">站点</a><img src="a.png" alt="图"/></p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('[站点](https://x.test)');
    expect(md).toContain('![图](a.png)');
  });

  it('表格降级为管道表文本', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const blocks = htmlToBlocks(html);
    expect(blocks[0].kind).toBe('table');
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('剥掉 script/style 与注释', () => {
    const html = '<p>正文</p><script>alert(1)</script><!-- x --><style>p{color:red}</style>';
    const blocks = htmlToBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocksToMarkdown(blocks)).toBe('正文');
  });
});

// ─── 纯逻辑：mammoth 消息 → notices ──────────────────────────────────────────

describe('mammothMessagesToNotices', () => {
  it('空消息 → 空数组', () => {
    expect(mammothMessagesToNotices([])).toEqual([]);
    expect(mammothMessagesToNotices(undefined)).toEqual([]);
  });

  it('汇总警告与错误条数并逐条列出', () => {
    const notices = mammothMessagesToNotices([
      { type: 'warning', message: '不支持的样式' },
      { type: 'error', message: '图片丢失' },
    ]);
    expect(notices[0]).toContain('1 条警告');
    expect(notices[0]).toContain('1 条错误');
    expect(notices.join('\n')).toContain('不支持的样式');
    expect(notices.join('\n')).toContain('图片丢失');
  });

  it('超出上限时截断并交代其余条数', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: 'warning' as const, message: `w${i}` }));
    const notices = mammothMessagesToNotices(many, 5);
    expect(notices.some((n) => n.includes('其余 7 条'))).toBe(true);
  });
});

// ─── 引擎往返：docx 包生成 → mammoth 读回 ────────────────────────────────────

describe('DOCX 往返（docx 包 ↔ mammoth）', () => {
  it('纯文本 → DOCX → 文本，段落文字保留', async () => {
    const bytes = await buildDocxFromBlocks(textToBlocks('第一段内容。\n第二行。\n\n第二段内容。'));
    expect(bytes.byteLength).toBeGreaterThan(0);
    const { text } = await docxToText(bytes);
    expect(text).toContain('第一段内容。');
    expect(text).toContain('第二行。');
    expect(text).toContain('第二段内容。');
  });

  it('标题 / 段落 / 列表 → DOCX → HTML 结构保留', async () => {
    const blocks = [
      { kind: 'heading' as const, level: 2, spans: [{ kind: 'text' as const, text: '章节标题' }] },
      { kind: 'paragraph' as const, spans: [{ kind: 'text' as const, text: '正文段落' }, { kind: 'text' as const, text: '加粗', bold: true }] },
      { kind: 'listItem' as const, ordered: false, level: 0, index: 1, spans: [{ kind: 'text' as const, text: '列表项一' }] },
    ];
    const bytes = await buildDocxFromBlocks(blocks, { title: '测试' });
    const { html } = await docxToHtml(bytes);
    expect(html).toContain('章节标题');
    expect(html).toContain('正文段落');
    expect(html).toContain('列表项一');
    expect(html.toLowerCase()).toContain('<h2');
  });

  it('空块集合也产出合法 DOCX（至少一个空段落）', async () => {
    const bytes = await buildDocxFromBlocks([]);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const { text } = await docxToText(bytes);
    expect(typeof text).toBe('string');
  });

  it('损坏字节 → 归类为 corrupt', async () => {
    await expect(docxToText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toMatchObject({
      kind: 'corrupt',
    });
  });
});

// ─── 登记表完整性 ─────────────────────────────────────────────────────────────

describe('office 登记表', () => {
  it('office 边的 id 前缀与定义为 document 的类别相容，且 planned 无 run', () => {
    expect(registryProblems([CATEGORY])).toEqual([]);
  });

  it('电子书借调边在 ebook 类别下合法', () => {
    const ebook: CategoryDef = {
      key: 'ebook',
      label: '电子书',
      hint: '',
      accept: '',
      maxFilesPerTask: 1,
      edges: ebookExtraEdges,
    };
    expect(registryProblems([ebook])).toEqual([]);
    expect(ebookExtraEdges[0].id).toBe('ebook:docx-to-epub');
  });

  it('planned 边不实现 run', () => {
    for (const e of CATEGORY.edges) {
      if (e.status === 'planned') expect(e.run).toBeUndefined();
      else expect(typeof e.run).toBe('function');
    }
  });
});
