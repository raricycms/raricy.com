// ─────────────────────────────────────────────────────────────────────────────
// blog-renderer.ts — 整篇 Markdown → 安全 HTML 的**唯一实现**
//
// 管线：protectMath（公式换占位符）→ marked（GFM + breaks，代码块过 hljs 并附
// 「复制」按钮）→ restoreMath（公式原文放回，转义）→ DOMPurify（白名单）。
// 引用预处理（`[@…]`）不在这里 —— 它在更上游的 content-ref-processor.ts，
// 出来的还是 Markdown 源文，再交给本函数。
//
// 【为什么必须只有这一份】正文页与编辑器预览若各走一套「看起来接近」的转换，
// 差异**不报错**（2026-09 评论区与博客表格渲染分叉就是这样）。正文页与编辑器
// 完整预览都必须调 `renderBlogMarkdown`；新增调用方不需要、也不允许另起管线。
// 净化白名单本身集中定义在 blog-markdown.ts（改它要同步其单测）。
//
// 同步函数：marked 以 { async: false } 解析。DOM 后处理（MathJax / 外链加固 /
// 图片放大 / 投票小组件）在 blog-content-dom.ts，那一步要跑在挂载后的节点上。
//
// 本模块不碰 fetch、不碰 React；DOMPurify 需要 DOM，单测用 jsdom 环境
// （tests/unit/blog-renderer.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { BLOG_SANITIZE_OPTIONS } from '@/lib/blog-markdown';
import { protectMath, restoreMath } from '@/lib/markdown-math';

export interface RenderedBlogDoc {
  /** 已过 DOMPurify 白名单（BLOG_SANITIZE_OPTIONS）的成品 HTML。 */
  html: string;
  /**
   * 抽取阶段拿到的公式条数。是否跑 MathJax 只能看它 —— 跨行块级公式
   * （cases/aligned）用 `\$[^$\n]+\$` 在成品 HTML 上嗅探不出来，一漏就是
   * 整页公式全不排版（历史 bug，见 markdown-math.ts 文件头）。
   */
  mathCount: number;
}

/**
 * 整篇渲染。入参应已过完引用预处理（content-ref-processor.ts）；
 * 公式保护与还原在这里完成，调用方不需要管。
 */
export function renderBlogMarkdown(text: string): RenderedBlogDoc {
  // 保护数学公式，避免被 Markdown 破坏（还原时的两个坑见 markdown-math.ts）
  const math = protectMath(text);

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
        // ★ `type="button"` 不是装饰 ★ 这段 HTML 也会被放进**表单里**（编辑器的
        // 只读预览整块挂在博客 / 剪贴板的 <form> 下，见 MarkdownEditor 的预览面板）。
        // 省略 type 的 <button> 默认是 submit，于是「填好必填字段 → 预览里点一下
        // 复制代码」会**顺手把整张表单提交掉**：博客那边当场发出去一篇文章、剪贴板
        // 那边做一次没打算做的保存，而复制本身看起来一切正常。
        // 白名单里保留了 `type` 属性（blog-markdown.ts 的 ALLOWED_ATTR），
        // 所以这个属性过得了 DOMPurify；单测与 e2e 各有断言盯着（见文件末注释）。
        return `<div class="highlight"><pre><code class="hljs">${highlighted}</code></pre><button type="button" class="copy-btn" data-code="${encodeURIComponent(code)}">复制</button></div>`;
      },
    },
  });

  let out = m.parse(math.text, { async: false }) as string;
  out = restoreMath(out, math.placeholders);

  // 白名单是安全边界，集中定义在 src/lib/blog-markdown.ts（改动请同步其单测）。
  return { html: DOMPurify.sanitize(out, BLOG_SANITIZE_OPTIONS), mathCount: math.count };
}
