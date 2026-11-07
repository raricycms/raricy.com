'use client';

// ─────────────────────────────────────────────────────────────────────────────
// use-dialog-focus.ts — 三个浮层（关卡选择 / 结算 / 引导）共用的焦点管理
//
// 这三个浮层都挂了 `role="dialog" aria-modal="true"`，但 aria-modal 只是**声明**：
// 浏览器不会因此把背景移出 Tab 顺序，读屏也不会自动跳过背景。真正的契约是两件事：
//   1. 打开时把焦点送进浮层（否则键盘用户还在背景的「重来 / 关卡选择」按钮上）；
//   2. Tab / Shift+Tab 只在浮层内循环，关闭时把焦点还给打开它的那个元素。
// 背景的 inert 由容器（TwinShade）给 `.tw-shell` 加，这里只管焦点。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, type RefObject } from 'react';

/** 可聚焦元素。浮层里只有按钮，但把输入类一并写上，将来加表单不必改这里。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    // 记下打开前的焦点位置：关闭后还回去，别让焦点掉到 body 上从头 Tab。
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    // 先聚焦第一个可聚焦项（浮层里第一个是关闭 / 主操作），读屏会立刻念出浮层标题。
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !panel.contains(active);
      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open, panelRef]);
}
