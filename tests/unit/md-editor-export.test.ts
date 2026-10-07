// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-export.test.ts —— 导出件（HTML / 打印）里那几个只有打开文件才看得见的坑
//
// 【为什么单测】导出件是**一份死文件**，出问题的时候页面那边一切正常：
//   · 正文里的 `/api/images/<id>/raw` 在文件里按**文件自己的位置**解析 →
//     `file:///api/images/…`，双击打开图片全裂、站内链接全废；
//   · head 里的样式同理，还多一层：MathJax 的 CHTML 字体表写的是
//     `url("/static/mathjax/…")`，不补成绝对地址公式就退回字体（字形与间距都不对）；
//   · 但**不能加 `<base>`** —— 那会把导出件内部该在自己身上跳的 `#锚点`
//     也一并带回原站；
//   · 代码块的「复制」按钮是**站内页面才成立的空壳**（行为由 JS 挂），留在死文件里
//     就是一颗按不动的按钮；
//   · 打印是「写完 iframe 立刻 print」还是「等资源画得出来再 print」，只有在真按下
//     打印、且图还没加载完时才看得出差别（打出来是空白框），而且**不能等死**。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRINT_READY_MAX_MS,
  absolutizeSiteUrls,
  buildExportHtml,
  printHtml,
  safeFilename,
  stripInteractiveShells,
} from '@/app/components/markdown-editor/export';

const ORIGIN = 'https://example.test';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.head.querySelectorAll('style[data-test], link[data-test]').forEach((n) => n.remove());
});

function holder(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('正文里的站内相对地址', () => {
  it('src / href / poster 补成站点绝对地址', () => {
    const el = holder(
      '<img src="/api/images/abcdefghij/raw">' +
        '<audio poster="/api/audio/abcdefghij/raw"></audio>' +
        '<a href="/blog/abc">站内</a>'
    );
    absolutizeSiteUrls(el, ORIGIN);

    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      `${ORIGIN}/api/images/abcdefghij/raw`
    );
    expect(el.querySelector('audio')?.getAttribute('poster')).toBe(
      `${ORIGIN}/api/audio/abcdefghij/raw`
    );
    expect(el.querySelector('a')?.getAttribute('href')).toBe(`${ORIGIN}/blog/abc`);
  });

  it('★ `#锚点` 一律不碰（导出件内部该在自己身上跳）★', () => {
    const el = holder('<a href="#section-1">跳到第一节</a>');
    absolutizeSiteUrls(el, ORIGIN);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('#section-1');
  });

  it('别的体系一律不碰：https / //cdn / mailto / data', () => {
    const el = holder(
      '<a href="https://other.test/x">外站</a>' +
        '<img src="//cdn.test/a.png">' +
        '<a href="mailto:a@b.test">邮件</a>' +
        '<img src="data:image/png;base64,AAA">'
    );
    absolutizeSiteUrls(el, ORIGIN);
    expect(el.querySelectorAll('a')[0].getAttribute('href')).toBe('https://other.test/x');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('//cdn.test/a.png');
    expect(el.querySelectorAll('a')[1].getAttribute('href')).toBe('mailto:a@b.test');
    expect(el.querySelectorAll('img')[1].getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('站点源末尾多写的斜杠不会拼出 `//api/...`', () => {
    const el = holder('<img src="/api/images/abcdefghij/raw">');
    absolutizeSiteUrls(el, `${ORIGIN}///`);
    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      `${ORIGIN}/api/images/abcdefghij/raw`
    );
  });
});

describe('剥掉站内才成立的空壳', () => {
  it('代码块的复制按钮被摘掉，代码本身留着', () => {
    const el = holder(
      '<div class="highlight"><pre><code class="hljs">x</code></pre>' +
        '<button class="copy-btn" data-code="x">复制</button></div>'
    );
    stripInteractiveShells(el);
    expect(el.querySelector('.copy-btn')).toBeNull();
    expect(el.querySelector('pre code')?.textContent).toBe('x');
  });
});

describe('导出文件本身', () => {
  it('`<title>` 用**当下**的标题，且 HTML 转义（它可能含尖括号）', () => {
    const html = buildExportHtml({ title: 'a<b>&"c', bodyHtml: '<p>x</p>', origin: ORIGIN });
    expect(html).toContain('<title>a&lt;b&gt;&amp;&quot;c</title>');
  });

  it('★ 不写 `<base>` ★ —— 写它会顺手把 `#锚点` 也带回原站', () => {
    const html = buildExportHtml({ title: 't', bodyHtml: '<a href="#s">s</a>', origin: ORIGIN });
    expect(html).not.toContain('<base');
    expect(html).toContain('href="#s"');
  });

  it('正文包在 .blog-content-container 里（与文章页同一套版式）', () => {
    const html = buildExportHtml({ title: 't', bodyHtml: '<p>hello</p>', origin: ORIGIN });
    expect(html).toContain('<div class="blog-content-container">');
    expect(html).toContain('<p>hello</p>');
  });

  it('★ `<style>` 里站内相对的 url(/…) 也补成绝对地址（MathJax 的字体表就是这种形态）★', () => {
    const style = document.createElement('style');
    style.setAttribute('data-test', '1');
    style.textContent = '@font-face{src:url("/static/mathjax/woff-v2/MathJax_Main-Regular.woff")}'
      + '.x{background:url(/static/bg.png)}';
    document.head.appendChild(style);

    const html = buildExportHtml({ title: 't', bodyHtml: '', origin: ORIGIN });
    expect(html).toContain(`url("${ORIGIN}/static/mathjax/woff-v2/MathJax_Main-Regular.woff")`);
    expect(html).toContain(`url(${ORIGIN}/static/bg.png)`);
    // data: / https: / //cdn 一概不碰
    expect(html).not.toContain(`url("${ORIGIN}/https:`);
  });
});

describe('文件名', () => {
  it('两批禁用字符并集换成 -，空白去掉，空标题有兜底', () => {
    expect(safeFilename('我的 文章/2026:草稿')).toBe('我的-文章-2026-草稿');
    // 括号不在两平台的禁用集里，留着；换成 `-` 的只有真正进不了文件名的那些
    expect(safeFilename('<script>alert(1)</script>')).toBe('script-alert(1)-script');
    expect(safeFilename('   ')).toBe('document');
    expect(safeFilename('', '未命名')).toBe('未命名');
  });
});

describe('打印：等资源画得出来，但绝不等到死', () => {
  /** 拦截 printHtml 造出来的那个 iframe 的 print。 */
  function capturePrint() {
    const spy = vi.fn();
    const frame = document.querySelector('iframe') as HTMLIFrameElement | null;
    if (!frame) throw new Error('printHtml 没造 iframe');
    const win = frame.contentWindow as (Window & { print?: () => void }) | null;
    if (!win) throw new Error('iframe 没有 contentWindow');
    win.print = spy;
    return { spy, frame };
  }

  it('★ 图还没加载完就先等它 —— 不是写完 iframe 立刻打印 ★', async () => {
    vi.useFakeTimers();
    printHtml(
      buildExportHtml({
        title: 't',
        bodyHtml: '<img src="https://example.test/a.png">',
        origin: ORIGIN,
      })
    );
    const { spy, frame } = capturePrint();
    const img = frame.contentDocument!.querySelector('img')!;

    await vi.advanceTimersByTimeAsync(50);
    expect(spy, '图还在路上就打印了 —— 打出来是个空白框').not.toHaveBeenCalled();

    // 图到了：两帧之后就该打印
    img.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('★ 资源一直不来也不吊死：到上限照打 ★', async () => {
    vi.useFakeTimers();
    printHtml(
      buildExportHtml({
        title: 't',
        // 图片永远不 load，样式表永远不 load（jsdom 里两者本来就不会自己完成）
        bodyHtml: '<img src="https://example.test/never.png">',
        origin: ORIGIN,
      })
    );
    const { spy } = capturePrint();

    await vi.advanceTimersByTimeAsync(PRINT_READY_MAX_MS - 100);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(spy, '资源卡住时打印跟着卡住了').toHaveBeenCalledTimes(1);
  });

  it('打印完把 iframe 摘掉（否则每点一次留一个空文档挂在页面上）', async () => {
    vi.useFakeTimers();
    printHtml(
      buildExportHtml({
        title: 't',
        bodyHtml: '<img src="https://example.test/never.png">',
        origin: ORIGIN,
      })
    );
    const { spy } = capturePrint();
    await vi.advanceTimersByTimeAsync(PRINT_READY_MAX_MS + 200);
    expect(spy).toHaveBeenCalled();
    // 打印对话框还没取走文档之前不能摘
    expect(document.querySelector('iframe')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1200);
    expect(document.querySelector('iframe')).toBeNull();
  });
});
