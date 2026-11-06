// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-menu-keyboard.test.ts —— 三个讨论菜单共用的键盘 / 焦点语义（R3-265）
//
// AvatarMenu 与 ChatChannelMenu 此前只有 Esc：同一套 role="menu" 皮肤，键盘用户
// 却进不去、走不动、关不掉（Tab 还把焦点留在浮层里）。行为已收进 useChatMenu，
// 这里钉住两个旧菜单确实接上了：
//   · 键盘打开 → 焦点进第一项；
//   · ArrowDown / ArrowUp / Home / End 漫游；
//   · Esc 收起并归还焦点给触发控件。
// （ChatMessageMenu 的同一套语义已在 chat-message-menu.test.ts 覆盖。）
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AvatarMenu from '@/app/chat/AvatarMenu';
import ChatChannelMenu from '@/app/chat/ChatChannelMenu';
import type { ChatChannelDTO } from '@/lib/chat-shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

async function mount(el: Parameters<Root['render']>[0]): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(el);
  });
}

/** 先把触发按钮放进 DOM 并聚焦 —— 焦点归还与 :focus-visible 判定都依赖它。 */
function makeTrigger(): HTMLButtonElement {
  const trigger = document.createElement('button');
  trigger.textContent = 'trigger';
  document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

const items = () => [...document.querySelectorAll<HTMLElement>('.chat-menu [role="menuitem"]')];

function press(key: string) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('讨论菜单的键盘/焦点语义（R3-265）', () => {
  it('AvatarMenu：键盘打开 → 焦点进第一项，方向键/Home/End 漫游，Esc 收起并归还焦点', async () => {
    const trigger = makeTrigger();
    const onClose = vi.fn();
    await mount(
      <AvatarMenu
        target={{ id: 'u1', username: '小明' }}
        anchor={{
          rect: trigger.getBoundingClientRect(),
          alignRight: false,
          trigger,
          fromKeyboard: true,
        }}
        onPat={() => {}}
        onMention={() => {}}
        onClose={onClose}
      />
    );

    const menuItems = items();
    expect(menuItems, '菜单项：拍一拍 / 访问个人主页 / @ta / 取消').toHaveLength(4);
    expect(document.activeElement, '键盘打开后焦点应在第一项（否则方向键无从下手）').toBe(
      menuItems[0]
    );

    press('ArrowDown');
    expect(document.activeElement).toBe(menuItems[1]);
    press('End');
    expect(document.activeElement).toBe(menuItems[3]);
    press('Home');
    expect(document.activeElement).toBe(menuItems[0]);

    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);

    // 卸载（菜单收起）后焦点回到触发按钮
    await act(async () => {
      roots.splice(0).forEach((root) => root.unmount());
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('AvatarMenu：指针打开不抢焦点（避免第一项顶着 :focus-visible 蓝框）', async () => {
    const trigger = makeTrigger();
    await mount(
      <AvatarMenu
        target={{ id: 'u1', username: '小明' }}
        anchor={{
          rect: trigger.getBoundingClientRect(),
          alignRight: false,
          trigger,
          fromKeyboard: false,
        }}
        onPat={() => {}}
        onMention={() => {}}
        onClose={() => {}}
      />
    );
    expect(document.activeElement, '鼠标打开时焦点应留在触发按钮，不进菜单').toBe(trigger);
  });

  it('ChatChannelMenu：接上同一套漫游与 Esc 收起，Tab 先归还焦点', async () => {
    const trigger = makeTrigger();
    const onClose = vi.fn();
    const channel = {
      id: 'd_1',
      kind: 'direct',
      title: '小明',
      unread_count: 0,
      peer: { id: 'u1', username: '小明', frame_url: null },
    } as unknown as ChatChannelDTO;

    await mount(
      <ChatChannelMenu
        channel={channel}
        anchor={{
          rect: trigger.getBoundingClientRect(),
          trigger,
          fromKeyboard: true,
        }}
        onMute={() => {}}
        onHide={() => {}}
        onClose={onClose}
      />
    );

    const menuItems = items();
    expect(menuItems, '私聊菜单：静音 / 删除会话 / 取消').toHaveLength(3);
    expect(document.activeElement).toBe(menuItems[0]);

    press('ArrowUp');
    expect(document.activeElement, 'ArrowUp 从第一项回到最后一项（循环）').toBe(menuItems[2]);

    press('Tab');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement, 'Tab 收起前先把焦点还给触发控件').toBe(trigger);
  });
});
