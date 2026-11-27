'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useChatScrollActivity.ts — 讨论区滚动活跃度 → RMD 编译调度信号（React 薄壳）
//
// 把消息列表上的滚动输入翻译成 `setChatScrollActive` 的 true / false
// （外部 store 见 ./scroll-activity）：
//   · wheel / touchmove：一有输入就置 true，并重置 180ms 空闲计时；
//     Ctrl + wheel 是浏览器缩放，不滚动列表，不算活跃；
//   · scroll：用 scrollTop + performance.now() 估算速度，|v| > 0.6 px/ms
//     （约 600px/s）也置 true 并重置计时 —— 程序化滚动（自动到底 / 跳转）同样
//     会派发 scroll，速度命中就暂停编译，不在事件来源上做区分；列表节点更换或
//     resetKey（切频道）变化时旧基线作废，第一次采样只重建基线、不判速度；
//   · 180ms 内既没有新输入、也没有快速滚动 → 置 false，恢复编译派发。
//
// 【为什么走 document 捕获而不是拿 listRef 挂监听】`.chat-list` 只在选中会话后
// 才渲染（首屏 channels 为空；空态 / 专注模式没有它），用 ref 要么挂不上，要么
// 得常驻 rAF 轮询 `ref.current`。wheel / touchmove 冒泡、scroll 不冒泡但捕获阶段
// 能收到；按 target 是否落在 `.chat-list` 过滤即可，元素出现 / 消失都不需要重挂。
//
// 【不做什么】不写 React state（滚动事件每帧都来，setState 会把消息列表重渲一遍）；
// 不 preventDefault、不读写 scrollTop —— 滚动本身完全交给浏览器与现有跟随逻辑。
// 模块级 store 跨路由存活，卸载时必须置 false，否则会把下一次进入的编译也压住。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { setChatScrollActive } from './scroll-activity';

/** 空闲判定：这么久没有新输入 / 快速滚动就恢复编译派发。 */
const IDLE_MS = 180;
/** 快速滚动阈值（px/ms，约 600px/s）。 */
const FAST_SCROLL_VELOCITY = 0.6;
const LIST_CLASS = 'chat-list';

function insideChatList(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`.${LIST_CLASS}`) !== null;
}

/**
 * 维护聊天页「正在滚动」的外部信号。`resetKey`（当前会话 id）变化时重置采样
 * 基线；不产生 React state，列表元素按事件 target 过滤。
 */
export function useChatScrollActivity(resetKey: string | null): void {
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let active = false;
    /** 上一次 scroll 采样：估速基线；lastTarget 用于识别 hook 内列表节点更换。 */
    let lastTop = 0;
    let lastAt = 0;
    let lastTarget: HTMLElement | null = null;

    const clearIdle = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    /** 进入「滚动中」：只在 false → true 时写 store，其余输入只推迟空闲计时。 */
    const markActive = () => {
      if (!active) {
        active = true;
        setChatScrollActive(true);
      }
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        active = false;
        setChatScrollActive(false);
      }, IDLE_MS);
    };

    const onWheel = (event: WheelEvent) => {
      // Ctrl + wheel 是浏览器缩放（浏览器会发 wheel 但不滚列表），不算滚动活跃。
      if (event.ctrlKey) return;
      if (insideChatList(event.target)) markActive();
    };

    const onTouchMove = (event: Event) => {
      if (insideChatList(event.target)) markActive();
    };

    /**
     * 速度估的是相邻两次 scroll 事件之间：既覆盖轨道惯性，也覆盖自动到底 /
     * 平滑跳转这类程序化滚动。间隔过大时平均速度自然变小，不会把一次孤立的
     * 跳变误报成持续快速滚动。
     *
     * 列表节点更换（或 resetKey 变化重建 effect）时旧基线不可比：新列表第一次
     * scroll 往往就是贴底 / 恢复位置的大跳变，沿用旧 scrollTop 会被误判成
     * 持续快速滚动。此时只重建基线并跳过本次速度判断。
     */
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains(LIST_CLASS)) return;
      const now = performance.now();
      const top = target.scrollTop;
      if (target !== lastTarget) {
        lastTarget = target;
        lastTop = top;
        lastAt = now;
        return;
      }
      const dt = now - lastAt;
      if (dt > 0 && Math.abs(top - lastTop) / dt > FAST_SCROLL_VELOCITY) markActive();
      lastTop = top;
      lastAt = now;
    };

    document.addEventListener('wheel', onWheel, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });

    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('scroll', onScroll, { capture: true });
      clearIdle();
      setChatScrollActive(false);
    };
  }, [resetKey]);
}