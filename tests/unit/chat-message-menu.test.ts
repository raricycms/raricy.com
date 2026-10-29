// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-message-menu.test.ts —— 更多按钮 / 桌面右键、触屏原生选字、菜单项与键盘焦点。
//
// 【环境】照 chat-message-dom.test.ts：不用 @testing-library（本仓没有这个依赖），
// createRoot + act 直接驱动；jsdom 不排版，几何由 e2e 负责。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChatMessageItem from '@/app/chat/ChatMessageItem';
import ChatMessageMenu from '@/app/chat/ChatMessageMenu';
import type { ChatMessageDTO } from '@/lib/chat-shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function dto(patch: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 1,
    channel_id: 'c1',
    author: { id: 'u1', username: '小明', avatar_url: '/api/avatar/u1', frame_url: null, bubble_key: null, is_admin: false },
    content: '一条消息',
    image: null,
    image_missing: false,
    blog: null,
    blog_missing: false,
    pat: null,
    reply: null,
    is_deleted: false,
    created_at: '2026-09-23T12:00:00.000Z',
    ...patch,
  };
}

/** jsdom 不保证有 PointerEvent；没有就退化成 MouseEvent + 手动补 pointerType。 */
function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string; button?: number }
): Event {
  const base = {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  };
  let ev: Event;
  if (typeof PointerEvent === 'function') {
    ev = new PointerEvent(type, { ...base, pointerType: init.pointerType ?? 'touch' });
  } else {
    ev = new MouseEvent(type, base);
    Object.defineProperty(ev, 'pointerType', { value: init.pointerType ?? 'touch' });
  }
  return ev;
}

function fire(el: Element, ev: Event): Event {
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

const roots: Root[] = [];
const containers: HTMLElement[] = [];

async function mount(el: Parameters<Root['render']>[0]): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(el);
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const c of containers.splice(0)) c.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** 挂一条消息，返回根节点与几个 spy。 */
async function mountMessage(
  msg: ChatMessageDTO,
  opts: { canDelete?: boolean; canSave?: boolean; isMine?: boolean; menuOpen?: boolean; onImageClick?: () => void } = {}
) {
  const onOpenMenu = vi.fn();
  const onImageClick = opts.onImageClick ?? vi.fn();
  const container = await mount(
    createElement(ChatMessageItem, {
      msg,
      isMine: opts.isMine ?? true,
      canDelete: opts.canDelete ?? true,
      currentUserId: 'u1',
      currentUsername: '小明',
      canSave: opts.canSave ?? false,
      menuOpen: opts.menuOpen ?? false,
      onOpenMenu,
      onAvatarClick: () => {},
      onJumpToReply: () => {},
      onImageClick,
    })
  );
  const row = container.querySelector<HTMLElement>('.chat-msg, .chat-pat')!;
  return { row, onOpenMenu, onImageClick };
}

describe('消息操作入口与原生触屏行为', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('右键：落点坐标原样交给菜单，并吃掉浏览器原生菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const ev = fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toMatchObject({ x: 120, y: 80 });
    expect(ev.defaultPrevented, '不 preventDefault 的话原生菜单会盖在自定义菜单上').toBe(true);
  });

  it('键盘菜单键（没有指针坐标）→ 贴着消息左上角开，坐标不能是 (0,0)', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toMatchObject({ x: 12, y: 12 });
  });

  it('更多按钮用自身下沿定位，不依赖点击事件的指针坐标', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const more = row.querySelector<HTMLButtonElement>('.chat-msg__more')!;
    vi.spyOn(more, 'getBoundingClientRect').mockReturnValue({ left: 120, bottom: 80 } as DOMRect);
    fire(more, new MouseEvent('click', { bubbles: true }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toEqual({ x: 120, y: 80, trigger: more });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-label')).toBe('消息操作');
  });

  it('触屏长按与随后的原生菜单不打开消息操作，也不清掉文字选区', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const range = document.createRange();
    range.selectNodeContents(row.querySelector('.chat-msg__content')!);
    window.getSelection()!.addRange(range);
    const selected = window.getSelection()!.toString();
    fire(row, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    act(() => vi.advanceTimersByTime(1000));
    // 部分浏览器的 contextmenu 没有 pointerType，用前一次 pointerdown 作兜底。
    const ev = fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
    expect(onOpenMenu).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    expect(window.getSelection()!.toString()).toBe(selected);
    expect(selected).toContain('一条消息');
  });

  it('原生 contextmenu 自带触屏类型时直接放行', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const ev = fire(row, pointerEvent('contextmenu', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    expect(onOpenMenu).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('菜单打开时按钮报告展开态，对应消息保持操作态', async () => {
    const { row } = await mountMessage(dto(), { menuOpen: true });
    expect(row.classList.contains('chat-msg--menu-open')).toBe(true);
    expect(row.querySelector('.chat-msg__more')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('拍一拍的删除同样有更多按钮', async () => {
    const { row, onOpenMenu } = await mountMessage(dto({ pat: { target_id: 'u2', target_name: '小红' } }));
    fire(row.querySelector('.chat-msg__more')!, new MouseEvent('click', { bubbles: true }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it('没有可做的动作（别人的已删消息）→ 不拦原生右键菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto({ is_deleted: true, content: '[消息已删除]' }), {
      canDelete: false,
      isMine: false,
    });
    const ev = fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(onOpenMenu).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    expect(row.querySelector('.chat-msg__more')).toBeNull();
  });

  it('普通点击正文不打开菜单，图片点击照常放大', async () => {
    const onImageClick = vi.fn();
    const { row, onOpenMenu } = await mountMessage(
      dto({ image: { id: 'i1', url: '/api/images/i1', mime_type: 'image/png' } }),
      { onImageClick }
    );
    const img = row.querySelector<HTMLElement>('.chat-msg__image')!;

    fire(row.querySelector('.chat-msg__content')!, new MouseEvent('click', { bubbles: true }));
    fire(img, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onImageClick).toHaveBeenCalledTimes(1);
    expect(onOpenMenu).not.toHaveBeenCalled();
  });
});

describe('菜单项：按消息语境组合', () => {
  async function mountMenu(overrides: Partial<Parameters<typeof ChatMessageMenu>[0]> = {}) {
    const onClose = vi.fn();
    const onToggleSave = vi.fn();
    const onReply = vi.fn();
    const onDelete = vi.fn();
    await mount(
      createElement(ChatMessageMenu, {
        msg: dto(),
        anchor: { x: 40, y: 40 },
        saved: false,
        canSave: false,
        canReply: true,
        canDelete: true,
        onToggleSave,
        onReply,
        onDelete,
        onClose,
        ...overrides,
      })
    );
    const items = () =>
      [...document.querySelectorAll('.chat-menu [role="menuitem"]')].map((n) => n.textContent);
    return { onClose, onToggleSave, onReply, onDelete, items };
  }

  it('私聊自己发的消息：保存 / 回复 / 删除 + 取消', async () => {
    const { items } = await mountMenu({ canSave: true });
    expect(items()).toEqual(['保存', '回复', '删除', '取消']);
    expect(document.querySelectorAll('.chat-menu__sep')).toHaveLength(1);
  });

  it('已保存过 → 第一项变成「已保存」', async () => {
    const { items } = await mountMenu({ canSave: true, saved: true });
    expect(items()).toEqual(['已保存', '回复', '删除', '取消']);
  });

  it('大区里别人的消息：没有保存、没有删除', async () => {
    const { items } = await mountMenu({ canSave: false, canDelete: false });
    expect(items()).toEqual(['回复', '取消']);
  });

  it('拍一拍：只有删除（不能保存也不能回复）', async () => {
    const { items } = await mountMenu({ canSave: false, canReply: false });
    expect(items()).toEqual(['删除', '取消']);
  });

  it('点菜单项先收起菜单再执行动作', async () => {
    const { onClose, onToggleSave } = await mountMenu({ canSave: true });
    const save = [...document.querySelectorAll<HTMLElement>('.chat-menu [role="menuitem"]')][0];
    act(() => {
      save.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggleSave).toHaveBeenCalledTimes(1);
  });

  it('取消只收菜单，不做动作', async () => {
    const { onClose, onDelete } = await mountMenu({ canSave: true });
    const cancel = [...document.querySelectorAll<HTMLElement>('.chat-menu [role="menuitem"]')].pop()!;
    act(() => {
      cancel.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('进入菜单后聚焦第一项，方向键 / Home / End 可以选择', async () => {
    await mountMenu({ canSave: true });
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    for (const [key, index] of [['ArrowUp', 3], ['ArrowDown', 0], ['End', 3], ['Home', 0], ['ArrowDown', 1]] as const) {
      fire(document.activeElement!, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(items[index]);
    }
  });

  it('Esc 关闭后焦点回到消息的更多按钮', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const { onClose } = await mountMenu({ anchor: { x: 40, y: 40, trigger } });
    fire(document.activeElement!, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => roots.pop()!.unmount());
    expect(document.activeElement).toBe(trigger);
  });
});
