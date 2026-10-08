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
  localizeFragmentLinks,
  printHtml,
  resolveUrl,
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

describe('正文里的相对地址', () => {
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

  it('别的体系一律不碰：https / mailto / tel / data', () => {
    const el = holder(
      '<a href="https://other.test/x">外站</a>' +
        '<a href="mailto:a@b.test">邮件</a>' +
        '<a href="tel:+8610000000000">电话</a>' +
        '<img src="data:image/png;base64,AAA">'
    );
    absolutizeSiteUrls(el, ORIGIN);
    expect(el.querySelectorAll('a')[0].getAttribute('href')).toBe('https://other.test/x');
    expect(el.querySelectorAll('a')[1].getAttribute('href')).toBe('mailto:a@b.test');
    expect(el.querySelectorAll('a')[2].getAttribute('href')).toBe('tel:+8610000000000');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('★ 协议相对地址 `//cdn…` 补上这一页的协议 ★', () => {
    // 原样留着的话，导出件从 `file://` 打开时会把它解析成 `file://cdn.test/a.png`
    // —— 一个不存在的主机上的文件，图必裂，而页面上看不出「是协议的问题」。
    const el = holder('<img src="//cdn.test/a.png">');
    absolutizeSiteUrls(el, `${ORIGIN}/blog/upload`);
    expect(el.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/a.png');
  });

  it('★ 普通相对路径按**这一页**解析：../ 与 ./ 都要算对 ★', () => {
    // 作者写相对地址时脑子里是「我这一页」，导出件却从 file:///C:/… 那一层解析
    const el = holder(
      '<a href="../">首页</a>' +
        '<img src="../../api/images/abcdefghij/raw">' +
        '<a href="./next">下一节</a>' +
        '<a href="page.html#第二节">带锚点的相对页</a>'
    );
    absolutizeSiteUrls(el, `${ORIGIN}/blog/upload`);
    expect(el.querySelectorAll('a')[0].getAttribute('href')).toBe(`${ORIGIN}/`);
    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      `${ORIGIN}/api/images/abcdefghij/raw`
    );
    expect(el.querySelectorAll('a')[1].getAttribute('href')).toBe(`${ORIGIN}/blog/next`);
    // 片段跟着一起活下来（中文会被 percent-encode，浏览器里等价）
    expect(el.querySelectorAll('a')[2].getAttribute('href')).toMatch(
      new RegExp(`^${ORIGIN}/blog/page\\.html#`)
    );
  });

  it('解析不出来的畸形值原样留着（不拿一个坏值去换另一个坏值）', () => {
    expect(resolveUrl('http://[', ORIGIN)).toBe('http://[');
    expect(resolveUrl('', ORIGIN)).toBe('');
  });

  it('★ 内联 style 与正文里的 <style> 也一起解析 ★', () => {
    const el = holder(
      '<div style="background:url(../static/bg.png)">x</div>' +
        '<style>@font-face{src:url("./f.woff")} .a{background:url(#filter)}</style>'
    );
    absolutizeSiteUrls(el, `${ORIGIN}/blog/upload`);
    expect(el.querySelector('div')?.getAttribute('style')).toContain(
      `url(${ORIGIN}/static/bg.png)`
    );
    const css = el.querySelector('style')?.textContent ?? '';
    expect(css).toContain(`url("${ORIGIN}/blog/f.woff")`);
    // 文档内的 `#filter` 引用不是地址，别当相对路径解析掉
    expect(css).toContain('url(#filter)');
  });

  it('站点源末尾多写的斜杠不会拼出 `//api/...`', () => {
    const el = holder('<img src="/api/images/abcdefghij/raw">');
    absolutizeSiteUrls(el, `${ORIGIN}///`);
    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      `${ORIGIN}/api/images/abcdefghij/raw`
    );
  });
});

describe('纯 #锚点链接在导出件里就地跳', () => {
  it('★ 摘掉 target / rel；真正的外链保留 target ★', () => {
    const el = holder(
      '<a href="#第二节" target="_blank" rel="noopener noreferrer">跳到第二节</a>' +
        '<a href="https://other.test/x" target="_blank" rel="noopener noreferrer">外站</a>'
    );
    localizeFragmentLinks(el);
    const [frag, outside] = Array.from(el.querySelectorAll('a'));
    expect(frag.getAttribute('target')).toBeNull();
    expect(frag.getAttribute('rel')).toBeNull();
    // 外链**不动** —— 新窗口打开是它本来该有的行为
    expect(outside.getAttribute('target')).toBe('_blank');
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
    const html = buildExportHtml({ title: 'a<b>&"c', bodyHtml: '<p>x</p>', base: ORIGIN });
    expect(html).toContain('<title>a&lt;b&gt;&amp;&quot;c</title>');
  });

  it('★ 不写 `<base>` ★ —— 写它会顺手把 `#锚点` 也带回原站', () => {
    const html = buildExportHtml({ title: 't', bodyHtml: '<a href="#s">s</a>', base: ORIGIN });
    expect(html).not.toContain('<base');
    expect(html).toContain('href="#s"');
  });

  it('正文包在 .blog-content-container 里（与文章页同一套版式）', () => {
    const html = buildExportHtml({ title: 't', bodyHtml: '<p>hello</p>', base: ORIGIN });
    expect(html).toContain('<div class="blog-content-container">');
    expect(html).toContain('<p>hello</p>');
  });

  it('★ `<style>` 里站内相对的 url(/…) 也补成绝对地址（MathJax 的字体表就是这种形态）★', () => {
    const style = document.createElement('style');
    style.setAttribute('data-test', '1');
    style.textContent = '@font-face{src:url("/static/mathjax/woff-v2/MathJax_Main-Regular.woff")}'
      + '.x{background:url(/static/bg.png)}';
    document.head.appendChild(style);

    const html = buildExportHtml({ title: 't', bodyHtml: '', base: ORIGIN });
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
        base: ORIGIN,
      })
    );
    const { spy, frame } = capturePrint();
    const img = frame.contentDocument!.querySelector('img')!;

    await vi.advanceTimersByTimeAsync(50);
    expect(spy, '图还在路上就打印了 —— 打出来是个空白框').not.toHaveBeenCalled();

    // 图到了：两帧让布局发生、两帧收尾，之后就该打印
    img.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(150);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('★ 字体必须排在样式与布局之后等：布局之前的 fonts.ready 是个空等待 ★', async () => {
    // 这一条盯的是**顺序**，而不是「等到了没有」。
    // 刚 doc.write 完的那一瞬间样式表还没解析，也就没有 @font-face、没有任何字体请求
    // —— 此时 `fonts.ready` 是个**已经兑现**的 Promise，`await` 一下就过去了。
    // 于是「等字体」这件事看着做了，实际一个字体都没等：MathJax 的公式会用回退字体
    // 打出错误字形与间距，而页面上没有任何提示。
    vi.useFakeTimers();
    printHtml(
      buildExportHtml({
        title: 't',
        bodyHtml: '<img src="https://example.test/never.png">',
        base: ORIGIN,
      })
    );
    const { spy, frame } = capturePrint();
    const doc = frame.contentDocument!;

    // 把 fonts 换成一个「读到就记一笔、由用例决定何时兑现」的桩（jsdom 本来没有它）
    const reads: number[] = [];
    let resolveFonts: (() => void) | null = null;
    Object.defineProperty(doc, 'fonts', {
      configurable: true,
      get() {
        reads.push(Date.now());
        return {
          ready: new Promise<void>((resolve) => {
            resolveFonts = resolve;
          }),
        };
      },
    });

    // 样式 / 图片都还在路上：这时候**不该**去读 fonts.ready
    await vi.advanceTimersByTimeAsync(200);
    expect(reads, '布局都还没发生就去读 fonts.ready 了 —— 那是个空等待').toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    // 图到了 → 布局发生 → 这才轮到字体
    doc.querySelector('img')!.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(200);
    expect(reads.length, '布局之后没有去等字体').toBe(1);
    expect(spy, '字体还在路上就打印了').not.toHaveBeenCalled();

    resolveFonts!();
    await vi.advanceTimersByTimeAsync(100);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('★ 资源一直不来也不吊死：到上限照打 ★', async () => {
    vi.useFakeTimers();
    printHtml(
      buildExportHtml({
        title: 't',
        // 图片永远不 load，样式表永远不 load（jsdom 里两者本来就不会自己完成）
        bodyHtml: '<img src="https://example.test/never.png">',
        base: ORIGIN,
      })
    );
    const { spy } = capturePrint();

    await vi.advanceTimersByTimeAsync(PRINT_READY_MAX_MS - 100);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(spy, '资源卡住时打印跟着卡住了').toHaveBeenCalledTimes(1);
  });

  it('★ rAF 不回调（后台标签页）也必须有界：预算到点照样打印 ★', async () => {
    // 真机上「点了打印没反应」最像的一种：页面在**后台标签页**（或被切走、被藏起来），
    // 而 `requestAnimationFrame` 在后台根本不回调。那几帧若不在总预算里，`print()`
    // 就永远不执行 —— 屏幕上什么都不会说，用户只会再点一次。
    // 这里让 rAF 彻底不回，把「有界」这件事单独钉住。
    vi.useFakeTimers();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      printHtml(
        buildExportHtml({
          title: 't',
          bodyHtml: '<img src="https://example.test/never.png">',
          base: ORIGIN,
        })
      );
      const { spy } = capturePrint();

      await vi.advanceTimersByTimeAsync(PRINT_READY_MAX_MS - 100);
      expect(spy, '预算还没用完就打印了').not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(PRINT_READY_MAX_MS);
      expect(
        spy,
        'rAF 不回调时打印被吊死了 —— 后台标签页里点打印就是「没反应」'
      ).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
    }
  });

  it('打印完把 iframe 摘掉（否则每点一次留一个空文档挂在页面上）', async () => {
    vi.useFakeTimers();
    printHtml(
      buildExportHtml({
        title: 't',
        bodyHtml: '<img src="https://example.test/never.png">',
        base: ORIGIN,
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
