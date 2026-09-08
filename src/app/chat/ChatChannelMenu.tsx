'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatChannelMenu.tsx — 会话行的「⋯」操作菜单（静音 / 删除会话）
//
// 定位与收起逻辑照 AvatarMenu（portal + fixed + useLayoutEffect 量尺寸摆位 +
// 外部点击/Esc/滚动收起）—— 侧栏 .chat-sidebar__list 是 overflow:auto，
// 就地 absolute 会被裁掉。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatChannelDTO } from '@/lib/chat-shared';

export interface ChannelMenuAnchor {
  rect: DOMRect;
}

const MENU_GAP = 8;
const VIEWPORT_PAD = 8;

export default function ChatChannelMenu({
  channel,
  anchor,
  onMute,
  onHide,
  onClose,
}: {
  channel: ChatChannelDTO;
  anchor: ChannelMenuAnchor;
  onMute: (muted: boolean) => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { rect } = anchor;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.bottom + MENU_GAP;
    if (top + h > vh - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, rect.top - MENU_GAP - h);
    }
    let left = rect.left;
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
      aria-label={`${channel.title} 的操作`}
      style={{ top: pos?.top, left: pos?.left, visibility: pos ? 'visible' : 'hidden' }}
    >
      <button
        type="button"
        role="menuitem"
        className="chat-avatar-menu__item"
        onClick={() => onMute(!channel.muted)}
      >
        {channel.muted ? '取消静音' : '静音'}
      </button>
      {channel.kind === 'direct' && (
        <button
          type="button"
          role="menuitem"
          className="chat-avatar-menu__item chat-avatar-menu__item--danger"
          onClick={onHide}
        >
          删除会话
        </button>
      )}
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
