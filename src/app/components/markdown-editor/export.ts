// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/export.ts —— HTML 导出与浏览器打印（PDF）
//
// 【导出的是什么】预览面板**已经渲染好的那棵 DOM**，不是再跑一遍 Markdown。
// 于是导出件与屏幕上看到的是同一份东西（含公式、代码高亮、引用展开），不存在
// 「预览对了、导出不对」这种要两头对账的情况。
//
// 【样式怎么带过去】把当前文档 head 里的样式表**原样抄一份绝对地址**进去：
//   · `<link rel=stylesheet>` → 用 `.href`（浏览器已经解析成绝对地址）；
//   · `<style>`（Next 注入的、hljs 双主题、MathJax 的 CHTML 字体表）→ outerHTML。
// 比在客户端重新内联一遍 CSS 可靠：那份 CSS 里带 hashed 文件名与 `@font-face`
// 相对路径，自己拼必然漏。代价是导出的文件**需要联网**才能取到样式 ——
// 这是**刻意的**取舍（内联一份完整 CSS 要自己维护字体与图片的相对路径），
// 不是没做完；导出件在离线打开时是「有内容、没版式」，正文一个字都不少。
//
// 【公式】MathJax 已经渲染成 CHTML（内联样式 + head 里的字体表），所以把 `<style>`
// 抄过去就够了，导出件里**不需要**再加载 MathJax。
// ─────────────────────────────────────────────────────────────────────────────

/** 把 head 里的样式抄成一段可以直接放进导出件的标记。 */
function collectStyleMarkup(): string {
  const parts: string[] = [];
  for (const node of Array.from(
    document.head.querySelectorAll('link[rel="stylesheet"], style')
  )) {
    if (node.tagName === 'LINK') {
      const href = (node as HTMLLinkElement).href;
      if (href) parts.push(`<link rel="stylesheet" href="${href}">`);
    } else {
      parts.push(node.outerHTML);
    }
  }
  return parts.join('\n');
}

/** HTML 文本转义 —— 只用于标题（正文 HTML 是我们自己的渲染产物，不再转义）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ExportOptions {
  /** 文档标题（进 `<title>` 与导出文件名）。 */
  title: string;
  /** 预览面板的 innerHTML。 */
  bodyHtml: string;
}

/**
 * 拼一份可独立打开的 HTML。
 *
 * `body` 的形状沿用文章页（`.blog-content-container` 提供阅读版式），
 * 于是导出件在浏览器里打开的观感与站内文章页一致。
 */
export function buildExportHtml({ title, bodyHtml }: ExportOptions): string {
  const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${collectStyleMarkup()}
</head>
<body>
<main class="blog-content-container-container">
<div class="blog-content-container">
${bodyHtml}
</div>
</main>
</body>
</html>
`;
}

/**
 * 文件名里不能出现的字符替换成 `-`。取 Windows 与 POSIX 两批禁用字符的并集
 * （反斜杠 / 斜杠 / 冒号 / 星号 / 问号 / 引号 / 尖括号 / 竖线），空白与控制字符
 * 一并去掉 —— 标题是从服务端原文来的，里头可能真有换行与制表符；而导出件多半要
 * 靠邮件 / 聊天转手，名字里带空格会被转义成一串 %20。
 */
export function safeFilename(title: string, fallback = 'document'): string {
  const cleaned = title
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** 触发一次下载。用 Blob + 临时 `<a>`，不发任何请求。 */
export function downloadHtml(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及取到内容，下一轮任务再释放
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 用隐藏 iframe 打印 —— 不 `window.open`，因此**不会被弹窗拦截**。
 *
 * iframe 的 onload 在 `document.write` 这条路径上并不可靠（内容同步写完时事件早已
 * 错过），所以固定等一小段时间让样式表落地再调 print；打印完把 iframe 摘掉，
 * 否则每点一次就留一个空文档挂在页面上。
 */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      // 给打印对话框一点时间取走文档再摘
      setTimeout(() => frame.remove(), 1000);
    }
  }, 150);
}
