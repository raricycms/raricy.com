'use client';

import { useEffect, useState } from 'react';

/** 折叠、展开、纸屑这类形变动画在减少动态效果时直接到终态；功能与内容不变。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}
