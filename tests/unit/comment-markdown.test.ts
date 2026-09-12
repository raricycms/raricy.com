// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// comment-markdown.test.ts —— 评论 Markdown 渲染管线的安全边界
//
// 【为什么与 chat-markdown.test.ts 逐条对齐】两者共用 src/lib/rich-text.ts 的同一套
// 管线与同一份白名单，但**入口不同、攻击面不同**：评论区的作者是 core+，读者是所有人
// （含未登录访客），且评论会渲染在同一篇文章下成百上千条。这份用例保证「换了入口
// 没有把任何一道防线落下」—— 向量与聊天那份一一对应，只有类名断言不同。
//
// 【断言一律落在解析后的 DOM 上】字符串比对会被 `&lt;script&gt;` 这类转义形式骗过去。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderCommentMarkdown } from '@/lib/comment-markdown';

/** 渲染 + 解析成 DOM，便于按结构断言。 */
function mount(content: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderCommentMarkdown(content);
  return root;
}

/** 收集带 on* 事件属性的元素（转义成文本的「属性」不算 —— 那只是字符，不会绑定）。 */
function elementsWithEventAttrs(root: HTMLElement): string[] {
  const bad: string[] = [];
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) bad.push(`${el.tagName}[${attr.name}]`);
    }
  });
  return bad;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('基础 Markdown 结构', () => {
  it('行内标记：粗体 / 斜体 / 删除线 / 行内代码', () => {
    const root = mount('**粗** *斜* ~~删~~ `code`');
    expect(root.querySelector('strong')?.textContent).toBe('粗');
    expect(root.querySelector('em')?.textContent).toBe('斜');
    expect(root.querySelector('del')?.textContent).toBe('删');
    expect(root.querySelector('code')?.textContent).toBe('code');
  });

  it('无序 / 有序列表', () => {
    expect(mount('- a\n- b').querySelectorAll('ul > li')).toHaveLength(2);
    expect(mount('1. a\n2. b').querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('引用、标题、分割线、表格', () => {
    expect(mount('> 引用').querySelector('blockquote')?.textContent).toContain('引用');
    expect(mount('## 标题').querySelector('h2')?.textContent).toBe('标题');
    expect(mount('---').querySelector('hr')).not.toBeNull();
    const table = mount('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table.querySelectorAll('table th')).toHaveLength(2);
    expect(table.querySelectorAll('table td')).toHaveLength(2);
  });

  it('单换行按 <br> 处理（与改版前的纯文本评论一致）', () => {
    expect(mount('a\nb').querySelector('br')).not.toBeNull();
  });

  it('GFM 任务列表：复选框为禁用态', () => {
    const box = mount('- [x] 完成').querySelector('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect(box).toHaveProperty('disabled', true);
  });

  it('空内容 → 空串', () => {
    expect(renderCommentMarkdown('')).toBe('');
  });
});

describe('链接：识别与加固', () => {
  it('Markdown 链接：类名 + 外链 target/rel', () => {
    const a = mount('[点我](https://example.com/a)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/a');
    expect(a.textContent).toBe('点我');
    expect(a.classList.contains('comment-link')).toBe(true);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toMatch(/noopener/);
  });

  it('站内链接：本页跳转，不加 target', () => {
    const a = mount('[博客](/blog/1)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/blog/1');
    expect(a.hasAttribute('target')).toBe(false);
    expect(a.classList.contains('comment-link')).toBe(true);
  });

  it('裸 URL 自动识别，尾部中文句读不吞进 href', () => {
    const root = mount('见 https://example.com/x。 后面');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.textContent).toBe('https://example.com/x');
    expect(root.textContent?.trim()).toBe('见 https://example.com/x。 后面');
  });

  it('代码块 / 行内代码里的 URL 不变成链接', () => {
    expect(mount('`https://example.com`').querySelector('a')).toBeNull();
    expect(mount('```\nhttps://example.com\n```').querySelector('a')).toBeNull();
  });

  it('图片降级为链接（评论发图走图床附件，不允许外链 <img>）', () => {
    const root = mount('![看图](https://example.com/x.png)');
    expect(root.querySelector('img')).toBeNull();
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x.png');
    expect(a.textContent).toBe('看图');
  });
});

describe('XSS：原始 HTML 一律当文本', () => {
  it('<script> 不落地，但原文可见', () => {
    const root = mount('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('<img onerror> 不落地（innerHTML 插入的 img 会真的触发 onerror）', () => {
    const root = mount('<img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
    expect(elementsWithEventAttrs(root)).toEqual([]);
    expect(root.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('svg / iframe / style / form 等标签被拒', () => {
    for (const payload of [
      '<svg onload=alert(1)></svg>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<style>body{display:none}</style>',
      '<form action="/api/x"><input name=a></form>',
      '<math><mtext><script>alert(1)</script></mtext></math>',
    ]) {
      const root = mount(payload);
      expect(root.querySelector('svg, iframe, style, form, math, script')).toBeNull();
    }
  });

  it('事件属性被剥离', () => {
    const root = mount('<a href="/x" onclick="alert(1)">x</a><p onmouseover=alert(1)>y</p>');
    expect(elementsWithEventAttrs(root)).toEqual([]);
  });

  // 回归：marked 的 inRawBlock 裸文本通道（补丁在 rich-text.ts 的 walkTokens）。
  // 评论区同样是「一个 core+ 发帖 → 所有读者中招」的存储型 XSS 面，与聊天等价。
  it('畸形标签不会经 inRawBlock 裸文本通道直出', () => {
    const payloads = [
      'x<code><input type="password"y></code>请输入密码',
      'x<pre><input type="password"y></pre>',
      'x<kbd><input type="password"y></kbd>',
      'x<script><input type="password"y></script>',
      'x<style><input type="password"y></style>',
      'x<textarea><input type="password"y></textarea>',
    ];
    for (const payload of payloads) {
      const root = mount(payload);
      expect(root.querySelector('input')).toBeNull();
      expect(root.textContent).toContain('<input type="password"y>');
    }
  });

  it('畸形标签里夹带的伪协议链接同样被摘掉 href', () => {
    const root = mount('x<code><a href="javascript:alert(1)"y>点我</a></code>');
    expect(root.querySelector('a[href]')).toBeNull();
    expect(root.querySelector('[href^="javascript"]')).toBeNull();
  });

  it('用户自带的 class 无法落到元素上（防伪造 UI 类名）', () => {
    const raw = mount('<a href="/x" class="chat-msg__blog">伪装成博客卡片</a>');
    expect(raw.querySelector('a')).toBeNull();
    expect(raw.textContent).toContain('伪装成博客卡片');
    const code = mount('```js\nlet a = 1\n```').querySelector('code')!;
    expect(code.getAttribute('class')).toBeNull();
  });
});

describe('XSS：伪协议链接', () => {
  const payloads = [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](  javascript:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '![x](javascript:alert(1))',
    '<https://example.com/x> [x](%6a%61vascript:alert(1))',
  ];

  it.each(payloads)('%s → 输出无危险协议', (payload) => {
    const html = renderCommentMarkdown(payload);
    expect(html).not.toMatch(/javascript\s*:/i);
    expect(html).not.toMatch(/vbscript\s*:/i);
    expect(html).not.toMatch(/data\s*:/i);
  });

  it('javascript: 链接的 href 被摘掉，文字保留', () => {
    const a = mount('[点我](javascript:alert(1))').querySelector('a')!;
    expect(a.hasAttribute('href')).toBe(false);
    expect(a.textContent).toBe('点我');
  });
});

describe('无 DOM 环境（SSR）的回退', () => {
  it('净化不可用时只输出转义纯文本，绝不透传 HTML', () => {
    vi.stubGlobal('window', undefined);
    const html = renderCommentMarkdown('<script>alert(1)</script>\n**粗**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('**粗**');
    expect(html).toContain('<br>');
  });
});

// 两个渲染器各持白名单与缓存，不能互相串味（共用缓存会让评论拿到聊天类名的 HTML）。
describe('渲染器隔离', () => {
  it('两个入口的链接类名互不污染', async () => {
    const { renderChatMarkdown } = await import('@/lib/chat-markdown');
    expect(mount('[x](https://example.com/a)').querySelector('a')!.className).toBe('comment-link');
    const chatRoot = document.createElement('div');
    chatRoot.innerHTML = renderChatMarkdown('[x](https://example.com/a)');
    expect(chatRoot.querySelector('a')!.className).toBe('chat-msg__link');
  });
});
