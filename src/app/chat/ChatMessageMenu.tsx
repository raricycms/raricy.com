'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageMenu.tsx — 单条消息的操作菜单（回复 / 复制 / 保存 / 删除）。
//
// 两个入口打开同一份菜单：桌面右键、触屏长按（消息上没有常驻按钮）。
// 菜单项按权限出现：回复（未删除、非拍一拍）/ 复制（有正文）/
// 保存（私聊、未删除、非拍一拍）/ 删除（本人或管理员）。
//
// 打开期间由 ChatMessageItem 给对应消息挂 `chat-msg--menu-open`（持续淡底高亮）。
//
// 【定位】portal + position: fixed + useLayoutEffect 量尺寸摆位 —— 与 AvatarMenu /
// ChatChannelMenu 同一套（消息列表 .chat-list 是 overflow:auto，就地 absolute 会被
// 裁掉）。右键 / 长按落点都转换成视口坐标，两个方向夹入视口，放不下就翻到另一侧。
//
// 【皮肤】三个讨论菜单共用 `.chat-menu` 这一套（原来叫 .chat-avatar-menu，加第三个
// 使用者时改了名 —— 它本来就不是头像专属的）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessageDTO } from '@/lib/chat-shared';

/** 右键 / 长按落点的视口坐标。 */
export interface MessageMenuAnchor {
  x: number;
  y: number;
  /**
   * 这次是键盘打开的吗（菜单键 / Shift+F10）。
   *
   * 【为什么要区分】菜单打开后会把焦点放到第一项（ARIA menu 的可达性要求），而
   * 浏览器会把「脚本在指针操作后设置的焦点」也判成 `:focus-visible` —— 于是鼠标
   * 右键刚打开菜单，第一项「回复」就顶着一圈蓝色 outline，看着像我们已经替用户
   * 选中了它。指针打开（右键 / 长按）不抢焦点；键盘打开才抢。`undefined` 按键盘
   * 处理（测试与旧调用点的默认值）。
   */
  fromKeyboard?: boolean;
  /** 可选的触发控件：关闭后把焦点还给它。消息上没有常驻入口，通常不传。 */
  trigger?: HTMLButtonElement;
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
  canCopy,
  canDelete,
  onToggleSave,
  onReply,
  onCopy,
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
  /** 有正文且未删除 / 非拍一拍：复制走正文原文（不是渲染后的富文本）。 */
  canCopy: boolean;
  canDelete: boolean;
  onToggleSave: (m: ChatMessageDTO) => void;
  onReply: (m: ChatMessageDTO) => void;
  onCopy: (m: ChatMessageDTO) => void;
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
    // 垂直：优先在锚点下方；下方放不下则翻到上方。
    let top = anchor.y + MENU_GAP;
    if (top + h > vh - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, anchor.y - MENU_GAP - h);
    }
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    if (!pos) return;
    // 指针打开不抢焦点：否则浏览器会给第一项画 :focus-visible 蓝框（看起来像
    // 右键点出了选中态）。键盘打开才把焦点移到第一项，方向键随即可用。
    if (anchor.fromKeyboard === false) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [pos, anchor.fromKeyboard]);

  useEffect(() => {
    const menu = ref.current;
    return () => {
      // 回复等动作可能已把焦点交给输入框，此时不能再抢回来。
      if (menu?.contains(document.activeElement) || document.activeElement === document.body) {
        anchor.trigger?.focus({ preventScroll: true });
      }
    };
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (!ref.current?.contains(document.activeElement)) return;
      const items = [...ref.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (e.key === 'ArrowDown') next = (index + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'Tab') {
        // 先回到触发按钮，让浏览器默认的 Tab 接着走页面的焦点顺序。
        anchor.trigger?.focus({ preventScroll: true });
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
  }, [anchor, onClose]);

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
      {canReply && (
        <button type="button" role="menuitem" className="chat-menu__item" onClick={run(onReply)}>
          回复
        </button>
      )}
      {canCopy && (
        <button type="button" role="menuitem" className="chat-menu__item" onClick={run(onCopy)}>
          复制
        </button>
      )}
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
      {(canSave || canReply || canCopy || canDelete) && (
        <div className="chat-menu__sep" role="separator" />
      )}
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
