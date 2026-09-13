'use client';

// ─────────────────────────────────────────────────────────────────────────────
// RichContentBody.tsx — 用户正文的渲染壳（聊天与评论共用）
//
// 真正干活的两件事都不在这里：
//   · marked → DOMPurify → 后处理：src/lib/rich-text.ts（由调用方以 render 传入）
//   · `[@<8位剪贴板ID>]` 的异步展开：./useResolvedContent
//
// 本组件只负责把两者接起来，外加一件渲染期才有意义的事：**给正文里的内联图片
// 挂点击放大**。正文是 dangerouslySetInnerHTML 塞进去的，挂不上 React onClick，
// 所以在容器上做事件委托 —— 用 ImageLightbox（与附件图同一个看图器）。
//
// 【为什么单独一个组件】聊天与评论的渲染壳本来是两份同构代码（ChatMarkdown /
// CommentMarkdown），各自只差一个类名与一个 render 函数。本次两边都要加「异步
// 展开 + 图片点击」，再各写一份就是必然 drift —— 与 rich-text.ts 文件头讲的是
// 同一个理由。两个薄壳因此退化成「传类名 + 传 render」。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useMemo, useState } from 'react';
import ImageLightbox from './ImageLightbox';
import { useResolvedContent } from './useResolvedContent';
import { IMAGE_REF_CLASS } from '@/lib/content-refs';

function RichContentBody({
  content,
  className,
  render,
}: {
  content: string;
  /** 正文容器的类名（chat-msg__md / comment-content__md）。 */
  className: string;
  /** 净化管线的入口（renderChatMarkdown / renderCommentMarkdown）。 */
  render: (content: string) => string;
}) {
  const resolved = useResolvedContent(content);
  const html = useMemo(() => render(resolved), [render, resolved]);
  /** 被点开的内联图片地址（null = 没开）。 */
  const [lightbox, setLightbox] = useState<string | null>(null);

  if (!html) return null;

  return (
    <>
      <div
        className={className}
        onClick={(e) => {
          // 容器里只可能有内容引用图（附件图在容器**之外**，见 ChatMessageItem /
          // CommentSection），再按类名收一道，免得将来有别的 img 混进来。
          const target = e.target as HTMLElement;
          if (target.tagName === 'IMG' && target.classList.contains(IMAGE_REF_CLASS)) {
            setLightbox((target as HTMLImageElement).src);
          }
        }}
        // html 来自 render：已过 DOMPurify 白名单净化 + 链接加固
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {lightbox && (
        <ImageLightbox src={lightbox} alt="图片" onClose={() => setLightbox(null)} />
      )}
    </>
  );
}

export default memo(RichContentBody);
