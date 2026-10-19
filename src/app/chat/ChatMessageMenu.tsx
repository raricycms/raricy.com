'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageMenu.tsx — 单条消息的操作菜单（保存 / 回复 / 删除），右键或长按唤出。
//
// 【为什么不再是 hover 工具条】操作条原来挂在表头行里、`:hover` 才显形。它在触屏上
// 只能靠「点一下→粘住 hover」这种偶然行为打开，而且把三个文字按钮摆在名字旁边，
// 静默挤占气泡外侧的宽度。现在消息本身没有任何常驻按钮：桌面右键、触屏长按，位置
// 就是指针落点（`ChatMessageItem` 的 useMessageMenuTrigger 负责识别手势）。
//
// 【定位】portal + position: fixed + useLayoutEffect 量尺寸摆位 —— 与 AvatarMenu /
// ChatChannelMenu 同一套（消息列表 .chat-list 是 overflow:auto，就地 absolute 会被
// 裁掉）。区别只在锚点：这里是**指针落点**，不是控件矩形，所以两个方向都要夹进视口，
// 放不下就翻到落点的另一侧。
//
// 【皮肤】三个讨论菜单共用 `.chat-menu` 这一套（原来叫 .chat-avatar-menu，加第三个
// 使用者时改了名 —— 它本来就不是头像专属的）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessageDTO } from '@/lib/chat-shared';

/** 指针落点的视口坐标（clientX / clientY）。 */
export interface MessageMenuAnchor {
  x: number;
  y: number;
}

/** 菜单与指针落点的间距（避免菜单正好压住点击处的文字）。 */
const MENU_GAP = 2;
/** 与视口边缘的最小留白。 */
const VIEWPORT_PAD = 8;

export default function ChatMessageMenu({
  msg,
  anchor,
  saved,
  canSave,
  canReply,
  canDelete,
  onToggleSave,
  onReply,
  onDelete,
  onClose,
}: {
  /** 当前操作的这条消息（菜单项按它决定哪些动作可用） */
  msg: ChatMessageDTO;
  anchor: MessageMenuAnchor;
  /** 我在保存箱里存过这条（菜单项显示「已保存」，点一下是取消） */
  saved: boolean;
  /** 只有私聊、未删除、非拍一拍的消息能进保存箱（大区消息不进） */
  canSave: boolean;
  canReply: boolean;
  canDelete: boolean;
  onToggleSave: (m: ChatMessageDTO) => void;
  onReply: (m: ChatMessageDTO) => void;
  onDelete: (m: ChatMessageDTO) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 水平：优先在落点右侧展开；右边放不下就翻到落点左侧，最后夹进视口
    let left = anchor.x + MENU_GAP;
    if (left + w > vw - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, anchor.x - MENU_GAP - w);
    }
    // 垂直：优先在落点下方；下方放不下则翻到上方（触屏长按靠近屏幕底部时很常见）
    let top = anchor.y + MENU_GAP;
    if (top + h > vh - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, anchor.y - MENU_GAP - h);
    }
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

  // 菜单项一律「先收起、再执行」：删除会弹 confirm / prompt，菜单留着会挡在后面。
  const run = (fn: (m: ChatMessageDTO) => void) => () => {
    onClose();
    fn(msg);
  };

  return createPortal(
    <div
      ref={ref}
      className="chat-menu"
      role="menu"
      aria-label="消息操作"
      // 首帧还不知道自身尺寸 → 先藏起来，量完再显
      style={{ top: pos?.top, left: pos?.left, visibility: pos ? 'visible' : 'hidden' }}
    >
      {canSave && (
        <button
          type="button"
          role="menuitem"
          className="chat-menu__item"
          onClick={run(onToggleSave)}
          title={saved ? '从保存箱里移除（消息本身不会被删除）' : '保存到保存箱（只有自己看得到）'}
        >
          {saved ? '已保存' : '保存'}
        </button>
      )}
      {canReply && (
        <button type="button" role="menuitem" className="chat-menu__item" onClick={run(onReply)}>
          回复
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          role="menuitem"
          className="chat-menu__item chat-menu__item--danger"
          onClick={run(onDelete)}
        >
          删除
        </button>
      )}
      {(canSave || canReply || canDelete) && <div className="chat-menu__sep" role="separator" />}
      <button
        type="button"
        role="menuitem"
        className="chat-menu__item chat-menu__item--cancel"
        onClick={onClose}
      >
        取消
      </button>
    </div>,
    document.body
  );
}
