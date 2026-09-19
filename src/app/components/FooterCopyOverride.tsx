'use client';

import { useEffect } from 'react';

// 页脚版权覆写：把本页的 `.footer-copy` 换成给定文案，卸载时还原。
//
// 【为什么只能这么做】共享 Footer 在 layout 里渲染，不接参数、不按页定制，所以
// 「这一页的版权归原作者」只能等客户端挂载之后改写那段 DOM。
//
// 【为什么要抽成一个组件】这段逻辑一度在 FeedButton 与剪贴板详情里各躺了一份；
// 文章详情页的访客视图不渲染 FeedButton，却恰恰是最需要这行字的地方（站外读者
// 唯一一次读到它），会成为第三份。故收在这里，三处共用。
//
// 【为什么空文案直接早退】宁愿留着默认的「© 20xx 聪明山」，也不要把页脚换成空白。
export default function FooterCopyOverride({ text }: { text: string }) {
  useEffect(() => {
    if (!text) return;
    const el = document.querySelector<HTMLElement>('.footer-copy');
    if (!el) return;
    const prev = el.textContent;
    el.textContent = text;
    return () => {
      el.textContent = prev;
    };
  }, [text]);

  return null;
}
