// ─────────────────────────────────────────────────────────────────────────────
// vditor-theme.ts — 让 vditor 编辑器跟随站点 <html data-theme> 的深浅主题
//
// vditor 的主题是三条独立轨道，得分别接：
//   1. theme                   外壳（工具栏 / 边框 / 图标 / 输入区底色）→ .vditor--dark 类
//   2. preview.theme.current   正文排版（.vditor-reset 文字色、引用、表格）→ content-theme/*.css
//   3. 代码高亮                .hljs-* 配色 → <link id="vditorHljsStyle">
// 前两条走官方 setTheme(theme, contentTheme)；第三条见 syncHljsTheme 注释。
//
// 博客编辑（BlogForm）与云剪贴板编辑（UploadForm）共用本模块 —— 两边各自维护
// 一份的结果就是云剪贴板漏接主题，编辑器在暗色站点里始终是白的。
// 仅客户端调用（读 document）。
// ─────────────────────────────────────────────────────────────────────────────

import type Vditor from 'vditor';

// vditor 默认会从远端拉 icon sprite / 预览用 KaTeX；本仓把这些资源拷到
// public/static/vditor/，并把 cdn 指向这个本地路径，避免运行时依赖 unpkg。
export const VDITOR_LOCAL_CDN = '/static/vditor';

const HLJS_STYLE_ID = 'vditorHljsStyle';

// 亮/暗各取一套，跟文章页 MarkdownRenderer 保持同款（亮 github / 暗 monokai）。
// 两边都是全局作用于 .hljs 的，选同一套才不会互相盖 —— 编辑器逛完回文章页，
// 代码块配色不会被带跑。
const HLJS_THEME = { light: 'github', dark: 'monokai' } as const;

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

// vditor 自己的 setCodeTheme 拼的是 `${codeTheme}.css`，但 npm 包里只有
// `${codeTheme}.min.css` —— 给 setTheme 传第三个参数必 404，且它会先把原来的
// <link> remove 掉，结果是代码高亮全裸。所以这条轨道自己管：
// vditor 的 addStyle 按 id 去重，抢先插一个同 id 的 <link>，它就不会再插自己那份。
export function syncHljsTheme(dark: boolean): void {
  const name = dark ? HLJS_THEME.dark : HLJS_THEME.light;
  const href = `${VDITOR_LOCAL_CDN}/dist/js/highlight.js/styles/${name}.min.css`;
  let link = document.getElementById(HLJS_STYLE_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = HLJS_STYLE_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

// 该 <link> 挂在 head 上是全局的，留着会盖掉文章页 MarkdownRenderer 的 hljs 主题，
// 所以编辑器卸载时必须移除。
export function removeHljsTheme(): void {
  document.getElementById(HLJS_STYLE_ID)?.remove();
}

/** 当前主题下 new Vditor 该用的外壳 / 正文主题（供初始化时写进 options）。 */
export function vditorThemeOptions(dark: boolean): {
  theme: 'dark' | 'classic';
  contentTheme: 'dark' | 'light';
} {
  return { theme: dark ? 'dark' : 'classic', contentTheme: dark ? 'dark' : 'light' };
}

/** 站点主题变化时重设 vditor 三条轨道（代码高亮那条要先自己接管）。 */
export function applyVditorTheme(vditor: Vditor | null, dark: boolean): void {
  syncHljsTheme(dark);
  const { theme, contentTheme } = vditorThemeOptions(dark);
  // 只传前两个参数 —— 第三个 codeTheme 会 404，见 syncHljsTheme 注释
  vditor?.setTheme(theme, contentTheme);
}

/**
 * 监听 <html data-theme> 变化，返回取消订阅函数（编辑器卸载时调用）。
 * 初次订阅不会回调 —— 初始主题由调用方在 new Vditor 时应用。
 */
export function watchVditorTheme(onChange: (dark: boolean) => void): () => void {
  const observer = new MutationObserver(() => onChange(isDarkTheme()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}
