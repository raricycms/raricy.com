'use client';

import { useEffect } from 'react';

// 博客详情页阅读进度条（对齐 Flask blog.html 顶部 .reading-progress）
// 直接根据 window.scrollY 与文档可滚动高度比例，实时更新 .reading-progress 元素的 width。
// 不需要 client 端路由感知 —— 详情页内生效即可。
export default function ReadingProgress() {
  useEffect(() => {
    const target = document.querySelector<HTMLElement>('.reading-progress');
    if (!target) return;

    const article = document.querySelector<HTMLElement>('.blog-content-container');

    function update() {
      let percent = 0;
      if (article) {
        // 文章底部对齐视窗底部即认为阅读完（更接近用户"读完"的感觉）
        const rect = article.getBoundingClientRect();
        const articleBottom = rect.bottom + window.scrollY;
        const viewportBottom = window.scrollY + window.innerHeight;
        const total = articleBottom - window.innerHeight;
        if (total > 0) {
          percent = Math.min(Math.max((viewportBottom - rect.top) / total, 0), 1) * 100;
        }
      } else {
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight > 0) {
          percent = Math.min((window.scrollY / docHeight) * 100, 100);
        }
      }
      target.style.width = `${percent}%`;
    }

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return null;
}