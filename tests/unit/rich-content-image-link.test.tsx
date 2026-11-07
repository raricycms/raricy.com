// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// rich-content-image-link.test.tsx —— 链接内的图片只触发一次动作（R3-126）
//
// 【复现】评论 / 讨论正文由 RichContentBody 承载（阅读页正文已走 ReactiveMD 引擎，
// 那边 image-view 自带 `closest("a")` 判据、不会双动作）。这条管线的图片点击是
// 容器上的事件委托：只要 `img.rich-image-ref` 被点到就开灯箱 —— 若这张图在 `<a>` 里，
// 浏览器随后还会执行链接跳转：一次点击 = 开灯箱 + 离开页面。
//
// 【为什么现在还能出现】content-refs.ts 的 embedImageRefs 只跳过**直接**父节点是 A 的
// 文本节点；正文写成 `[**[@图片/ID]**](url)` 时文本的父节点是 STRONG，图片仍会被插进
// `<a><strong><img…>`。所以「链接里没有图片」这个前提不成立，判据必须改成看祖先。
//
// 修复：点击委托里 `target.closest('a')` 时直接 return —— 链接自己处理这一次点击。
// 独立图片（不在任何 <a> 里）照旧开灯箱。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import RichContentBody from '@/app/components/RichContentBody';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const img = (attrs = '') => `<img class="rich-image-ref" src="/api/images/aaaaaaaaaa/raw" alt=""${attrs}>`;

type Root = ReturnType<typeof createRoot>;
let roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    roots.forEach((root) => root.unmount());
  });
  roots = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(html: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(RichContentBody, {
        content: 'x',
        className: 'test-rich-body',
        render: () => html,
      })
    );
  });
  return container;
}

async function clickImage(container: HTMLElement) {
  const image = container.querySelector('img') as HTMLElement;
  expect(image, '夹具里应当渲染出图片').not.toBeNull();
  await act(async () => {
    image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('RichContentBody —— 图片点击与链接（R3-126）', () => {
  it('★ 链接内的图片（含内联加粗包裹）：点击只交给链接，不叠加灯箱', async () => {
    const container = await mount(`<p><a href="#target"><strong>${img()}</strong></a></p>`);
    await clickImage(container);
    expect(
      document.querySelector('.chat-lightbox'),
      '链接内的图片再开灯箱就是一次点击两个动作'
    ).toBeNull();
  });

  it('链接外但祖先其他内联元素：同样不叠加灯箱', async () => {
    const container = await mount(`<p><a href="#target"><em>${img()}</em></a></p>`);
    await clickImage(container);
    expect(document.querySelector('.chat-lightbox')).toBeNull();
  });

  it('独立图片（不在链接里）：点击照旧开灯箱', async () => {
    const container = await mount(`<p>${img()}</p>`);
    await clickImage(container);
    expect(document.querySelector('.chat-lightbox'), '独立图片必须还能放大').not.toBeNull();
  });
});
