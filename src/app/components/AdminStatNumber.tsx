'use client';

import { useEffect, useState } from 'react';

// 概览统计数字的入场动画：从 0 递增到目标值（30 步、50ms 一步）。
//
// 两个约束：
//   · **value 变化时也要重跑** —— 旧实现用 `started` ref 把动画锁死在首次挂载，
//     于是 router.refresh() 之后数字停在旧值，看起来像「统计没刷新」，不报错。
//   · 减少动态效果偏好下直接显示终值（不做计数动画）。
export default function AdminStatNumber({ value }: { value: number }) {
  const [n, setN] = useState(value);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || value <= 0) {
      setN(value);
      return;
    }
    let current = 0;
    const increment = value / 30;
    setN(0);
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        current = value;
        clearInterval(timer);
      }
      setN(Math.floor(current));
    }, 50);
    return () => clearInterval(timer);
  }, [value]);

  return <span className="numeric">{n}</span>;
}
