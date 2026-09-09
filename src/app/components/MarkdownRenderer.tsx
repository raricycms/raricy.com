'use client';

// 博客正文客户端渲染：marked + DOMPurify + highlight.js（对齐 Flask markdown_renderer.js）。
// 额外对齐（本波）：
//   • 内容引用预处理（[@id]）：8位→剪贴板正文内联 / 9位→投票嵌入 / 10位→图床图片。
//   • MathJax：行内 $..$ / \(..\)、块级 $$..$$ / \[..\]、mhchem（mathjax-full 模块化 API）。
//   • 代码高亮亮/暗双主题随 data-theme 切换（github / monokai，media 切换，对齐原站）。
//   • 代码块「复制」按钮、图片点击放大、外链 target=_blank 加固、任务列表 checkbox。
import { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { CHTML } from 'mathjax-full/js/output/chtml.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { BLOG_SANITIZE_OPTIONS, isValidVoteId, renderVoteFallback } from '@/lib/blog-markdown';

// ── 内容引用预处理器（对齐 clipboard-processor.js，端点改为 Next API）───────────
class ContentRefProcessor {
  private cache = new Map<string, { type: string; content?: string; error?: boolean; id?: string; url?: string }>();
  private MAX_ITEMS = 50;

  async preprocess(markdownContent: string): Promise<string> {
    const pattern = /\[@\s*(\w+)\s*\]/g;
    const matches = [...markdownContent.matchAll(pattern)];
    if (matches.length === 0) return markdownContent;

    const clipboardIds = new Set<string>();
    const voteIds = new Set<string>();
    const imageIds = new Set<string>();
    for (const m of matches) {
      const id = m[1];
      if (id.length === 8) clipboardIds.add(id);
      else if (id.length === 9) voteIds.add(id);
      else if (id.length === 10) imageIds.add(id);
    }

    const clipboardFetches = [...clipboardIds]
      .filter((id) => !this.cache.has(id))
      .map(async (id) => {
        try {
          const res = await fetch(`/api/clipboard/${id}`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error('failed');
          const data = await res.json();
          this.cache.set(id, { type: 'clipboard', content: data.clip?.content ?? data.content ?? '' });
        } catch {
          this.cache.set(id, { type: 'clipboard', content: `[剪贴板 ${id} 加载失败]` });
        }
      });

    const voteFetches = [...voteIds]
      .filter((id) => !this.cache.has(id))
      .map(async (id) => {
        try {
          const res = await fetch(`/api/votes/${id}`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error('failed');
          await res.json();
          this.cache.set(id, { type: 'vote' });
        } catch {
          this.cache.set(id, { type: 'vote', error: true, id });
        }
      });

    for (const id of imageIds) {
      if (!this.cache.has(id)) this.cache.set(id, { type: 'image', url: `/api/images/${id}/raw` });
    }

    await Promise.all([...clipboardFetches, ...voteFetches]);

    let processed = markdownContent;
    let count = 0;
    for (const [fullMatch, id] of matches) {
      if (count >= this.MAX_ITEMS) break;
      const cached = this.cache.get(id);
      if (!cached) continue;
      let replacement: string;
      if (cached.type === 'clipboard') replacement = cached.content ?? '';
      else if (cached.type === 'vote') {
        replacement = cached.error
          ? `<a href="/vote/${cached.id}">[投票 ${cached.id} 加载失败，点击查看]</a>`
          : `<div class="vote-embed" data-vote-id="${id}"></div>`;
      } else if (cached.type === 'image') replacement = `![${id}](${cached.url})`;
      else continue;
      processed = processed.replace(fullMatch, () => replacement);
      count++;
    }
    return processed;
  }
}

// ── hljs 双主题 CSS（对齐原站 blog/clipboard：亮=github，暗=monokai）─────────────
// 说明：highlight.js 的两套主题 CSS 都作用于全局 .hljs，若同时生效会互相覆盖。
// 因此内联为两个 <style>，仅让匹配当前 data-theme 的一份生效（另一份 media='not all'
// 彻底禁用），并用 MutationObserver 监听 documentElement[data-theme] 切换。
// 内联而非静态 import / 外链，保证组件自包含、暗色代码块必定走暗色高亮。
const HLJS_GITHUB_CSS =
  'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}' +
  '.hljs{color:#24292e;background:#fff}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}.hljs-built_in,.hljs-symbol{color:#e36209}.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}.hljs-subst{color:#24292e}.hljs-section{color:#005cc5;font-weight:700}.hljs-bullet{color:#735c0f}.hljs-emphasis{color:#24292e;font-style:italic}.hljs-strong{color:#24292e;font-weight:700}.hljs-addition{color:#22863a;background-color:#f0fff4}.hljs-deletion{color:#b31d28;background-color:#ffeef0}';
const HLJS_MONOKAI_CSS =
  'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}' +
  '.hljs{background:#272822;color:#ddd}.hljs-keyword,.hljs-literal,.hljs-name,.hljs-number,.hljs-selector-tag,.hljs-strong,.hljs-tag{color:#f92672}.hljs-code{color:#66d9ef}.hljs-attr,.hljs-attribute,.hljs-link,.hljs-regexp,.hljs-symbol{color:#bf79db}.hljs-addition,.hljs-built_in,.hljs-bullet,.hljs-emphasis,.hljs-section,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-string,.hljs-subst,.hljs-template-tag,.hljs-template-variable,.hljs-title,.hljs-type,.hljs-variable{color:#a6e22e}.hljs-class .hljs-title,.hljs-title.class_{color:#fff}.hljs-comment,.hljs-deletion,.hljs-meta,.hljs-quote{color:#75715e}.hljs-doctag,.hljs-keyword,.hljs-literal,.hljs-section,.hljs-selector-id,.hljs-selector-tag,.hljs-title,.hljs-type{font-weight:700}';

function useHljsThemeStyles() {
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

// ── MathJax：模块化 mathjax-full（CHTML 输出），page-lifetime 单例─────────────
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js';

interface TypesetContext {
  ready: boolean;
  tex?: TeX<any, any, any>;
  chtml?: CHTML<any, any, any>;
}

// 跨 MarkdownRenderer 实例复用 mathjax 句柄链。第一次见到数学公式时懒初始化。
const typesetCtx: TypesetContext = { ready: false };

function ensureMathJax(): TypesetContext {
  if (typesetCtx.ready) return typesetCtx;
  // RegisterHTMLHandler 内部已把 HTMLHandler 注册到 mathjax.handlers；
  // TeX / CHTML 不属 Handler，要走 mathjax.document({ InputJax, OutputJax })。
  RegisterHTMLHandler(browserAdaptor());
  typesetCtx.tex = new TeX({
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    processEscapes: true,
    processEnvironments: true,
    packages: AllPackages,
    macros: {
      RR: '\\mathbb{R}', NN: '\\mathbb{N}', ZZ: '\\mathbb{Z}', QQ: '\\mathbb{Q}',
      CC: '\\mathbb{C}', PP: '\\mathbb{P}', EE: '\\mathbb{E}', FF: '\\mathbb{F}',
    },
  });
  // ⚠️ 只传 mathjax-full 3.x 认得的选项。enableMenu/fontCache 是 v4 才有的
  // 配置，写在 3.2.2 上只会得到两条 Invalid option 警告且配置不生效。
  typesetCtx.chtml = new CHTML();
  typesetCtx.ready = true;
  return typesetCtx;
}

function typesetMath(root: HTMLElement): void {
  const ctx = ensureMathJax();
  if (!ctx.tex || !ctx.chtml) return;
  try {
    // ⚠️ 绝不能把页面上的容器传给 mathjax.document(元素) —— 它会把传入元素
    // **搬进一个新建的空文档**（脱离页面），正文会整体从原位置消失（详情页
    // 正文渲染为空的根因）。正确用法：在全局 document 上建实例，用
    // findMath({ elements: [root] }) 把扫描限定在本容器内，updateDocument 把
    // mjx-container 就地写回，其余 DOM 与已绑定的事件一概不动。
    const mathDocument = mathjax.document(document, {
      InputJax: ctx.tex,
      OutputJax: ctx.chtml,
    });
    mathDocument.findMath({ elements: [root] }).compile().getMetrics().typeset().updateDocument();
  } catch {
    // 公式语法错误时静默保留原文，不影响页面其他内容
  }
}

export default function MarkdownRenderer({ content }: { content: string }) {
  const [html, setHtml] = useState('');
  const [ready, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useHljsThemeStyles();

  // 渲染 markdown → 安全 HTML（含内容引用预处理 + 数学公式占位保护）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let text = await new ContentRefProcessor().preprocess(content ?? '');

      // 保护数学公式，避免被 Markdown 破坏
      const placeholders: Record<string, string> = {};
      let n = 0;
      text = text.replace(/\$\$([\s\S]*?)\$\$/g, (m) => { const p = `MATHBLOCK${n++}PLACEHOLDER`; placeholders[p] = m; return p; });
      text = text.replace(/\\\[([\s\S]*?)\\\]/g, (m) => { const p = `MATHLATEXB${n++}PLACEHOLDER`; placeholders[p] = m; return p; });
      text = text.replace(/\$([^$\n]+?)\$/g, (m) => { const p = `MATHINLINE${n++}PLACEHOLDER`; placeholders[p] = m; return p; });
      text = text.replace(/\\\(([\s\S]*?)\\\)/g, (m) => { const p = `MATHLATEXI${n++}PLACEHOLDER`; placeholders[p] = m; return p; });

      // marked 实例（gfm 任务列表原生支持）+ 自定义代码块渲染（高亮 + 复制按钮）。
      // 外链 target=_blank / rel 加固在渲染后的 DOM 后处理里统一完成。
      const m = new Marked({ gfm: true, breaks: true });
      m.use({
        renderer: {
          code({ text: code, lang }: { text: string; lang?: string }) {
            let highlighted: string;
            try {
              highlighted =
                lang && hljs.getLanguage(lang)
                  ? hljs.highlight(code, { language: lang }).value
                  : hljs.highlightAuto(code).value;
            } catch {
              highlighted = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
            return `<div class="highlight"><pre><code class="hljs">${highlighted}</code></pre><button class="copy-btn" data-code="${encodeURIComponent(code)}">复制</button></div>`;
          },
        },
      });

      let out = m.parse(text, { async: false }) as string;
      Object.keys(placeholders).forEach((p) => { out = out.replace(new RegExp(p, 'g'), placeholders[p]); });

      // 白名单是安全边界，集中定义在 src/lib/blog-markdown.ts（改动请同步其单测）。
      const clean = DOMPurify.sanitize(out, BLOG_SANITIZE_OPTIONS);
      if (!cancelled) { setHtml(clean); setReady(true); }
    })();
    return () => { cancelled = true; };
  }, [content]);

  // 渲染后处理：代码高亮、复制按钮、图片放大、外链加固、投票嵌入、MathJax
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !html) return;

    // 复制按钮
    root.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach((btn) => {
      btn.onclick = () => {
        const codeText = decodeURIComponent(btn.getAttribute('data-code') || '');
        const done = () => {
          const orig = btn.textContent;
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(codeText).then(done).catch(done);
        else done();
      };
    });

    // 外链加固
    root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      try {
        const url = new URL(href, window.location.origin);
        const proto = url.protocol.toLowerCase();
        const isHttp = proto === 'http:' || proto === 'https:';
        if (!(isHttp || proto === 'mailto:' || proto === 'tel:')) { a.removeAttribute('href'); return; }
        if (isHttp && url.origin !== window.location.origin) {
          a.setAttribute('rel', 'noopener noreferrer nofollow');
          a.setAttribute('target', '_blank');
        }
      } catch { a.removeAttribute('href'); }
    });

    // 图片点击放大
    root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      img.style.cursor = 'pointer';
      img.onclick = () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;background:rgba(0,0,0,.8);display:flex;justify-content:center;align-items:center;z-index:9999;cursor:pointer;';
        const z = img.cloneNode() as HTMLImageElement;
        z.style.cssText = 'max-width:90%;max-height:90%;object-fit:contain;border-radius:8px;';
        overlay.appendChild(z);
        overlay.onclick = () => document.body.removeChild(overlay);
        document.body.appendChild(overlay);
      };
    });

    // 投票嵌入：拉取投票数据，渲染结果条（对齐 vote-embed.js 的只读结果视图）
    root.querySelectorAll<HTMLElement>('.vote-embed[data-vote-id]').forEach((el) => {
      if (el.dataset.rendered) return;
      const vid = el.getAttribute('data-vote-id');
      if (!vid) return;
      // ★ 安全边界：data-vote-id 来自用户 Markdown（攻击者可控），见 src/lib/blog-markdown.ts。
      // 校验不过就整个放弃 —— 不 fetch、不渲染，避免它被当成 URL 片段或 HTML 使用。
      if (!isValidVoteId(vid)) { el.textContent = '[投票链接无效]'; return; }
      el.dataset.rendered = '1';
      el.textContent = '加载投票…';
      fetch(`/api/votes/${vid}`, { credentials: 'same-origin' })
        .then((r) => r.json())
        .then((data) => {
          if (data.code !== 200 || !data.data) { renderVoteFallback(el, vid); return; }
          const v = data.data as { title: string; total_votes: number; user_voted: number | null; options: { id: number; label: string; count: number; percentage: number }[] };
          const rows = v.options.map((o) => {
            const mine = v.user_voted === o.id;
            return `<div class="vote-embed-option vote-embed-option--result${mine ? ' vote-embed-option--voted' : ''}"><div class="vote-embed-bar" style="width:${o.percentage}%"></div><div class="vote-embed-option-content"><span class="vote-embed-option-label">${escapeHtml(o.label)}</span><span class="vote-embed-option-stats">${o.count} 票 · ${o.percentage}%</span></div></div>`;
          }).join('');
          el.innerHTML = `${rows}<p class="vote-embed-total">共 ${v.total_votes} 票</p>`;
        })
        .catch(() => renderVoteFallback(el, vid));
    });

    // MathJax 数学公式
    const hasMath = /\$\$|\\\[|\\\]|\$[^$\n]+\$|\\\(|\\\)/.test(root.innerHTML);
    if (hasMath) {
      typesetMath(root);
    }
  }, [html]);

  return (
    <div className="blog-content-container-container">
      {ready ? (
        <div
          ref={containerRef}
          className="blog-content-container"
          id="userContentContainer"
          // 已经 DOMPurify 净化
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div
          className="blog-content-container"
          id="userContentContainer"
          ref={containerRef}
        >
          <div id="loading-indicator" className="text-center my-4">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">加载中...</span>
            </div>
            <p className="mt-2">正在加载内容...</p>
          </div>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
