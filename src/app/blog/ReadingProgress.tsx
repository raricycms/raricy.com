'use client';

import { useEffect } from 'react';

// 博客详情页阅读进度条（页面顶部那条 .reading-progress）
//
// 【坐标必须同一套】进度 = 「文章已被阅读的竖直范围 / 文章总高」，分子分母都在**文档
// 坐标**里算：文章顶 = rect.top + scrollY，已读下沿 = scrollY + innerHeight。
// 旧实现把视口相对的 rect.top 与绝对坐标相减，代数上会在「可滚区间一半」就满格
// （长文中点即 100%）。判定「读完」= 文章底部对齐视窗底部 —— 此时分子恰为文章总高。
export default function ReadingProgress() {
  useEffect(() => {
    const target = document.querySelector<HTMLElement>('.reading-progress');
    if (!target) return;

    const article = document.querySelector<HTMLElement>('.blog-content-container');

    const update = () => {
      let percent = 0;
      if (article) {
        const rect = article.getBoundingClientRect();
        const articleTop = rect.top + window.scrollY;
        const readBottom = window.scrollY + window.innerHeight;
        const total = rect.height;
        if (total > 0) {
          percent = Math.min(Math.max((readBottom - articleTop) / total, 0), 1) * 100;
        }
      } else {
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight > 0) {
          percent = Math.min((window.scrollY / docHeight) * 100, 100);
        }
      }
      target.style.width = `${percent}%`;
    };

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