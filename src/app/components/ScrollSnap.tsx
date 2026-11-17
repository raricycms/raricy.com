'use client';

import { useEffect } from 'react';

// 触屏吸附的开关与停靠点挑选。吸附本身归浏览器的 scroll-snap（规则见
// styles-scss/base/_scroll-snap.scss），这里只做两件事：
//   · 按当前视口给 <html> 打 data-snap，决定这两个页面在这一档下是否吸附；
//   · 列表页挑出哪些卡片的顶边当停靠点。
//
// 停靠点的位置全部由 CSS 表达式与元素自身的版面位置决定，脚本不指定任何像素值：
// 旋转、翻页、侧栏展开之后位置自然是对的，不需要再算一遍。

/** 只在窄屏 + 触摸上吸附：桌面滚轮已经有 SmoothWheelScroll 的缓动，再叠一层会变成一跳一跳。 */
const SCOPE = '(max-width: 767px) and (pointer: coarse)';
/** 相邻停靠点的最小间距（相对可见高度）。再密就等于每张卡停一次，一屏要滑好几次。 */
const LIST_STEP_RATIO = 0.85;

type Props = {
  /** stage：首页首屏；list：对外列表 /explore。 */
  mode: 'stage' | 'list';
};

export default function ScrollSnap({ mode }: Props) {
  useEffect(() => {
    const root = document.documentElement;
    const scope = window.matchMedia(SCOPE);
    let frame = 0;
    let marked: HTMLElement[] = [];

    const unmark = () => {
      for (const item of marked) item.removeAttribute('data-snap-stop');
      marked = [];
    };

    // 一屏一格：与上一个停靠点相距不足一屏的卡片跳过，相邻停靠点之间因此几乎正好一屏。
    // 第一张卡总是停靠点（last 从 -Infinity 起），停在它上面才看得见列表开头。
    const pickListStops = () => {
      frame = 0;
      unmark();
      const step = document.documentElement.clientHeight * LIST_STEP_RATIO;
      let last = -Infinity;
      const items = document.querySelectorAll<HTMLElement>('.blog-list .blog-item');
      for (const item of items) {
        const top = item.getBoundingClientRect().top + window.scrollY;
        if (top - last < step) continue;
        item.setAttribute('data-snap-stop', '');
        marked.push(item);
        last = top;
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(pickListStops);
    };

    const apply = () => {
      if (!scope.matches) {
        unmark();
        delete root.dataset.snap;
        return;
      }
      root.dataset.snap = mode;
      if (mode === 'list') pickListStops();
    };

    apply();
    scope.addEventListener('change', apply);

    let observer: MutationObserver | null = null;
    const host = mode === 'list' ? document.querySelector('main') : null;
    if (host) {
      // 列表由服务端流式补上，翻页与筛选会换掉整批卡片：张数与位置都会变。
      // 只观察结构变化 —— 本组件写的是属性，不会把自己再触发一遍。
      observer = new MutationObserver(schedule);
      observer.observe(host, { childList: true, subtree: true });
      window.addEventListener('resize', schedule);
    }

    return () => {
      scope.removeEventListener('change', apply);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
      unmark();
      delete root.dataset.snap;
    };
  }, [mode]);

  return null;
}
