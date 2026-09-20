// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Avatar.tsx —— 共用头像组件的契约
//
// 【为什么值得单测】这个组件要接下全站 15 处头像（下一批逐个替换），而它的几条
// 契约错了都**不会报错**：
//   · 既没有 src 也没有 userId 时必须**不渲染**（匿名评论者那条路）。渲染一个空
//     src 会让浏览器去请求当前页面地址，画一张裂图 —— 而「裂图」在本地开发与
//     e2e 里都不明显。
//   · `frameUrl` 缺省必须**不渲染**框元素。若实现成「总是渲染、src 为空」，
//     e2e 里按 `.avatar__frame` 计数就会全绿而实际全是空标签。
//   · 类名的落点（盒子 vs `<img>`）是各站点 CSS 的前提：`.blog-author img` 这类
//     后代选择器要求 img 还在原位，`.site-user-avatar` 这类要求盒子还在原位。
//     放反了是**静默的版式错乱**，tsc 与构建都不管。
//
// 【环境】与本仓既有的 use-resolved-content.test.ts 同款：不引 @testing-library
// （本仓库没有这个依赖），用 react-dom/client 的 createRoot + act 直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import Avatar from '@/app/components/Avatar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 渲染一次，返回容器。 */
function render(props: Parameters<typeof Avatar>[0]): HTMLElement {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Avatar, props));
  });
  return container;
}

const ID = 'aabbccdd-eeff-0011-2233-445566778899';
const FRAME = '/api/frames/demo';

describe('渲染与不渲染', () => {
  it('★ 既没有 src 也没有 userId → 什么都不渲染（匿名评论者那条路）', () => {
    const box = render({ alt: '匿名用户' });
    expect(box.innerHTML).toBe('');
    expect(box.querySelector('img')).toBeNull();
  });

  it('给了 userId → 头像地址走 avatarUrl（全仓唯一的模板串出处）', () => {
    const box = render({ userId: ID, alt: 'x' });
    expect(box.querySelector('img.avatar__img')?.getAttribute('src')).toBe(`/api/avatar/${ID}`);
  });

  it('src 优先于 userId（DTO 已经给了地址就用它）', () => {
    const box = render({ userId: ID, src: '/api/avatar/other', alt: 'x' });
    expect(box.querySelector('img.avatar__img')?.getAttribute('src')).toBe('/api/avatar/other');
  });

  it('空字符串的 src 当作没给 —— 回落 userId', () => {
    const box = render({ userId: ID, src: '', alt: 'x' });
    expect(box.querySelector('img.avatar__img')?.getAttribute('src')).toBe(`/api/avatar/${ID}`);
  });
});

describe('头像框贴图层', () => {
  it('★ 没有 frameUrl → **不渲染**框元素（不是渲染一个空的）', () => {
    const box = render({ userId: ID, alt: 'x' });
    expect(box.querySelectorAll('img')).toHaveLength(1);
    expect(box.querySelector('.avatar__frame')).toBeNull();
  });

  it('给了 frameUrl → 多一层绝对定位的装饰图', () => {
    const box = render({ userId: ID, frameUrl: FRAME, alt: 'x' });
    const imgs = box.querySelectorAll('img');
    expect(imgs).toHaveLength(2);

    const frame = box.querySelector('img.avatar__frame')!;
    expect(frame.getAttribute('src')).toBe(FRAME);
    // 纯装饰：屏读器不该念它，拖拽也不该拖走它
    expect(frame.getAttribute('alt')).toBe('');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('draggable')).toBe('false');
  });

  it('框在头像**之后** —— 层序决定它盖在上面', () => {
    const box = render({ userId: ID, frameUrl: FRAME, alt: 'x' });
    const imgs = [...box.querySelectorAll('img')];
    expect(imgs[0].classList.contains('avatar__img')).toBe(true);
    expect(imgs[1].classList.contains('avatar__frame')).toBe(true);
  });

  it('alt 只给头像那一层，框那层永远是空串', () => {
    const box = render({ userId: ID, frameUrl: FRAME, alt: '张三' });
    expect(box.querySelector('img.avatar__img')?.getAttribute('alt')).toBe('张三');
    expect(box.querySelector('img.avatar__frame')?.getAttribute('alt')).toBe('');
  });
});

describe('类名的落点（各站点 CSS 的前提）', () => {
  it('className 落在**盒子**上，与 .avatar 并存', () => {
    const box = render({ userId: ID, alt: 'x', className: 'site-user-avatar' });
    const el = box.firstElementChild!;
    expect(el.classList.contains('avatar')).toBe(true);
    expect(el.classList.contains('site-user-avatar')).toBe(true);
  });

  it('imgClassName 落在**头像 img** 上 —— 后代选择器（.blog-author img）要靠它', () => {
    const box = render({ userId: ID, alt: 'x', imgClassName: 'comment-author-avatar' });
    const img = box.querySelector('img.avatar__img')!;
    expect(img.classList.contains('comment-author-avatar')).toBe(true);
    // 框那一层**不**继承 imgClassName，否则站点的尺寸规则会同时命中两层
    const box2 = render({
      userId: ID,
      frameUrl: FRAME,
      alt: 'x',
      imgClassName: 'comment-author-avatar',
    });
    expect(box2.querySelector('img.avatar__frame')!.classList.contains('comment-author-avatar')).toBe(
      false
    );
  });

  it('都不给时盒子只有一个 .avatar', () => {
    const box = render({ userId: ID, alt: 'x' });
    expect(box.firstElementChild!.getAttribute('class')).toBe('avatar');
  });
});

describe('as / onClick / size', () => {
  it('默认是 span', () => {
    expect(render({ userId: ID, alt: 'x' }).firstElementChild!.tagName).toBe('SPAN');
  });

  it('as="button" → 真的 button（讨论消息那处点头像开选项框）', () => {
    const box = render({ userId: ID, alt: 'x', as: 'button' });
    const el = box.firstElementChild!;
    expect(el.tagName).toBe('BUTTON');
    // type=button：别在表单里当 submit 用
    expect(el.getAttribute('type')).toBe('button');
  });

  it('button 变体可点，且能带 title / aria-label', () => {
    let clicked = 0;
    const box = render({
      userId: ID,
      alt: 'x',
      as: 'button',
      onClick: () => {
        clicked += 1;
      },
      title: '拍一拍',
      ariaLabel: '张三的头像',
    });
    const btn = box.querySelector('button')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clicked).toBe(1);
    expect(btn.getAttribute('title')).toBe('拍一拍');
    expect(btn.getAttribute('aria-label')).toBe('张三的头像');
  });

  it('★ size → 内联宽高 + 内联 border-radius 8%（规范 §4.1 明确要求内联也写 8%）', () => {
    const box = render({ userId: ID, alt: 'x', size: 32 });
    const el = box.firstElementChild as HTMLElement;
    expect(el.style.width).toBe('32px');
    expect(el.style.height).toBe('32px');
    expect(el.style.borderRadius).toBe('8%');
  });

  it('不给 size 时盒子不带内联尺寸（尺寸交给站点的类）', () => {
    const box = render({ userId: ID, alt: 'x' });
    const el = box.firstElementChild as HTMLElement;
    expect(el.style.width).toBe('');
    expect(el.style.height).toBe('');
  });

  it('style 与 size 可以并存，size 在前、style 覆盖它', () => {
    const box = render({ userId: ID, alt: 'x', size: 32, style: { width: 40 } });
    expect((box.firstElementChild as HTMLElement).style.width).toBe('40px');
  });
});
