'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useChatViewport.ts —— 讨论区整屏工作台的软键盘让位（React 薄壳）
//
// 决策逻辑全在零依赖的 `@/lib/chat-viewport`（见那里的文件头）；这里只做三件事：
//   1. 把 `window` / `window.visualViewport` 的实时读数喂给决策函数；
//   2. 在 `resize` / `scroll` 上重算，并把结果写进**讨论区根元素**的自定义属性
//      `--chat-vv-bottom`（不动 React state —— 高度随键盘动画每帧变，走 state 会把
//      整棵消息列表重渲一遍）；高度本身由 CSS 读取，见 pages/_chat.scss。
//   3. 卸载时摘掉监听、清掉属性，回到 `dvh` 兜底。
//
// 【不做什么】不写 `overflow: hidden`、不主动 `scrollTo`、不碰 body ——
// 只维护一个自定义属性。不支持 `visualViewport` 的浏览器直接早退，保持 dvh 行为。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, type RefObject } from 'react';
import {
  applyChatViewportBottom,
  chatViewportBottomPx,
} from '@/lib/chat-viewport';

/**
 * 让讨论区工作台跟随软键盘收放。`ref` 指向 `.chat-page` 根元素。
 *
 * 只依赖 `ref`（对象身份稳定）—— effect 因此只在挂载时跑一次；`ref.current` 在
 * 挂载后已就位。返回 `void`：结果写在元素上，不经过组件状态。
 */
export function useChatViewport(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 不支持 visualViewport → 什么也不做，`.chat-page` 保持 dvh 兜底。
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    // 触屏闸门每次现读 matchMedia：二合一设备（触屏 + 鼠标）切换指针类型时不至于卡死。
    // 用可选调用兜住没有 matchMedia 的极老浏览器 —— 链断了会抛错，整页讨论区陪葬；
    // 读不到就按「非触屏」处理，退回 dvh 兜底。
    const isCoarsePointer = () => window.matchMedia?.('(pointer: coarse)').matches === true;

    const update = () => {
      applyChatViewportBottom(
        el,
        chatViewportBottomPx({
          supported: true,
          coarsePointer: isCoarsePointer(),
          scale: vv.scale,
          innerHeight: window.innerHeight,
          vvHeight: vv.height,
          vvOffsetTop: vv.offsetTop,
        })
      );
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // window.resize 兜住「visualViewport 事件没派发、但布局视口变了」的浏览器差异；
    // 键盘弹起时它可能与 vv.resize 同时来，`applyChatViewportBottom` 幂等，不重复写。
    window.addEventListener('resize', update);

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      applyChatViewportBottom(el, null);
    };
  }, [ref]);
}
