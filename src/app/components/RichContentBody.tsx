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

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ImageLightbox from './ImageLightbox';
import { useResolvedContent } from './useResolvedContent';
import { IMAGE_REF_CLASS } from '@/lib/content-refs';
import { STICKER_REF_CLASS } from '@/lib/sticker-refs';

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
  const boxRef = useRef<HTMLDivElement | null>(null);

  /**
   * 表情图加载失败 → 把它换回纯文本 `[@合集/表情]`。
   *
   * 【为什么不能在渲染管线里挂（rich-text.ts）】那条管线是**字符串进、字符串出**
   * （render() 最后 `return holder.innerHTML`）。embedStickerRefs 建的 img 只是中间
   * 产物，挂在节点上的监听器在序列化那一刻全部丢失；React 这端拿到的是浏览器
   * **重新解析** innerHTML 建出来的另一批节点。
   *
   * 【为什么不用 setAttribute('onerror', ...)】那是 innerHTML 注入的经典 XSS 形态，
   * 等于把 rich-text.ts 文件头「绝不拼 innerHTML」那条防线自己拆了。
   *
   * 【为什么不用 useEffect + querySelectorAll 逐个挂】
   *   · 每张图一个监听器，html 一变（React 重设 innerHTML）旧监听器就成垃圾；
   *   · **更致命的是时序**：innerHTML 一设，浏览器的加载任务就开跑，若这张图已在
   *     缓存里记着「加载失败」，error 只隔一个 task 就派发 —— 而 passive effect 与
   *     那个 task 谁先谁后不是我们能控制的，慢一拍的那张**永远不会降级**。
   *
   * 【为什么捕获阶段能行】资源类的 error 事件**不冒泡，但走捕获**：从 window 一路
   * 传下来。所以容器上一个 capture 监听器就能收全部后代 <img> 的错误，且它跟着
   * **容器**的生命周期走，innerHTML 换多少次都不用重挂。
   *
   * 【为什么依赖是 [html] 而不是 []】本组件在 html 为空时 `return null`，那个 div 会
   * **卸载**；html 从空变回非空时 div 是**重新挂载**的，deps=[] 的 effect 不会再跑
   * → 监听器永远附不上。当前两个调用方都不传空正文，所以这是「现在不炸、将来炸」。
   *
   * 【已知取舍】降级是**单向且粘性**的：一旦换成文本节点，在这个 DOM 节点被 React
   * 重建之前不会重试（网络恢复 / 站长补了文件都要等刷新页面）。这与
   * useResolvedContent「加载中显示字面量」的既有口径一致。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onError = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!(target instanceof HTMLImageElement)) return;
      // 只管表情：容器里还有图床引用图，别误伤
      if (!target.classList.contains(STICKER_REF_CLASS)) return;
      const token = target.getAttribute('data-token');
      // isConnected 守一道：事件排队期间 React 可能已经换掉整棵 innerHTML，
      // 此时 img 已脱离文档，replaceWith 会**静默什么都不做**。
      if (!token || !target.isConnected) return;
      target.replaceWith(target.ownerDocument.createTextNode(token));
    };
    box.addEventListener('error', onError, true);
    return () => box.removeEventListener('error', onError, true);
  }, [html]);

  if (!html) return null;

  return (
    <>
      <div
        ref={boxRef}
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
