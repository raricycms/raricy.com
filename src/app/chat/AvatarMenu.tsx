'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AvatarMenu.tsx — 消息头像的选项框（拍一拍 / 访问个人主页 / @ta / 取消）。
//
// 用 portal + position: fixed 而不是就地 absolute：消息列表 .chat-list 是
// overflow:auto（一个方向设了 auto，另一个方向也会被算成 auto），就地定位会被
// 列表边缘裁掉，靠顶部/底部的消息尤其明显。portal 到 body 后只需按视口夹取。
//
// 定位在 useLayoutEffect 里做（渲染后、paint 前），先量自身尺寸再摆位，
// 因此不会出现「先闪在错误位置再跳过去」。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';

/** 锚点：头像按钮的视口矩形 + 对齐方向。 */
export interface AvatarMenuAnchor {
  rect: DOMRect;
  /** 我方消息头像在右侧 → 菜单右对齐，避免溢出屏幕 */
  alignRight: boolean;
}

const MENU_GAP = 8; // 菜单与头像的间距
const VIEWPORT_PAD = 8; // 与视口边缘的最小留白

export default function AvatarMenu({
  target,
  anchor,
  onPat,
  onMention,
  onClose,
}: {
  /** 被点击头像的用户 */
  target: { id: string; username: string };
  anchor: AvatarMenuAnchor;
  onPat: () => void;
  onMention: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { rect, alignRight } = anchor;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 垂直：优先贴在头像下方；下方放不下（或会顶出视口）则翻到上方
    let top = rect.bottom + MENU_GAP;
    if (top + h > vh - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, rect.top - MENU_GAP - h);
    }
    // 水平：对方消息左对齐、我方消息右对齐，最后夹进视口
    let left = alignRight ? rect.right - w : rect.left;
    left = Math.min(Math.max(VIEWPORT_PAD, left), Math.max(VIEWPORT_PAD, vw - w - VIEWPORT_PAD));

    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="chat-avatar-menu"
      role="menu"
      aria-label={`${target.username} 的操作`}
      // 首帧还不知道自身尺寸 → 先藏起来，量完再显
      style={{ top: pos?.top, left: pos?.left, visibility: pos ? 'visible' : 'hidden' }}
    >
      <button type="button" role="menuitem" className="chat-avatar-menu__item" onClick={onPat}>
        拍一拍
      </button>
      <Link className="chat-avatar-menu__item" href={`/u/${target.id}`} onClick={onClose}>
        访问个人主页
      </Link>
      <button type="button" role="menuitem" className="chat-avatar-menu__item" onClick={onMention}>
        @ta
      </button>
      <div className="chat-avatar-menu__sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="chat-avatar-menu__item chat-avatar-menu__item--cancel"
        onClick={onClose}
      >
        取消
      </button>
    </div>,
    document.body
  );
}
