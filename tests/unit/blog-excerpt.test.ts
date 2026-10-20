// ─────────────────────────────────────────────────────────────────────────────
// blog-excerpt.test.ts —— 主页高卡片（h≥2）那段纯文本摘要的清洗与截断
//
// 【背景】2026-10 改版后，个人主页的文章块在 h≥2 时显示一段正文摘要。摘要是**读时
// 现算**的（不落库、不进 config），所以它的行为只能靠这里钉住：正文是作者写的
// Markdown，可能含代码块、图片、HTML、`[@…]` 引用 token；摘要必须是**一行纯文本**。
//
// 【为什么这些用例】每一条都对应一种「漏出来就很难看」的东西：代码块里的花括号、
// 图片 URL、HTML 标签原文、引用 token 的英文 ID。摘要不是安全边界（React 按纯文本
// 渲染），但漏出这些东西会让人以为主页坏了。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { blogExcerpt } from '@/lib/blog-excerpt';

describe('blogExcerpt：Markdown 标记与噪音清除', () => {
  it('围栏代码块整段丢掉，未闭合的丢到文末', () => {
    expect(blogExcerpt('前面\n```ts\nconst a = 1;\n```\n后面')).toBe('前面 后面');
    expect(blogExcerpt('前面\n~~~js\nlet b = 2\n~~~~\n后面')).toBe('前面 后面');
    // 未闭合：宁可少一段，也不把半截代码漏出来
    expect(blogExcerpt('正文\n```\nconst leaked = 1;')).toBe('正文');
    // 引用里的围栏（`> ``` `）同样识别
    expect(blogExcerpt('> ```\n> code\n> ```\n正文')).toBe('正文');
  });

  it('行内代码连内容一起删（变量名不该进摘要）', () => {
    expect(blogExcerpt('用 `npm ci` 安装')).toBe('用 安装');
    expect(blogExcerpt('``const x = 1`` 是声明')).toBe('是声明');
  });

  it('图片连 alt 一起删，链接保留文字、URL 不出现', () => {
    expect(blogExcerpt('图 ![封面](/static/a.png) 在这里')).toBe('图 在这里');
    expect(blogExcerpt('![封面][cover] 结束')).toBe('结束');
    expect(blogExcerpt('读 [阅读全文](/blog/abc) 吧')).toBe('读 阅读全文 吧');
    const withTitle = blogExcerpt('[外链](https://example.com/a "标题") 结尾');
    expect(withTitle).toBe('外链 结尾');
    expect(withTitle).not.toContain('http');
    // URL 里带括号也不能把尾巴漏出来
    expect(blogExcerpt('[条目](https://zh.wikipedia.org/wiki/A_(b)) 完')).toBe('条目 完');
  });

  it('HTML 标签只去标签，script / style 连内容一起删', () => {
    expect(blogExcerpt('<p>段落</p><br><strong>加粗</strong>')).toBe('段落 加粗');
    expect(blogExcerpt('前<script>alert("x")</script>后')).toBe('前后');
    expect(blogExcerpt('前<!-- 注释 -->后')).toBe('前后');
    expect(blogExcerpt('<https://example.com/x> 结尾')).toBe('https://example.com/x 结尾');
  });

  it('引用 token 整块丢掉（[@8位] / [@音频/ID] / [@用户/名字]）', () => {
    expect(blogExcerpt('见 [@8位/9位/10位] 和 [@音频/abc123] 和 [@用户/alice]')).toBe('见 和 和');
  });

  it('标题、引用、列表、强调标记都去掉', () => {
    const md = ['# 大标题', '', '> 一段引用', '', '- 一', '- 二', '', '**粗**体 ~~删除~~ _斜_'].join('\n');
    expect(blogExcerpt(md)).toBe('大标题 一段引用 一 二 粗体 删除 斜');
  });

  it('表格只留文字、分隔行不出现', () => {
    expect(blogExcerpt('| 名称 | 值 |\n|---|:---:|\n| a | 1 |')).toBe('名称 值 a 1');
  });

  it('链接定义行整行删（否则 URL 会当正文漏出来）', () => {
    expect(blogExcerpt('正文\n\n[ref]: https://example.com "标题"')).toBe('正文');
  });

  it('反斜杠转义按字面处理后再清标记', () => {
    expect(blogExcerpt('\\*不是列表\\*')).toBe('不是列表');
  });

  it('空白折叠成一行（含 CRLF 与制表符）', () => {
    const out = blogExcerpt('  a\r\n\r\n   b\t\tc  ');
    expect(out).toBe('a b c');
    expect(out).not.toContain('\n');
  });

  it('空正文与纯空白正文返回空串', () => {
    expect(blogExcerpt('')).toBe('');
    expect(blogExcerpt('   \n\n\t ')).toBe('');
    expect(blogExcerpt('```\nonly code\n```')).toBe('');
  });
});

describe('blogExcerpt：截断', () => {
  it('超长时切到 max 再补省略号（省略号在 max 之外）', () => {
    const long = 'a'.repeat(500);
    expect(blogExcerpt(long)).toBe('a'.repeat(280) + '…');
    expect(blogExcerpt(long, 10)).toBe('a'.repeat(10) + '…');
  });

  it('刚好等于 max 时不截断、不加省略号', () => {
    const exact = 'b'.repeat(280);
    expect(blogExcerpt(exact)).toBe(exact);
    expect(blogExcerpt(exact)).not.toContain('…');
  });

  it('★ 截断不切坏代理对（emoji 剩完整的字符 + 省略号）', () => {
    const emoji = '😀'.repeat(200); // 每个占两个 UTF-16 码元
    // max=5 落在第 3 个 emoji 的高代理项之后：整个字符让出去，剩 2 个 emoji
    const out = blogExcerpt(emoji, 5);
    expect(out).toBe('😀😀…');
    expect(out.length).toBe(5);
    // 非截断路径也不能动代理对
    expect(blogExcerpt('😀😀', 10)).toBe('😀😀');
  });

  it('max ≤ 0 返回空串', () => {
    expect(blogExcerpt('abc', 0)).toBe('');
    expect(blogExcerpt('abc', -1)).toBe('');
  });
});
