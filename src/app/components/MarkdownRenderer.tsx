'use client';

// 博客正文客户端渲染：marked + DOMPurify + highlight.js。
// 额外处理：
//   • 内容引用预处理（[@id]）：8位→剪贴板正文内联 / 9位→投票嵌入 / 10位→图床图片 /
//     6位→收藏夹卡片（**只在这条管线上**：评论与讨论走 rich-text.ts，那边刻意不认 6 位，
//     与 9 位投票「只识别不展开」同向）。
//   • MathJax：行内 $..$ / \(..\)、块级 $$..$$ / \[..\]、mhchem（mathjax-full 模块化 API）。
//   • 代码高亮亮/暗双主题随 data-theme 切换（github / monokai，media 切换）。
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
import { BLOG_SANITIZE_OPTIONS, renderVoteEmbed } from '@/lib/blog-markdown';
import { protectMath, restoreMath } from '@/lib/markdown-math';
import {
  MAX_CARD_ITEMS,
  buildFavoriteCardHtml,
  collectFavoriteRefs,
  favoriteFailureText,
  isFavoriteId,
  replaceFavoriteRefs,
} from '@/lib/favorite-refs';

// ── 内容引用预处理器（端点走 Next API）────────────────────────────────────────
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
    const favoriteIds = new Set<string>();
    for (const m of matches) {
      const id = m[1];
      if (id.length === 8) clipboardIds.add(id);
      else if (id.length === 9) voteIds.add(id);
      else if (id.length === 10) imageIds.add(id);
      // 6 位是收藏夹。用白名单判定（`^[0-9]{6}$`）而不是「长度 === 6」——
      // 6 位字母/下划线的 token 必须落回字面量，不要去请求一次不存在的资源。
      else if (isFavoriteId(id)) favoriteIds.add(id);
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

    // 收藏夹：拉 spider 那条公开读路径（**需 core+**）。本组件目前的两个调用点
    // （博客详情、剪贴板详情）都在 requireCoreUser() 之后，而这次 fetch 带
    // same-origin 凭据，所以会话一定在 —— 若将来把它用在匿名页面上，这里会 401。
    // 拿到就直接拼成卡片 HTML 存进 cache。取不到（不存在 / 私密 / 已软删 / 网络错误）
    // 一律降级成失败文案，静默不抛 —— 调用方是 `void`。
    const favoriteFetches = [...favoriteIds]
      .filter((id) => !this.cache.has(id))
      .map(async (id) => {
        try {
          const res = await fetch(`/api/spider/favorites/${id}`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error('failed');
          const data = await res.json();
          this.cache.set(id, {
            type: 'favorite',
            content: buildFavoriteCardHtml({
              id,
              title: typeof data.title === 'string' ? data.title : '',
              count: typeof data.count === 'number' ? data.count : 0,
              author: typeof data.author === 'string' ? data.author : undefined,
              blogs: Array.isArray(data.blogs)
                ? data.blogs
                    .filter((b: unknown): b is { id: string; title: string } => {
                      const o = b as { id?: unknown; title?: unknown };
                      return typeof o?.id === 'string' && typeof o?.title === 'string';
                    })
                    .slice(0, MAX_CARD_ITEMS)
                : [],
            }),
          });
        } catch {
          this.cache.set(id, { type: 'favorite', content: favoriteFailureText(id) });
        }
      });

    await Promise.all([...clipboardFetches, ...voteFetches, ...favoriteFetches]);

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

    // ── 收藏夹卡片：**最后单独一趟**，且**按区间切片**而不是 replace ─────────────
    //
    // 两个「为什么」：
    //   · 为什么放在最后：上面那个循环用的是 `processed.replace(fullMatch, …)`
    //     （按内容搜索，不是按位置）。卡片 HTML 里含博客标题（不可信输入），标题里
    //     若正好有 `[@8位]` 字样，那个循环会命中**插入内容里的那处** —— 也正是
    //     content-refs.ts 里 replaceClipboardRef 改写成区间切片的原因。放在它后面做，
    //     并且此后不再有任何扫描，插入的卡片就不可能被二次解释。
    //   · 为什么重新扫一遍而不是复用上面的 matches：上面的循环已经改写过
    //     `processed`，那批下标对应的是**原始**字符串，长度变了就不成立了。
    //     这里对着当前字符串重新取一次位置，切片才是准的。
    const slots = collectFavoriteRefs(processed);
    if (slots.length > 0) {
      const htmlById = new Map<string, string>();
      for (const slot of slots) {
        const hit = this.cache.get(slot.id);
        if (hit?.type === 'favorite' && hit.content !== undefined) {
          htmlById.set(slot.id, hit.content);
        }
      }
      processed = replaceFavoriteRefs(processed, slots, htmlById);
    }

    return processed;
  }
}

// ── hljs 双主题 CSS（亮=github，暗=monokai）───────────────────────────────────
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
  //
  // fontURL 必须显式给绝对路径：默认值 `js/output/chtml/fonts/tex-woff-v2` 是
  // 相对路径，会按**当前页面**解析（/clipboard/xxx 下就变成 /clipboard/js/…），
  // 一律 404 —— 公式只能用回退字体渲染，字形与间距都不对。字体文件由
  // scripts/copy-mathjax-fonts.mjs 从 mathjax-full 拷到 public/static/mathjax/。
  typesetCtx.chtml = new CHTML({ fontURL: '/static/mathjax/woff-v2' });
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

export default function MarkdownRenderer({
  content,
  contentRefs,
}: {
  content: string;
  /**
   * 内容引用（`[@…]`）的处理方式。
   *
   *   · 'expand' —— 展开：带 same-origin 凭据去请求三条 core+ 接口（剪贴板正文 /
   *     投票嵌入 / 收藏夹卡片）+ 拼图床 URL。**只有 core+ 的页面能传这个。**
   *   · 'plain'  —— 原样保留 `[@…]` 字面量：一次请求都不发，不内联任何站内内容。
   *
   * **必传，没有默认值** —— 一个默认展开的组件一旦被用在匿名页面上，就是三条 401
   * 外加把站内内容渲染给站外读者看。文章详情页的访客视图传 'plain'。
   *
   * 【为什么是「原样保留字面量」而不是「换成一句提示」】评论区那条管线
   * （`src/lib/useResolvedContent.ts`）已经立过这个口径：「取不到时的样子（未登录 /
   * 非 core 读者）与加载中一致」，就显示 `[@abc12345]`。跟着它走，站内不会出现
   * 第三种「引用不可用」的观感；也不往不可信字符串里插入任何新文本，没有新的转义面。
   */
  contentRefs: 'expand' | 'plain';
}) {
  /** 渲染结果 + 抽出的公式数量（决定要不要跑 MathJax，见 markdown-math.ts）。 */
  const [doc, setDoc] = useState<{ html: string; mathCount: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useHljsThemeStyles();

  // 渲染 markdown → 安全 HTML（含内容引用预处理 + 数学公式占位保护）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let text =
        contentRefs === 'expand'
          ? await new ContentRefProcessor().preprocess(content ?? '')
          : (content ?? '');

      // 保护数学公式，避免被 Markdown 破坏（还原时的两个坑见 markdown-math.ts）
      const math = protectMath(text);
      text = math.text;

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
      out = restoreMath(out, math.placeholders);

      // 白名单是安全边界，集中定义在 src/lib/blog-markdown.ts（改动请同步其单测）。
      const clean = DOMPurify.sanitize(out, BLOG_SANITIZE_OPTIONS);
      if (!cancelled) setDoc({ html: clean, mathCount: math.count });
    })();
    return () => { cancelled = true; };
  }, [content, contentRefs]);

  // 渲染后处理：代码高亮、复制按钮、图片放大、外链加固、投票嵌入、MathJax
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !doc) return;

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

    // 投票嵌入：拉数据 → 渲染完整小组件（标题 / 可投票 / 结果视图 / 详情页入口）。
    // 构造与交互都在 src/lib/blog-markdown.ts —— 那里是安全边界（id 校验 + 只用 DOM API
    // 写入），并有 jsdom 单测钉住结构。data-vote-id 来自用户 Markdown，校验也在那边做。
    root.querySelectorAll<HTMLElement>('.vote-embed[data-vote-id]').forEach((el) => {
      if (el.dataset.rendered) return;
      el.dataset.rendered = '1';
      void renderVoteEmbed(el, el.getAttribute('data-vote-id'));
    });

    // MathJax 数学公式。判据是抽取阶段的公式计数，而不是在渲染后的 HTML 上
    // 正则嗅探 —— 跨行块级公式（cases/aligned）用 `\$[^$\n]+\$` 嗅不出来，
    // 一漏就是整页公式全不排版（历史 bug，见 markdown-math.ts）。
    if (doc.mathCount > 0) {
      typesetMath(root);
    }
  }, [doc]);

  return (
    <div className="blog-content-container-container">
      {doc ? (
        <div
          ref={containerRef}
          className="blog-content-container"
          id="userContentContainer"
          // 已经 DOMPurify 净化
          dangerouslySetInnerHTML={{ __html: doc.html }}
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
