'use client';

import { useEffect } from 'react';

// 触屏吸附的开关与停靠点挑选。吸附本身归浏览器的 scroll-snap（规则见
// styles-scss/base/_scroll-snap.scss），这里只做三件事：
//   · 按当前视口给 <html> 打 data-snap，决定这两个页面在这一档下是否吸附；
//   · 列表页挑出哪些卡片的顶边当停靠点，并把「停靠点要让开的固定头部高度」写进
//     --snap-padding-top —— 吸顶的筛选条会盖住卡片顶，只让开顶栏不够；
//   · 列表换批 / 字体与图片撑高之后重算（停靠点由版面量出来，不是写死的数值）。
//
// 停靠点的位置全部由 CSS 表达式与元素自身的版面位置决定，脚本不指定任何像素值：
// 旋转、翻页、侧栏展开之后位置自然是对的，不需要再算一遍。

/** 只在窄屏 + 触摸上吸附：桌面滚轮使用浏览器原生滚动，再叠一层吸附会让一格滚轮变成一次跳转。
 *  减少动态效果时也不吸附 —— 吸附会把一次手势的惯性强行收在停靠点上，属于用户手势
 *  触发的运动（见 docs/frontend-styles.md §6）。 */
const SCOPE = '(max-width: 767px) and (pointer: coarse) and (prefers-reduced-motion: no-preference)';
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
    let disposed = false;

    const unmark = () => {
      for (const item of marked) item.removeAttribute('data-snap-stop');
      marked = [];
    };

    // 停靠点必须落在「顶栏 + 吸顶筛选条」下面：筛选条是 sticky，吸附时卡片顶对齐的是
    // scroll-padding-top，只让开顶栏会让卡片标题区被工具条盖住。
    const measureStopInset = () => {
      const navbar = document.querySelector('.site-navbar');
      const filters = document.querySelector('.blog-filters');
      let inset = navbar?.getBoundingClientRect().height ?? 0;
      if (filters instanceof HTMLElement) {
        // sticky 的 top 是吸住时的偏移；筛选条高度随窄屏排版变化，不能写死。
        const stuckTop = Number.parseFloat(getComputedStyle(filters).top) || 0;
        inset = Math.max(inset, stuckTop + filters.getBoundingClientRect().height) + 8;
      }
      root.style.setProperty('--snap-padding-top', `${Math.round(inset)}px`);
    };

    // 一屏一格：与上一个停靠点相距不足一屏的卡片跳过，相邻停靠点之间因此几乎正好一屏。
    // 第一张卡总是停靠点（last 从 -Infinity 起），停在它上面才看得见列表开头。
    const pickListStops = () => {
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

    const recompute = () => {
      if (disposed) return;
      if (mode === 'list') measureStopInset();
      pickListStops();
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };

    const apply = () => {
      if (!scope.matches) {
        unmark();
        delete root.dataset.snap;
        root.style.removeProperty('--snap-padding-top');
        return;
      }
      root.dataset.snap = mode;
      recompute();
    };

    apply();
    scope.addEventListener('change', apply);

    let observer: MutationObserver | null = null;
    let resizer: ResizeObserver | null = null;
    const host = mode === 'list' ? document.querySelector('main') : null;
    if (host) {
      // 列表由服务端流式补上，翻页与筛选会换掉整批卡片：张数与位置都会变。
      // 只观察结构变化 —— 本组件写的是属性，不会把自己再触发一遍。
      observer = new MutationObserver(schedule);
      observer.observe(host, { childList: true, subtree: true });
      // 结构没变但高度变了（图片撑开、字体换行）时卡片顶边也会挪，停靠点得跟着重算。
      resizer = new ResizeObserver(schedule);
      resizer.observe(host);
      window.addEventListener('resize', schedule);
      // 字体换好之后行高会变一次，而它不一定会改 main 的尺寸。
      void document.fonts?.ready.then(schedule);
    }

    return () => {
      disposed = true;
      scope.removeEventListener('change', apply);
      observer?.disconnect();
      resizer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
      unmark();
      delete root.dataset.snap;
      root.style.removeProperty('--snap-padding-top');
    };
  }, [mode]);

  return null;
}
