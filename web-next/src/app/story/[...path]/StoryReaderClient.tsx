'use client';

// ─────────────────────────────────────────────────────────────────────────────
// StoryReaderClient — Markdown 阅读页的客户端增强（忠实移植 reader.html 尾部脚本）。
//
// 两件事，逐字对齐 Flask app/templates/story/reader.html 的 extra_js：
//   1. 顶部阅读进度条：随滚动填充 width，并让渐隐区域随进度动态缩小
//      （0% 时右端 15% 渐隐，100% 时全填满无渐隐）。
//   2. 键盘翻页：← 点上一章、→ 点下一章（查 .story-reader__nav 内带 title 的锚点）。
//      与 Flask 一致——服务端从不提供 prev/next 章 URL（views.py 未传），
//      故导航项恒为 ghost <span>，此监听是等价的空操作机制，不臆造章节接口。
//
// hljs 主题同步不在此实现：Next 侧 Markdown 为服务端渲染、highlight 已固化，
// 无 reader.html 里客户端 marked+hljs 的运行期主题切换需求（看不见的差异，忽略）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

export default function StoryReaderClient() {
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const progress = progressRef.current;

    // 阅读进度条（对齐 reader.html 第 108-118 行）。
    const onScroll = () => {
      if (!progress) return;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const pct = h > 0 ? (window.pageYOffset / h) * 100 : 0;
      progress.style.width = pct + '%';
      // 渐隐区域随进度动态缩小：0% 时右端 15% 渐隐，100% 时全部填满无渐隐。
      const fadeStart = 60 + (pct / 100) * 40;
      progress.style.background =
        'linear-gradient(to right, var(--color-brand-primary) ' + fadeStart + '%, transparent 100%)';
    };

    // 键盘导航（对齐 reader.html 第 121-130 行）。
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') {
        const prev = document.querySelector<HTMLAnchorElement>(
          '.story-reader__nav a[title*="上一章"]',
        );
        if (prev) prev.click();
      } else if (e.key === 'ArrowRight') {
        const next = document.querySelector<HTMLAnchorElement>(
          '.story-reader__nav a[title*="下一章"]',
        );
        if (next) next.click();
      }
    };

    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    onScroll(); // 首帧同步一次（进入页面即反映当前滚动位置）。
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return <div className="story-reader__progress" id="readingProgress" ref={progressRef}></div>;
}
