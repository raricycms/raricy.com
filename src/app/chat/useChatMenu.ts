'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useChatMenu.ts — 三个讨论菜单（头像 / 会话行 / 消息）共用的收起与键盘行为
//
// 【为什么抽出来】ChatMessageMenu 早就有一套完整的菜单语义（Esc / 方向键 / Home /
// End / Tab 收起 / 焦点归还 / 外部点击 / 滚动缩放收起），而 AvatarMenu 与
// ChatChannelMenu 只有 Esc —— 同一套 `.chat-menu` 皮肤、同一个 role="menu"，
// 键盘用户却只有三分之一的菜单能用。把行为收成一份，新菜单默认就是可达的。
//
// 【焦点纪律】
//   · 指针打开（右键 / 点击）不抢焦点：否则浏览器会给第一项画 :focus-visible 蓝框，
//     看起来像已经替用户选中了它；键盘打开才把焦点移到第一项。
//   · 关闭时只在焦点还在菜单里（或落在 body）时归还给触发控件 —— 菜单项点了「回复」
//     之类会把焦点交给输入框，那时不能再抢回去。
//   · Tab 先归还焦点再关，浏览器默认的 Tab 接着走页面焦点顺序。
//   · 菜单首帧是 visibility:hidden（量完尺寸才显示），隐藏元素不可聚焦，所以
//     `ready`（定位完成）之后才做首次聚焦。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, type RefObject } from 'react';

export interface ChatMenuBehaviorOptions {
  /** 菜单根元素 */
  menuRef: RefObject<HTMLElement | null>;
  /** 触发控件：关闭后焦点归还给它（消息菜单通常没有常驻入口，可不传） */
  trigger?: HTMLElement | null;
  /** 是否键盘打开（默认 true；指针打开传 false，不抢焦点） */
  fromKeyboard?: boolean;
  /** 定位完成（首帧隐藏期间不可聚焦） */
  ready: boolean;
  onClose: () => void;
}

export function useChatMenuBehavior({
  menuRef,
  trigger,
  fromKeyboard = true,
  ready,
  onClose,
}: ChatMenuBehaviorOptions): void {
  // 键盘打开：焦点进菜单第一项，方向键随即可用
  useEffect(() => {
    if (!ready || !fromKeyboard) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [ready, fromKeyboard, menuRef]);

  // 关闭（卸载）时归还焦点
  useEffect(() => {
    const menu = menuRef.current;
    return () => {
      if (menu?.contains(document.activeElement) || document.activeElement === document.body) {
        trigger?.focus({ preventScroll: true });
      }
    };
  }, [menuRef, trigger]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      // 点「同一个触发器」时不在 pointerdown 里关：交给它的 click 做 toggle。
      // 否则顺序是 pointerdown 先关、click 又写回 → 菜单原地重开（本组件的旧 bug）。
      if (trigger?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      const menu = menuRef.current;
      if (!menu?.contains(document.activeElement)) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (e.key === 'ArrowDown') next = (index + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'Tab') {
        trigger?.focus({ preventScroll: true });
        onClose();
        return;
      } else return;
      e.preventDefault();
      items[next]?.focus({ preventScroll: true });
    };
    // 列表滚动 / 窗口缩放 → 锚点已经不在原位了，直接收起（比跟着重算更稳）。
    // scroll 不冒泡，但捕获阶段能拿到列表内部的滚动。
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [menuRef, trigger, onClose]);
}
