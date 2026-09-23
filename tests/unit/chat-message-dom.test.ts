// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// ChatMessageItem.tsx —— 消息 DOM 的**层位**契约（谁住在谁里面）
//
// 【为什么值得单测】连续消息的表头行（回执 / 回复 / 删除）是绝对定位的浮层，
// CSS 靠「贴定位祖先的边」把它挂在气泡外侧。哪一层当那个定位祖先，决定了它贴的是
// 气泡还是「引用块和正文里更长的那一个」：
//   · 挂在 .chat-msg__body 上 → body 的宽度 = max(引用块, 自己的块)，引用比正文长
//     时工具条就被甩到引用那一侧（2026-09 站长报的 bug：对齐的是更长的那一个）
//   · 挂在 .chat-msg__own-blocks 上 → 永远贴自己的块
// 而「哪个元素住在哪个元素里」是**静态结构**，写错了没有任何东西会报错 ——
// tsc 管不着 JSX 的嵌套、e2e 那头的几何断言要跑整站才看得见。这里把它钉死在结构层。
//
// 【为什么不在这里量几何】jsdom 不排版（getBoundingClientRect 恒为 0）。几何在
// tests/e2e/chat-features.spec.ts 的「工具条贴气泡」那条里断。
//
// 【环境】照 avatar-component.test.ts：不引 @testing-library（本仓没有这个依赖），
// 用 react-dom/client 的 createRoot + act 直接驱动。
// 收尾那句 `An update to ForwardRef(LinkComponent) ... not wrapped in act` 是
// next/link 预取自己刷的，测试已经断言完 —— 与本文件无关，别去追。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import ChatMessageItem from '@/app/chat/ChatMessageItem';
import type { ChatMessageDTO } from '@/lib/chat-shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_QUOTE = '引用的一段很长很长的话，长到比这条消息自己的正文还要宽出好大一截。';

function dto(patch: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 1,
    channel_id: 'c1',
    author: { id: 'u1', username: '小明', avatar_url: '/api/avatar/u1', frame_url: null, is_admin: false },
    content: '短',
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

const QUOTE = { id: 9, content: LONG_QUOTE, author_name: '小红', is_deleted: false, image_url: null };

/**
 * 渲染一条消息，返回容器。
 * 用 async act 把挂载后的副作用（RichContentBody 那类 setState）一并冲干净，
 * 否则 React 会刷一堆「update not wrapped in act」告警，把真失败淹掉。
 */
async function render(msg: ChatMessageDTO, opts: { grouped?: boolean; isMine?: boolean } = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ChatMessageItem, {
        msg,
        isMine: opts.isMine ?? true,
        canDelete: true,
        currentUserId: 'u1',
        currentUsername: '小明',
        grouped: opts.grouped ?? false,
        onReply: () => {},
        onDelete: () => {},
        onAvatarClick: () => {},
        onJumpToReply: () => {},
        onImageClick: () => {},
      })
    );
  });
  return container;
}

const q = (el: HTMLElement, sel: string) => el.querySelector(sel);
/** 直接子元素的类名（顺序敏感） */
const kids = (el: HTMLElement, sel: string) =>
  [...q(el, sel)!.children].map((n) => n.className);

describe('表头行的层位（浮层贴谁）', () => {
  it('grouped：表头行住在 .chat-msg__own-blocks 里（浮层的定位祖先就是它）', async () => {
    const c = await render(dto({ reply: QUOTE }), { grouped: true });
    expect(q(c, '.chat-msg__meta')?.parentElement?.className).toContain('chat-msg__own-blocks');
  });

  it('非 grouped：表头行留在 body 里、且在引用块之前（照常占正文上面那一行）', async () => {
    const c = await render(dto({ reply: QUOTE }), { isMine: false });
    expect(q(c, '.chat-msg__meta')?.parentElement?.className).toContain('chat-msg__body');
    // 在流里的表头行必须在引用块**之前** —— 别人的消息引用在上、正文在下，
    // 表头行掉到引用下面去就等于「回复 / 删除」换了位置
    expect(kids(c, '.chat-msg__body')).toEqual([
      'chat-msg__meta',
      'chat-msg__reply',
      'chat-msg__own-blocks',
    ]);
  });

  it('★ 引用块永远不在 .chat-msg__own-blocks 里面（它是别人的话，浮层不贴它）', async () => {
    const c = await render(dto({ reply: QUOTE }), { grouped: true, isMine: false });
    const own = q(c, '.chat-msg__own-blocks')!;
    expect(own.querySelector('.chat-msg__reply')).toBeNull();
    // …且自己的块确实在里面（少了它这层就只剩个空壳，几何断言会去量空气泡）
    expect(own.querySelector('.chat-msg__content')).not.toBeNull();
    // 别人的消息里引用块排在 own-blocks **之前**（引用在上、正文在下）
    expect(kids(c, '.chat-msg__body')).toEqual(['chat-msg__reply', 'chat-msg__own-blocks']);
    // 自己发的消息反过来：正文在上、引用在下
    const mine = await render(dto({ reply: QUOTE }), { grouped: true });
    expect(kids(mine, '.chat-msg__body')).toEqual(['chat-msg__own-blocks', 'chat-msg__reply']);
  });

  it('纯图片消息：图也在 .chat-msg__own-blocks 里（浮层贴图，不贴更宽的引用）', async () => {
    const c = await render(
      dto({ content: '', image: { id: 'i1', url: '/api/images/i1', mime_type: 'image/png' }, reply: QUOTE }),
      { grouped: true, isMine: false }
    );
    const own = q(c, '.chat-msg__own-blocks')!;
    expect(own.querySelector('.chat-msg__image')).not.toBeNull();
    expect(own.querySelector('.chat-msg__reply')).toBeNull();
  });
});
