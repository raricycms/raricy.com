// ─────────────────────────────────────────────────────────────────────────────
// useHljsThemeStyles.ts — highlight.js 亮 / 暗双主题 CSS 的挂载 hook
//
// 说明：highlight.js 的两套主题 CSS 都作用于全局 .hljs，若同时生效会互相覆盖。
// 因此内联为两个 <style>，仅让匹配当前 data-theme 的一份生效（另一份 media='not all'
// 彻底禁用），并用 MutationObserver 监听 documentElement[data-theme] 切换。
// 内联而非静态 import / 外链，保证组件自包含、暗色代码块必定走暗色高亮。
//
// 【多个实例并存】两份 <style> 按固定 id 全局单例（已存在就复用），每个实例
// 各挂一个 MutationObserver、卸载时只断开自己的那个。**样式元素从不移除** ——
// 一个实例卸载时摘掉 <style> 会把还在页上的其他实例（正文页 + 编辑器预览
// 同屏是常态）的代码块瞬间打回无高亮。
//
// 调用方：MarkdownRenderer（正文与编辑器预览都经它渲染）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';

const HLJS_GITHUB_CSS =
  'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}' +
  '.hljs{color:#24292e;background:#fff}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}.hljs-built_in,.hljs-symbol{color:#e36209}.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}.hljs-subst{color:#24292e}.hljs-section{color:#005cc5;font-weight:700}.hljs-bullet{color:#735c0f}.hljs-emphasis{color:#24292e;font-style:italic}.hljs-strong{color:#24292e;font-weight:700}.hljs-addition{color:#22863a;background-color:#f0fff4}.hljs-deletion{color:#b31d28;background-color:#ffeef0}';
const HLJS_MONOKAI_CSS =
  'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}' +
  '.hljs{background:#272822;color:#ddd}.hljs-keyword,.hljs-literal,.hljs-name,.hljs-number,.hljs-selector-tag,.hljs-strong,.hljs-tag{color:#f92672}.hljs-code{color:#66d9ef}.hljs-attr,.hljs-attribute,.hljs-link,.hljs-regexp,.hljs-symbol{color:#bf79db}.hljs-addition,.hljs-built_in,.hljs-bullet,.hljs-emphasis,.hljs-section,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-string,.hljs-subst,.hljs-template-tag,.hljs-template-variable,.hljs-title,.hljs-type,.hljs-variable{color:#a6e22e}.hljs-class .hljs-title,.hljs-title.class_{color:#fff}.hljs-comment,.hljs-deletion,.hljs-meta,.hljs-quote{color:#75715e}.hljs-doctag,.hljs-keyword,.hljs-literal,.hljs-section,.hljs-selector-id,.hljs-selector-tag,.hljs-title,.hljs-type{font-weight:700}';

export function useHljsThemeStyles(): void {
  useEffect(() => {
    const ensure = (id: string, css: string) => {
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        el.textContent = css;
        document.head.appendChild(el);
      }
      return el;
    };
    const light = ensure('hljs-theme-light', HLJS_GITHUB_CSS);
    const dark = ensure('hljs-theme-dark', HLJS_MONOKAI_CSS);
    const sync = () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      // media='not all' → 该 <style> 不生效；只保留匹配当前主题的一份。
      light.media = isDark ? 'not all' : 'all';
      dark.media = isDark ? 'all' : 'not all';
    };
    sync();
    const obs = new MutationObserver((muts) => {
      muts.forEach((m) => m.attributeName === 'data-theme' && sync());
    });
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, []);
}
