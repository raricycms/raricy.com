// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-message-menu.test.ts —— 消息操作菜单（保存 / 回复 / 删除）的两半：
//   · ChatMessageItem 的手势层：右键 / 长按 → onOpenMenu，鼠标按住不算，滑动取消，
//     长按后的那一次 click 要吞掉（否则顺带点开图片）；
//   · ChatMessageMenu 的菜单项：按 canSave / canReply / canDelete 组合渲染，点一项
//     先 onClose 再执行动作。
//
// 【为什么值得单测】手势是「计时器 + 三个指针事件 + 一个 click 捕获」的组合，写错
// 任何一处都不会报错 —— 症状只是「长按没反应」「长按后图片被放大」「滚列表时误弹
// 菜单」，e2e 里还得靠真触摸才看得见。菜单项的显隐组合（大区没有保存、拍一拍没有
// 回复、已删消息没有删除）同样是静默的。
//
// 【环境】照 chat-message-dom.test.ts：不用 @testing-library（本仓没有这个依赖），
// createRoot + act 直接驱动；jsdom 不排版，几何由 e2e 负责。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChatMessageItem, { MESSAGE_LONG_PRESS_MS } from '@/app/chat/ChatMessageItem';
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
  opts: { canDelete?: boolean; canSave?: boolean; isMine?: boolean; onImageClick?: () => void } = {}
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
      onOpenMenu,
      onAvatarClick: () => {},
      onJumpToReply: () => {},
      onImageClick,
    })
  );
  const row = container.querySelector<HTMLElement>('.chat-msg')!;
  return { row, onOpenMenu, onImageClick };
}

describe('消息手势：右键 / 长按唤出菜单', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('右键：落点坐标原样交给菜单，并吃掉浏览器原生菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    const ev = fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toEqual({ x: 120, y: 80 });
    expect(ev.defaultPrevented, '不 preventDefault 的话原生菜单会盖在自定义菜单上').toBe(true);
  });

  it('键盘菜单键（没有指针坐标）→ 贴着消息左上角开，坐标不能是 (0,0)', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toEqual({ x: 12, y: 12 });
  });

  it('触屏长按 → 到时长才开菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    act(() => {
      vi.advanceTimersByTime(MESSAGE_LONG_PRESS_MS - 1);
    });
    expect(onOpenMenu, '没到时长就弹菜单').not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onOpenMenu.mock.calls[0][1]).toEqual({ x: 30, y: 40 });
  });

  it('长按过程中手指滑动（滚列表）→ 取消，不弹菜单', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    fire(row, pointerEvent('pointermove', { clientX: 60, clientY: 40, pointerType: 'touch' }));
    act(() => {
      vi.advanceTimersByTime(MESSAGE_LONG_PRESS_MS + 50);
    });
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('鼠标按住不动不算长按（长按只给触屏）', async () => {
    const { row, onOpenMenu } = await mountMessage(dto());
    fire(row, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'mouse' }));
    act(() => {
      vi.advanceTimersByTime(MESSAGE_LONG_PRESS_MS + 50);
    });
    expect(onOpenMenu).not.toHaveBeenCalled();
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

  it('长按弹出的那一次 click 被吞掉；下一次正常点击仍然生效', async () => {
    const onImageClick = vi.fn();
    const { row } = await mountMessage(
      dto({ content: '', image: { id: 'i1', url: '/api/images/i1', mime_type: 'image/png' } }),
      { onImageClick }
    );
    const img = row.querySelector<HTMLElement>('.chat-msg__image')!;

    // 长按（气泡里点图）→ 菜单开 → 抬手那次 click 不该放大图片
    fire(img, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    act(() => {
      vi.advanceTimersByTime(MESSAGE_LONG_PRESS_MS + 10);
    });
    fire(img, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onImageClick, '长按后的 click 顺带把图片放大了').not.toHaveBeenCalled();

    // 新手势开始即解禁 → 正常点击照旧放大
    fire(img, pointerEvent('pointerdown', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    fire(img, pointerEvent('pointerup', { clientX: 30, clientY: 40, pointerType: 'touch' }));
    fire(img, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onImageClick).toHaveBeenCalledTimes(1);
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
});
