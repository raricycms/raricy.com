'use client';

// ─────────────────────────────────────────────────────────────────────────────
// StoryReaderClient — Markdown 阅读页的客户端增强。
//
// 只有一件事：顶部阅读进度条：随滚动填充 width，并让渐隐区域随进度动态缩小
// （0% 时右端 15% 渐隐，100% 时全填满无渐隐）。
//
// **刻意不做键盘翻页**：服务端渲染的 `.story-reader__nav` 里只有「目录」一个链接，
// 「上一章 / 下一章」是 aria-hidden 的占位 <span>（没有 prev/next 章数据、也不该
// 臆造章节接口）。以前这里挂着一个 `querySelector('.story-reader__nav a[title*="上一章"]')`
// 的监听——选择器恒为 null，等于一段永远不生效的代码，却让读代码的人以为 ←/→ 能用。
// 将来真的补了上一章/下一章链接，再按 `[title*="上一章"]` 把监听加回来。
//
// hljs 主题同步不在此实现：Next 侧 Markdown 为服务端渲染、highlight 已固化，
// 无客户端 marked+hljs 的运行期主题切换需求（看不见的差异，忽略）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

export default function StoryReaderClient() {
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const progress = progressRef.current;

    // 阅读进度条。
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

    // 键盘导航见文件头：故意没有 —— 导航区只有「目录」，没有上一章/下一章链接。

    window.addEventListener('scroll', onScroll);
    onScroll(); // 首帧同步一次（进入页面即反映当前滚动位置）。
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return <div className="story-reader__progress" id="readingProgress" ref={progressRef}></div>;
}
