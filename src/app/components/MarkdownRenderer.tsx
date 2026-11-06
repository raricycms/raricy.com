'use client';

// 博客正文客户端渲染（**事故回退路径**）：组合四个共享模块，自身只管 React 生命周期
// 与挂载。正常阅读走 ReactiveMD（`reactive/read-render.ts`），只有
// `REACTIVE_MD_MODE=off` 下的 Markdown 文档才交给这里。
//   · 内容引用预处理（[@id]）：content-ref-processor.ts（整篇扫描 / 替换顺序 /
//     代码屏蔽 / 预算），取数走 content-ref-resolver.ts（两种模式 / 缓存）。
//     6 位收藏夹只在这条管线上：评论与讨论走 rich-text.ts，那边刻意不认 6 位，
//     与 9 位投票「只识别不展开」同向。
//   · 整篇渲染：blog-renderer.ts（protectMath → marked + hljs → restoreMath →
//     DOMPurify）。**没有第二套 Markdown → HTML 路径**。
//   · DOM 后处理：blog-content-dom.ts（复制按钮 / 外链加固 / 图片放大 /
//     投票小组件 / MathJax）。
//   · 代码高亮亮/暗双主题随 data-theme 切换：useHljsThemeStyles.ts。
//
// 【两种引用模式，不是「展开 / 不展开」】`contentRefs='expand'` 是站内成员视图，
// `'external'` 是对外视图。对外视图**也展开**，只是展开的范围小一圈：
// external 仅展开图床与音频；剪贴板、投票与收藏夹保留原文，不携带资源数据。
// 见 prop 上的说明与 docs/architecture.md §7.3。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContentRefProcessor } from '@/lib/content-ref-processor';
import { ContentRefResolver, type ContentRefMode } from '@/lib/content-ref-resolver';
import { renderBlogMarkdown } from '@/lib/blog-renderer';
import { enhanceBlogContent } from '@/lib/blog-content-dom';
import type { VoteEmbedData } from '@/lib/blog-markdown';
import { useHljsThemeStyles } from '@/app/components/useHljsThemeStyles';

export default function MarkdownRenderer({
  content,
  contentRefs,
  containerId = 'userContentContainer',
}: {
  content: string;
  /** 正文容器 id；内联剪贴板等嵌套实例必须传唯一值，避免页面出现重复 id。 */
  containerId?: string;
  /**
   * 内容引用（`[@…]`）的处理方式。**由服务端决定，不是客户端开关。**
   *
   *   · 'expand'   —— 站内成员视图：带 same-origin 凭据去请求三条 core+ 接口
   *     （剪贴板正文 / 投票嵌入 / 收藏夹卡片）+ 拼图床 URL + 音频播放器。
   *     **只有 core+ 的页面能传这个。**
   *   · 'external' —— 对外视图：只展开**匿名读口本来就取得到**的那几类 ——
   *     图床图片和音频播放器；剪贴板、投票与收藏夹保留原文。
   *     投票与收藏夹**保留字面量**（两者的读口都是 core+，而且那是站长定的口径：
   *     投票箱不进对外视图）。本模式**一个请求都不发**。
   *
   * **必传，没有默认值** —— 一个默认展开的组件一旦被用在匿名页面上，就是三条 401
   * 外加把站内内容渲染给站外读者看。文章详情页按 `isCore` 传（`blog/[id]/page.tsx`）。
   *
   * 【判据是「读口」，不是「是不是站内内容」】图片 / 音频的字节由 `/api/images|audio
   * /<id>/raw` 供，那两条路由**匿名可达、逐条判该不该给你**（私有档对无权者 404）；
   * 剪贴板 / 投票 / 收藏夹的三条接口一律要 core+ 会话，匿名去问只有 401。
   * 所以对外视图展开前一类、不展开后一类。⚠️ **别把这条边界往回缩成「一律不展开」**
   * ——「作者把文章设为对外可见，读到的人却看不到正文里的图和录音」正是这一版要修的。
   *
   * 【展不开时为什么是「原样保留字面量」而不是「换成一句提示」】评论区那条管线
   * （`src/app/components/useResolvedContent.ts`）已经立过这个口径：「取不到时的样子
   * （未登录 / 非 core 读者）与加载中一致」，就显示 `[@abc12345]`。跟着它走，站内不会
   * 出现第三种「引用不可用」的观感；也不往不可信字符串里插入任何新文本，没有新的转义面。
   */
  contentRefs: ContentRefMode;
}) {
  /** 渲染结果 + 抽出的公式数量（决定要不要跑 MathJax，见 markdown-math.ts）+ 投票预取数据。 */
  const [doc, setDoc] = useState<{
    html: string;
    mathCount: number;
    /** 预处理阶段探测到的投票数据（R3-104），后处理直传小组件、不再发第二条 GET。 */
    voteData: ReadonlyMap<string, VoteEmbedData>;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * ★ 传给 `dangerouslySetInnerHTML` 的那个对象必须 memo 住 ★
   *
   * 【不 memo 会坏什么】React 19 diff 这个 prop 用的是**对象身份**（react-dom 的
   * updateProperties 判 `prevProp !== nextProp` 才走 setProp，而 setProp 里才去读
   * `__html`）。`{{ __html: doc.html }}` 这种内联字面量每次渲染都是一个新对象 ——
   * 于是**任何一次重渲染都会把容器的 innerHTML 整块重写一遍**。
   *
   * 而正文的后续处理（MathJax 排版、投票小组件、图片放大与复制按钮的绑定）是在
   * commit 之后那次效果里做的，效果只认 doc 这些依赖：重写 DOM 这件事它看不见，
   * 于是**不会重跑**。症状（2026-10 实测）：重渲染后公式原样留成 `$$…$$` 文本，
   * 投票位同样会空掉。全程不报错。
   *
   * 按 `doc` 对象 memo：**doc 变了才重写**，与上面那个效果的重跑严格同步；
   * 其它重渲染（父组件切视图、字数统计变化）一概不碰已经处理好的 DOM。
   */
  const innerHtml = useMemo(() => ({ __html: doc?.html ?? '' }), [doc]);

  useHljsThemeStyles();

  // 渲染 markdown → 安全 HTML（含内容引用预处理 + 数学公式占位保护）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 两种模式都要过预处理器 —— 差别在处理器**展开到哪一档**，不在「过不过它」。
      // 别在这里写 `contentRefs === 'expand' && …`：那样对外视图连音频都不会展开。
      const resolver = new ContentRefResolver(contentRefs);
      const processor = new ContentRefProcessor(resolver);
      const text = await processor.preprocess(content ?? '');
      // ★ 投票预取数据必须与这份正文一起落状态 ★ 后处理（enhanceBlogContent）
      // 拿着它直接建小组件，省掉每个投票位的第二次 GET（R3-104）。分开两次 setState
      // 会让「后处理先看到新正文、后看到数据」成为可能，所以并进同一个 doc 对象。
      if (!cancelled) setDoc({ ...renderBlogMarkdown(text), voteData: processor.voteData });
    })();
    return () => { cancelled = true; };
  }, [content, contentRefs]);

  // 渲染后处理：代码复制按钮、图片放大、外链加固、投票嵌入、MathJax
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !doc) return;
    enhanceBlogContent(root, { mathCount: doc.mathCount, voteData: doc.voteData });
  }, [doc]);

  return (
    <div className="blog-content-container-container">
      {doc ? (
        <div
          ref={containerRef}
          className="blog-content-container"
          id={containerId}
          // 已经 DOMPurify 净化；对象 memo 住的理由见上面 innerHtml 的说明
          dangerouslySetInnerHTML={innerHtml}
        />
      ) : (
        <div
          className="blog-content-container"
          id={containerId}
          ref={containerRef}
        >
          <div id={`${containerId}-loading`} className="text-center my-4">
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
