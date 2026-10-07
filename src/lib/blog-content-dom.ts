// ─────────────────────────────────────────────────────────────────────────────
// blog-content-dom.ts — 博客 / 剪贴板正文**挂载后**的 DOM 后处理
//
// 管线的最后一步（源文侧见 content-ref-processor.ts / blog-renderer.ts）：
// 代码块「复制」按钮、外链加固、图片点击放大、投票嵌入小组件、MathJax 排版。
// 输入是已挂载、已净化（DOMPurify）的容器元素。
//
// 【interactive：正文交互与只读预览的唯一分叉】
//   · true（默认，正文页）—— 投票小组件绑定选中 / 提交处理器，同站链接就地跳转。
//   · false（编辑器完整预览）—— 共享**同一份**投票展示结构但不绑提交处理器
//     （选项按钮 disabled，见 blog-markdown.ts），且**所有**链接一律新窗口打开：
//     预览嵌在编辑页里，同站链接就地跳转会当场丢掉未发布的草稿。
//   除此之外两种模式逐字节一致 —— 复制按钮、图片放大、MathJax 都照常。
//   别为了预览再抄一份「静态版」后处理：分叉只许从 `interactive` 这一个参数出去。
//
// 【生命周期】后处理把处理器直接绑在容器内的节点上，不返回清理函数 ——
// 调用方重渲染时整块子树被 React 丢弃，监听器随节点一起回收。唯一的例外是
// 图片放大遮罩：它挂在 document.body 上、点一下自己移除，与正文页现状一致。
//
// 单测：tests/unit/blog-content-dom.test.ts（jsdom）。
// ─────────────────────────────────────────────────────────────────────────────

import { renderVoteEmbed } from '@/lib/blog-markdown';

// ── MathJax：模块化 mathjax-full（CHTML 输出），page-lifetime 单例─────────────
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { CHTML } from 'mathjax-full/js/output/chtml.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js';

interface TypesetContext {
  ready: boolean;
  tex?: TeX<any, any, any>;
  chtml?: CHTML<any, any, any>;
}

// 跨调用方（正文页 / 编辑器预览）复用 mathjax 句柄链。第一次见到数学公式时懒初始化。
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

export interface BlogContentDomOptions {
  /** 见文件头「interactive」。默认 true（正文页行为）。 */
  interactive?: boolean;
  /** 公式条数（renderBlogMarkdown 的返回值），>0 才跑 MathJax。 */
  mathCount?: number;
}

/**
 * 对挂载好的正文容器跑全部 DOM 后处理。重复调用安全（投票位用
 * `data-rendered` 去重；复制 / 图片的 onclick 是赋值不是叠加）。
 */
export function enhanceBlogContent(root: HTMLElement, options: BlogContentDomOptions = {}): void {
  const interactive = options.interactive ?? true;

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
      } else if (!interactive) {
        // 只读预览：同站链接也一律新窗口 —— 就地跳转会丢掉编辑器里未发布的草稿。
        a.setAttribute('rel', 'noopener noreferrer');
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
  // 只读预览（interactive=false）共享同一份构造，但不绑提交处理器。
  root.querySelectorAll<HTMLElement>('.vote-embed[data-vote-id]').forEach((el) => {
    if (el.dataset.rendered) return;
    el.dataset.rendered = '1';
    void renderVoteEmbed(el, el.getAttribute('data-vote-id'), { interactive });
  });

  // MathJax 数学公式。判据是抽取阶段的公式计数，而不是在渲染后的 HTML 上
  // 正则嗅探 —— 跨行块级公式（cases/aligned）用 `\$[^$\n]+\$` 嗅不出来，
  // 一漏就是整页公式全不排版（历史 bug，见 markdown-math.ts）。
  if ((options.mathCount ?? 0) > 0) {
    typesetMath(root);
  }
}
