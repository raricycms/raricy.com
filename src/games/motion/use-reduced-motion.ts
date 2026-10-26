'use client';

import { useEffect, useState } from 'react';

// 跟随系统「减少动态效果」偏好。
//
// 与 src/games/craft/use-reduced-motion.ts 是同一份实现 —— 刻意各自留一份而不是抽公共
// hooks 目录：站点没有共享 hooks 层，两个游戏之间也不该互相 import（一个玩具下线时
// 另一个不该跟着坏）。
//
// 注意它只负责 JS 驱动的动效（数字递增、竞速），CSS 那部分由 _motion.scss 末尾的
// `prefers-reduced-motion` 块直接关掉 —— 两边都要有：只关 CSS 会让计数照跳，只关 JS
// 会让过渡照跑。
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduce(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduce;
}
