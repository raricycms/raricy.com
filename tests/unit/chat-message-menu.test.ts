// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-message-menu.test.ts —— 更多按钮 / 桌面右键 / 触屏长按、单击详情、菜单项与键盘焦点。
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
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** 挂一条消息，返回根节点与几个 spy。 */
async function mountMessage(
  msg: ChatMessageDTO,
  opts: { canDelete?: boolean; canSave?: boolean; isMine?: boolean; onImageClick?: () => void } = {}
) {
  const onOpenMenu = vi.fn();
  const onOpenDetail = vi.fn();
  const onImageClick = opts.onImageClick ?? vi.fn();
  const container = await mount(
    createElement(ChatMessageItem, {
      msg,
      isMine: opts.isMine ?? true,
      canDelete: opts.canDelete ?? true,
      currentUserId: 'u1',
      currentUsername: '小明',
      canSave: opts.canSave ?? false,
      onOpenMenu,
      onOpenDetail,
      onAvatarClick: () => {},
      onJumpToReply: () => {},
      onImageClick,
    })
  );
  const row = container.querySelector<HTMLElement>('.chat-msg, .chat-pat')!;
  return { row, onOpenMenu, onOpenDetail, onImageClick };
}

describe('消息操作入口（右键 / 长按）与详情', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('右键：落点坐标原样交给菜单，并吃掉浏览器原生菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const ev = fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toMatchObject({ x: 120, y: 80, fromKeyboard: false });
    expect(ev.defaultPrevented, '不 preventDefault 的话原生菜单会盖在自定义菜单上').toBe(true);
  });

  it('键盘菜单键（没有指针坐标）→ 贴着消息左上角开，坐标不能是 (0,0)', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toMatchObject({ x: 12, y: 12, fromKeyboard: true });
  });

  it('消息上没有常驻的更多按钮（入口只有右键 / 长按）', async () => {
    const { row } = await mountMessage(dto());
    expect(row.querySelector('.chat-msg__more')).toBeNull();
    expect(row.querySelector('[aria-label="消息操作"]')).toBeNull();
  });

  it('触屏长按 → 打开操作菜单，且不产生浏览器选区', async () => {
    const { row, onOpenMenu, onOpenDetail } = await mountMessage(dto());
    fire(row, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    expect(row.classList.contains('chat-msg--pressed'), '按下时要有按压反馈').toBe(true);
    act(() => vi.advanceTimersByTime(600));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toMatchObject({ x: 30, y: 40, fromKeyboard: false });
    expect(row.classList.contains('chat-msg--pressed'), '长按已转为菜单，反馈要撤掉').toBe(false);
    fire(row, pointerEvent('pointerup', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    // 长按松手后浏览器可能补一个 click：必须吞掉，不能同屏再弹详情。
    fire(row.querySelector('.chat-msg__content')!, new MouseEvent('click', { bubbles: true }));
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(window.getSelection()!.toString()).toBe('');
  });

  it('触屏滑动超过容差 → 取消按压反馈与长按计时', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    fire(row, pointerEvent('pointermove', { clientX: 30, clientY: 90, pointerType: 'touch' }));
    expect(row.classList.contains('chat-msg--pressed')).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('触屏 contextmenu 一律吃掉：长按面板由我们接管', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const ev = fire(row, pointerEvent('contextmenu', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    expect(ev.defaultPrevented).toBe(true);
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('没有可做的动作（别人的已删消息）→ 触屏 contextmenu 仍放行', async () => {
    const { row } = await mountMessage(dto({ is_deleted: true, content: '[消息已删除]' }), {
      canDelete: false,
      isMine: false,
    });
    const ev = fire(row, pointerEvent('contextmenu', { clientX: 10, clientY: 10, pointerType: 'touch' }));
    expect(ev.defaultPrevented).toBe(false);
  });

  it('单击正文 → 打开消息详情，不打开菜单', async () => {
    const { row, onOpenMenu, onOpenDetail } = await mountMessage(dto());
    fire(row.querySelector('.chat-msg__content')!, new MouseEvent('click', { bubbles: true }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('有文字选区时单击不开详情（拖选结束的收尾 click）', async () => {
    const { row, onOpenDetail } = await mountMessage(dto());
    const content = row.querySelector('.chat-msg__content')!;
    const range = document.createRange();
    range.selectNodeContents(content);
    window.getSelection()!.addRange(range);
    fire(content, new MouseEvent('click', { bubbles: true }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('鼠标按下后拖动再松手（拖选）→ 不开详情', async () => {
    const { row, onOpenDetail } = await mountMessage(dto());
    const content = row.querySelector('.chat-msg__content')!;
    fire(content, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'mouse' }));
    fire(content, pointerEvent('pointerup', { clientX: 90, clientY: 40, pointerType: 'mouse' }));
    fire(content, new MouseEvent('click', { bubbles: true, clientX: 90, clientY: 40 }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('拍一拍同样可以长按打开操作菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(
      dto({ pat: { target_id: 'u2', target_name: '小红' } })
    );
    fire(row, pointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'touch' }));
    act(() => vi.advanceTimersByTime(600));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(row.querySelector('.chat-msg__more')).toBeNull();
  });

  it('没有可做的动作（别人的已删消息）→ 不拦原生右键菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto({ is_deleted: true, content: '[消息已删除]' }), {
      canDelete: false,
      isMine: false,
    });
    const ev = fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(onOpenMenu).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('图片点击照常放大且不打开详情 / 菜单', async () => {
    const onImageClick = vi.fn();
    const { row, onOpenMenu, onOpenDetail } = await mountMessage(
      dto({ image: { id: 'i1', url: '/api/images/i1', mime_type: 'image/png' } }),
      { onImageClick }
    );
    const img = row.querySelector<HTMLElement>('.chat-msg__image')!;
    fire(img, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onImageClick).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(onOpenMenu).not.toHaveBeenCalled();
  });
});

describe('菜单项：按消息语境组合', () => {
  async function mountMenu(overrides: Partial<Parameters<typeof ChatMessageMenu>[0]> = {}) {
    const onClose = vi.fn();
    const onToggleSave = vi.fn();
    const onReply = vi.fn();
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    await mount(
      createElement(ChatMessageMenu, {
        msg: dto(),
        anchor: { x: 40, y: 40 },
        saved: false,
        canSave: false,
        canReply: true,
        canCopy: true,
        canDelete: true,
        onToggleSave,
        onReply,
        onCopy,
        onDelete,
        onClose,
        ...overrides,
      })
    );
    const items = () =>
      [...document.querySelectorAll('.chat-menu [role="menuitem"]')].map((n) => n.textContent);
    return { onClose, onToggleSave, onReply, onCopy, onDelete, items };
  }

  it('私聊自己发的消息：回复 / 复制 / 保存 / 删除 + 取消', async () => {
    const { items } = await mountMenu({ canSave: true });
    expect(items()).toEqual(['回复', '复制', '保存', '删除', '取消']);
    expect(document.querySelectorAll('.chat-menu__sep')).toHaveLength(1);
  });

  it('已保存过 → 保存项变成「已保存」', async () => {
    const { items } = await mountMenu({ canSave: true, saved: true });
    expect(items()).toEqual(['回复', '复制', '已保存', '删除', '取消']);
  });

  it('大区里别人的消息：没有保存、没有删除，复制仍在', async () => {
    const { items } = await mountMenu({ canSave: false, canDelete: false });
    expect(items()).toEqual(['回复', '复制', '取消']);
  });

  it('拍一拍：只有删除（不能保存、不能回复、不能复制正文）', async () => {
    const { items } = await mountMenu({ canSave: false, canReply: false, canCopy: false });
    expect(items()).toEqual(['删除', '取消']);
  });

  it('点菜单项先收起菜单再执行动作', async () => {
    const { onClose, onToggleSave } = await mountMenu({ canSave: true });
    const save = [...document.querySelectorAll<HTMLElement>('.chat-menu [role="menuitem"]')].find(
      (n) => n.textContent === '保存'
    )!;
    act(() => {
      save.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggleSave).toHaveBeenCalledTimes(1);
  });

  it('点「复制」先收起菜单再交给复制回调', async () => {
    const { onClose, onCopy } = await mountMenu();
    const copy = [...document.querySelectorAll<HTMLElement>('.chat-menu [role="menuitem"]')].find(
      (n) => n.textContent === '复制'
    )!;
    act(() => {
      copy.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);
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
    for (const [key, index] of [['ArrowUp', 4], ['ArrowDown', 0], ['End', 4], ['Home', 0], ['ArrowDown', 1]] as const) {
      fire(document.activeElement!, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(items[index]);
    }
  });

  it('指针打开（右键 / 长按）不抢焦点：第一项不该有蓝色 focus 框', async () => {
    await mountMenu({ anchor: { x: 40, y: 40, fromKeyboard: false } });
    const first = document.querySelector<HTMLButtonElement>('.chat-menu [role="menuitem"]')!;
    expect(document.activeElement).not.toBe(first);
  });

  it('键盘打开（菜单键 / Shift+F10）才把焦点放到第一项', async () => {
    await mountMenu({ anchor: { x: 12, y: 12, fromKeyboard: true } });
    const first = document.querySelector<HTMLButtonElement>('.chat-menu [role="menuitem"]')!;
    expect(document.activeElement).toBe(first);
  });

  it('Esc 关闭后焦点回到传入的触发控件', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const { onClose } = await mountMenu({ anchor: { x: 40, y: 40, trigger } });
    fire(document.activeElement!, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => roots.pop()!.unmount());
    expect(document.activeElement).toBe(trigger);
  });
});
