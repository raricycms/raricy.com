'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ime-keydown.ts —— 输入法确认键的判据（讨论区 / 评论区输入框共用）
//
// 【唯一出口】本文件回答一个问题：这一下按键属于输入法，还是属于网页？
// 所有「Enter 直接触发动作」的入口都该先问它，再决定要不要动手。
//
// 【为什么不能只判 isComposing】macOS Safari 把「结束组字的那一下 keydown」排在
// compositionend **之后**发，那一下的 `isComposing` 已经是 false（WebKit bug 165004；
// 修过一次又在 bug 317127 里被整体关掉，线上 Safari 至今仍是旧顺序）。只判原生标志时，
// 中文输入法打字、按 Enter 确认候选词，这一下会被当成正常回车 —— 讨论区当场把半截消息
// 发出去，草稿连同挂着的图片 / 引用 / 回复目标一起被清掉。
//
// 【三条判据】取或，各自覆盖一种到达顺序：
//   1. 原生 isComposing —— Chrome / Firefox 组字期间的按键；
//   2. keyCode === 229 —— WebKit 自己的报告说这是 Safari 上唯一可靠的信号；
//   3. compositionend 之后**同一轮宏任务内**的那一下 keydown —— 确认键紧跟
//      compositionend 到达，而 compositionend 已经把标志复位了。这一条由 useImeGuard
//      用 ref 承担：判它和写它挨得太近，state 要等一次重渲染才更新，来不及。
//
// 【改动注意】第 3 条的复位放在下一个宏任务，只吞掉「紧接着的那一下」；粘住的表现是
// 「打完字按回车没反应」。另外调用点必须在任何 preventDefault **之前** return ——
// 拦下组字期间的按键，候选就选不中，字打不进去，而页面上看不出任何异常。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from 'react';

/** 浏览器直接给出的那两个信号（原生事件与 React 的 nativeEvent 都满足）。 */
export interface ImeKeySignals {
  isComposing: boolean;
  keyCode: number;
}

/**
 * 只判浏览器直接给的信号，不碰组字状态机。
 * 传的是**原生**事件（React 里用 `e.nativeEvent`），document 级监听直接传事件本身。
 */
export function isImeKeydown(native: ImeKeySignals): boolean {
  return native.isComposing === true || native.keyCode === 229;
}

/**
 * 组字状态机 + 上面那条纯判据。返回的 `isImeKey` 要传 React 的合成事件。
 * 输入框之外的入口（面板、按钮菜单）没有 compositionstart / end 可挂，用 isImeKeydown 即可。
 */
export function useImeGuard() {
  /** 组字进行中。原生 isComposing 为 false 的那一档（Safari 也有）靠它兜。 */
  const composingRef = useRef(false);
  /** 刚刚 compositionend、紧跟着的那一下 keydown 还没到。 */
  const justEndedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onCompositionStart = useCallback(() => {
    clearTimer();
    composingRef.current = true;
    justEndedRef.current = false;
  }, [clearTimer]);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    justEndedRef.current = true;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      justEndedRef.current = false;
      timerRef.current = null;
    }, 0);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const isImeKey = useCallback(
    (event: { nativeEvent: ImeKeySignals }) =>
      composingRef.current || justEndedRef.current || isImeKeydown(event.nativeEvent),
    []
  );

  return { onCompositionStart, onCompositionEnd, isImeKey };
}
