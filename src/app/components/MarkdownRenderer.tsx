'use client';

// 博客正文客户端渲染：组合四个共享模块，自身只管 React 生命周期与挂载。
//   · 内容引用预处理（[@id]）：content-ref-processor.ts（整篇扫描 / 替换顺序 /
//     代码屏蔽 / 预算），取数走 content-ref-resolver.ts（两种模式 / 缓存）。
//     6 位收藏夹只在这条管线上：评论与讨论走 rich-text.ts，那边刻意不认 6 位，
//     与 9 位投票「只识别不展开」同向。
//   · 整篇渲染：blog-renderer.ts（protectMath → marked + hljs → restoreMath →
//     DOMPurify）。**没有第二套 Markdown → HTML 路径**，编辑器预览也走它。
//   · DOM 后处理：blog-content-dom.ts（复制按钮 / 外链加固 / 图片放大 /
//     投票小组件 / MathJax），正文交互与只读预览由 `interactive` 一个参数分叉。
//   · 代码高亮亮/暗双主题随 data-theme 切换：useHljsThemeStyles.ts。
//
// 【两种引用模式，不是「展开 / 不展开」】`contentRefs='expand'` 是站内成员视图，
// `'external'` 是对外视图。对外视图**也展开**，只是展开的范围小一圈：
// 图床图片 / 音频 / **服务端随 payload 下发的公开剪贴板**（externalClips）出得来，
// 投票与收藏夹保留字面量。判据是「这条引用的读口是不是匿名本来就取得到」——
// 见 prop 上的说明与 docs/architecture.md §7.3。
import { useEffect, useRef, useState } from 'react';
import { ContentRefProcessor } from '@/lib/content-ref-processor';
import { ContentRefResolver, type ContentRefMode } from '@/lib/content-ref-resolver';
import { renderBlogMarkdown } from '@/lib/blog-renderer';
import { enhanceBlogContent } from '@/lib/blog-content-dom';
import { useHljsThemeStyles } from '@/app/components/useHljsThemeStyles';

export default function MarkdownRenderer({
  content,
  contentRefs,
  externalClips,
  interactive = true,
  resolver: sharedResolver,
  refreshToken,
}: {
  content: string;
  /**
   * 内容引用（`[@…]`）的处理方式。**由服务端决定，不是客户端开关。**
   *
   *   · 'expand'   —— 站内成员视图：带 same-origin 凭据去请求三条 core+ 接口
   *     （剪贴板正文 / 投票嵌入 / 收藏夹卡片）+ 拼图床 URL + 音频播放器。
   *     **只有 core+ 的页面能传这个。**
   *   · 'external' —— 对外视图：只展开**匿名读口本来就取得到**的那几类 ——
   *     图床图片、音频播放器，以及随 payload 下发的公开剪贴板（见 `externalClips`）。
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
  /**
   * **服务端预先解析好**的公开剪贴板（id → 正文），只给 'external' 用。
   *
   * 为什么由服务端给而不是客户端去拉：`GET /api/clipboard/:id` 要 core+ 会话，
   * 匿名读者拿不到 —— 而剪贴板的 `publicity=false` 是比 core+ **更窄**的一档，
   * 不能因为「被引用进了一篇公开文章」而放宽。所以判档在服务端做，判完只把能给的
   * 那几条随 payload 发下来（`clipboard-service.ts` 的 `resolvePublicClipRefs`）。
   * 不带会话的页面**必须**传它，否则正文里的剪贴板引用一律是字面量。
   */
  externalClips?: Record<string, string>;
  /**
   * 正文交互开关，默认 true（正文页行为）。编辑器完整预览传 **false**：
   * 投票小组件渲染同一份结构但不绑提交处理器（预览不发业务写请求），
   * 所有链接一律新窗口打开（就地跳转会丢掉未发布的草稿）。差异只从这一个
   * 参数出去，见 blog-content-dom.ts 文件头。
   */
  interactive?: boolean;
  /**
   * 会话级引用缓存（编辑器预览跨重渲染复用，销毁随编辑器）。**不传 = 每次渲染
   * 新建一个**（正文页现状：一篇正文内的重复引用只取一次，换内容重新取）。
   * 传了的话，调用方负责它的生命周期与「刷新预览」（配合 `refreshToken`）。
   */
  resolver?: ContentRefResolver;
  /**
   * 「刷新预览」信号：值变化时先 `resolver.invalidate()` 再重新渲染 ——
   * 401 / 403 不会被上一份成功缓存掩盖（缓存先清，本次拒绝一定重新取数）。
   * 只在传了 `resolver` 时有意义；不传 resolver 时每次渲染本来就是全新缓存。
   */
  refreshToken?: number;
}) {
  /** 渲染结果 + 抽出的公式数量（决定要不要跑 MathJax，见 markdown-math.ts）。 */
  const [doc, setDoc] = useState<{ html: string; mathCount: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRefreshRef = useRef<number | undefined>(undefined);

  useHljsThemeStyles();

  // 渲染 markdown → 安全 HTML（含内容引用预处理 + 数学公式占位保护）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 两种模式都要过预处理器 —— 差别在处理器**展开到哪一档**，不在「过不过它」。
      // 别在这里写 `contentRefs === 'expand' && …`：那样对外视图连音频都不会展开。
      const resolver = sharedResolver ?? new ContentRefResolver(contentRefs, externalClips);
      // 刷新信号变化 → 先清会话缓存（在第一个 await 之前，保证本次渲染一定重取）。
      if (sharedResolver && refreshToken !== lastRefreshRef.current) {
        sharedResolver.invalidate();
      }
      lastRefreshRef.current = refreshToken;
      const text = await new ContentRefProcessor(resolver).preprocess(content ?? '');
      if (!cancelled) setDoc(renderBlogMarkdown(text));
    })();
    return () => { cancelled = true; };
  }, [content, contentRefs, externalClips, sharedResolver, refreshToken]);

  // 渲染后处理：代码复制按钮、图片放大、外链加固、投票嵌入、MathJax
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !doc) return;
    enhanceBlogContent(root, { interactive, mathCount: doc.mathCount });
  }, [doc, interactive]);

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
