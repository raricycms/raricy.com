'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// 局部滚动容器的自绘滚动条。页面级那条见 SiteScrollbar（读 window），这里负责
// 页内所有 `overflow-y: auto / scroll` 的盒子：下拉列表、选择器面板、编辑器预览、
// 评论区、聊天区、后台侧栏……
//
// 【为什么注入而不是改结构】滑块是绝对定位的子元素，不占布局；滚动容器本身不包
// wrapper，类名与子结构都不动 —— e2e 与样式里那些「直接子元素」选择器才不受影响。
// 代价是滑块会跟着内容一起滚，所以每次 scroll 都要把它按 scrollTop 反向抵消一次。
//
// 【只管纵向】`pre`、横向表格这类盒子的 overflow-x 是 auto（另一个轴会算成 auto），
// 隐藏规则只写 `::-webkit-scrollbar { width: 0 }`，横向那条原生条留着 —— 否则代码块
// 的横向滚动条会跟着消失，而这里注入的滑块只跟踪纵向。
//
// 【触屏不接管】与页面级那条同一个条件（有悬停、精确指针）。触屏的原生浮层条不占
// 宽度，换成 6px 滑块没有收益。

const MIN_THUMB = 32;
const SKIP = new Set(['HTML', 'BODY', 'TEXTAREA']);
const HIDE_ON = '/';
const ENABLED = '(hover: hover) and (pointer: fine)';

/**
 * 只有能单独把纵向原生条藏掉的引擎才接管局部容器。Firefox 不认 `::-webkit-scrollbar`，
 * 藏不掉原生条 —— 再注入一条滑块就是两条并排。页面级那条不靠这个判据：它用
 * `scrollbar-width: none` 藏根滚动条，Firefox 也支持。
 */
const CAN_HIDE_NATIVE_VERTICAL =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
  && CSS.supports('selector(::-webkit-scrollbar)');

type Port = {
  el: HTMLElement;
  thumb: HTMLDivElement;
  onScroll: () => void;
  observer: ResizeObserver;
  mutation: MutationObserver;
  classObserver: MutationObserver;
  cleanup: () => void;
};

function isScrollPort(el: HTMLElement): boolean {
  if (SKIP.has(el.tagName)) return false;
  if (el.dataset.scrollPort) return false;
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll';
}

/** 容器里除 keep 之外的滑块都删掉（滑块是直接子节点，只看一层）。 */
function dropStrayThumbs(el: HTMLElement, keep?: HTMLDivElement): void {
  Array.from(el.children).forEach((node) => {
    if (node !== keep && node.classList.contains('scroll-port__thumb')) node.remove();
  });
}

function mount(el: HTMLElement): Port | null {
  if (!isScrollPort(el)) return null;
  el.dataset.scrollPort = '1';
  // 同一容器上可能还留着上一轮接管的滑块（见下面 cleanup 的说明）。先清掉再挂新的，
  // 保证一个容器最多一条滑块 —— 否则会同时出现新旧两条，旧的停在原处不动。
  dropStrayThumbs(el);
  // 只有原本是 static 的容器才补定位上下文；absolute/fixed 的容器本身就是上下文，
  // 改它的 position 会把布局挪走。
  const needsStatic = getComputedStyle(el).position === 'static';
  // 卸载后仍可能有排队中的 rAF 回调（初次同步、ResizeObserver 那一跳）在跑：它们
  // 一旦执行就会把已经删掉的滑块补回 DOM、把接管类补回元素，于是新实例再挂一条 ——
  // 同一容器出现两条滑块，旧那条停在卸载前的长度上不动。用这个标记让回调直接退出。
  let disposed = false;
  // React 重渲染会整串重写 className（例如 `.modal` 切 `is-open`）：运行期加的两个类
  // 会被一起抹掉，原生条当场回来、滑块却还在 —— 变成两条并排。这里记住该补什么，
  // 并在 class 被外部改写时补回去（见下面的 classObserver）。
  const ensureClasses = () => {
    if (disposed) return;
    if (!el.classList.contains('scroll-port')) el.classList.add('scroll-port');
    if (needsStatic && !el.classList.contains('scroll-port--static')) el.classList.add('scroll-port--static');
  };
  ensureClasses();

  const thumb = document.createElement('div');
  thumb.className = 'scroll-port__thumb is-hidden';
  el.appendChild(thumb);

  let dragging: { pointerId: number; startY: number; startScroll: number } | null = null;

  const sync = () => {
    if (disposed) return;
    // 内容被整体替换（innerHTML、按 key 重建）时滑块会被一起删掉：补回来。
    if (!thumb.isConnected) el.appendChild(thumb);
    ensureClasses();
    const height = el.clientHeight;
    const scrollH = el.scrollHeight;
    if (scrollH <= height + 1 || height < MIN_THUMB) {
      thumb.classList.add('is-hidden');
      return;
    }
    thumb.classList.remove('is-hidden');
    const thumbH = Math.max(MIN_THUMB, Math.round((height * height) / scrollH));
    const offset = (el.scrollTop / (scrollH - height)) * (height - thumbH);
    thumb.style.height = `${thumbH}px`;
    // 抵消容器自身的滚动位移：滑块永远贴在可视区的这一格上。
    thumb.style.transform = `translateY(${(el.scrollTop + offset).toFixed(1)}px)`;
  };

  // scroll 事件按帧合并：惯性滚动一帧能发多次 scroll，逐个 sync 等于每帧多次读布局。
  // 同一帧只排一次同步，滑块位置在下一帧画出来；指针拖动写 scrollTop 也走这里，
  // 视觉上仍跟手。初次同步与 ResizeObserver 也走这一个入口，卸载时统一取消。
  let syncFrame = 0;
  const scheduleSync = () => {
    if (disposed || syncFrame) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0;
      sync();
    });
  };
  const onScroll = scheduleSync;

  const onPointerDown = (event: PointerEvent) => {
    const scrollH = el.scrollHeight;
    const travel = el.clientHeight - thumb.getBoundingClientRect().height;
    const maxScroll = scrollH - el.clientHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    dragging = { pointerId: event.pointerId, startY: event.clientY, startScroll: el.scrollTop };
    thumb.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const travel = el.clientHeight - thumb.getBoundingClientRect().height;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    el.scrollTop = dragging.startScroll + ((event.clientY - dragging.startY) * maxScroll) / travel;
    event.preventDefault();
  };

  const onPointerUp = () => {
    dragging = null;
  };

  thumb.addEventListener('pointerdown', onPointerDown);
  thumb.addEventListener('pointermove', onPointerMove);
  thumb.addEventListener('pointerup', onPointerUp);
  thumb.addEventListener('pointercancel', onPointerUp);

  el.addEventListener('scroll', onScroll, { passive: true });

  const observer = new ResizeObserver(scheduleSync);
  observer.observe(el);
  // 内容变化（列表补数据、图片撑开）不改变容器尺寸，靠 MutationObserver 兜住。
  // 内容变化直接同步一次（不排到下一帧）：整体替换会在同一帧里删掉滑块，
  // 排到 rAF 的话那一帧用户看到的是「滑块消失」。
  const mutation = new MutationObserver(() => {
    // 「一个容器只有一条滑块」在这里兜底：上一轮接管迟到的补挂（见上面的 disposed）
    // 或别的接管者往同一容器里插了滑块时，只保留自己这条 —— 两条并存时旧那条停在
    // 上一次的长度上不动，看着就是两条滚动条。
    dropStrayThumbs(el, thumb);
    sync();
  });
  mutation.observe(el, { childList: true, subtree: true, characterData: true });
  // 外部（React）重写 className 时立即把接管类补回去；补类本身也会触发一次本观察器，
  // 第二次进来类已存在，直接返回。
  const classObserver = new MutationObserver(() => ensureClasses());
  classObserver.observe(el, { attributes: true, attributeFilter: ['class'] });

  scheduleSync();

  return {
    el,
    thumb,
    onScroll,
    observer,
    mutation,
    classObserver,
    cleanup: () => {
      disposed = true;
      el.removeEventListener('scroll', onScroll);
      if (syncFrame) cancelAnimationFrame(syncFrame);
      observer.disconnect();
      mutation.disconnect();
      classObserver.disconnect();
      thumb.remove();
      el.classList.remove('scroll-port', 'scroll-port--static');
      delete el.dataset.scrollPort;
    },
  };
}

export default function Scrollbars() {
  const pathname = usePathname();

  useEffect(() => {
    // 首页整屏是画，页面级那条不在，局部也不接管。
    if (pathname === HIDE_ON) return;
    // 藏不掉原生纵向条（Firefox）就不接管：否则原生条与滑块两条并排。
    if (!CAN_HIDE_NATIVE_VERTICAL) return;
    if (!window.matchMedia(ENABLED).matches) return;

    const ports = new Map<HTMLElement, Port>();

    const scan = () => {
      document.querySelectorAll<HTMLElement>('div, ul, ol, section, aside, article, nav, pre, table').forEach((el) => {
        if (ports.has(el)) return;
        const port = mount(el);
        if (port) ports.set(el, port);
      });
    };

    // 已经离开文档的容器连观察器一起回收：弹层一开一合都会留一批。
    const prune = () => {
      Array.from(ports.keys()).forEach((el) => {
        if (el.isConnected) return;
        const port = ports.get(el);
        port?.cleanup();
        ports.delete(el);
      });
    };

    scan();
    prune();

    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        prune();
        scan();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      Array.from(ports.keys()).forEach((el) => {
        ports.get(el)?.cleanup();
      });
      ports.clear();
    };
  }, [pathname]);

  return null;
}
