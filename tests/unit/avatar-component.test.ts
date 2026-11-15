// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Avatar.tsx —— 共用头像组件的**渲染/不渲染**契约
//
// 【为什么值得单测】这个组件要接下全站 15 处头像，而它的几条契约错了都**不会报错**：
//   · 既没有 src 也没有 userId 时必须**不渲染**（匿名评论者那条路）。渲染一个空
//     src 会让浏览器去请求当前页面地址，画一张裂图 —— 而「裂图」在本地开发与
//     e2e 里都不明显。
//   · `frameUrl` 缺省必须**不渲染**框元素。若实现成「总是渲染、src 为空」，
//     e2e 里按 `.avatar__frame` 计数就会全绿而实际全是空标签。
//
// 类名落点 / as / size / alt 空串等外观断言按测试精简口径已删除（CSS 落点靠页面检查）。
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

  it('给了 frameUrl → 多渲染一层框图，src 指向框资源', () => {
    const box = render({ userId: ID, frameUrl: FRAME, alt: 'x' });
    expect(box.querySelectorAll('img')).toHaveLength(2);
    const frame = box.querySelector('img.avatar__frame')!;
    expect(frame.getAttribute('src')).toBe(FRAME);
  });
});
