'use client';

import { useEffect, useRef, useState } from 'react';

// 概览统计数字的入场动画（React 等价于 Flask admin_dashboard.html 的 animateNumber）：
//   从 0 递增到目标值，increment = target/30，每 50ms 一步，Math.floor 取整。
export default function AdminStatNumber({ value }: { value: number }) {
  const [n, setN] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let current = 0;
    const increment = value / 30;
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

  return <>{n}</>;
}
