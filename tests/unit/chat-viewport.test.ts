// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-viewport.test.ts —— 讨论区「软键盘让位」的决策与副作用
//
// 【为什么值得单测】这段逻辑在无头浏览器 / 桌面里**永远走不到键盘分支**（没有软键盘、
// pointer 也不是 coarse），而它一旦判错，症状全是静默的：
//   · 把**捏合缩放**当成键盘 → 界面被按缩放倍率挤扁；
//   · 把**地址栏收放**当成键盘 → 无谓抖动；
//   · 只在触屏生效的闸门漏了 → 桌面拖窗口也跟着变；
//   · 卸载不清自定义属性 → 下一次进来高度停在旧值；监听不摘 → 泄漏。
// 真机 iOS 键盘由协调者另做自动化/浏览器核对，这里守住的是**决策**与**DOM 副作用**。
//
// 【环境】不引 @testing-library/react（本仓库无此依赖），用 react-dom/client 的
// createRoot + act 驱动，照 use-user-cards.test.ts 的路子；visualViewport 与
// matchMedia 用桩替掉（jsdom 没有 visualViewport）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CHAT_VV_BOTTOM_VAR,
  KEYBOARD_MIN_PX,
  ZOOM_EPSILON,
  applyChatViewportBottom,
  chatViewportBottomPx,
  type ChatViewportInput,
} from '@/lib/chat-viewport';
import { useChatViewport } from '@/app/chat/useChatViewport';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 各字段都能被用例覆盖的默认入参：一个「键盘弹起」的合理场景。 */
function baseInput(over: Partial<ChatViewportInput> = {}): ChatViewportInput {
  return {
    supported: true,
    coarsePointer: true,
    scale: 1,
    innerHeight: 800,
    vvHeight: 500,
    vvOffsetTop: 0,
    ...over,
  };
}

describe('chatViewportBottomPx —— 决策', () => {
  it('无效的缩放和视口读数回退到 CSS，不写入错误高度', () => {
    for (const patch of [
      { scale: NaN }, { scale: Infinity }, { innerHeight: NaN },
      { vvHeight: 0 }, { vvOffsetTop: -1 },
    ]) {
      expect(chatViewportBottomPx(baseInput(patch))).toBeNull();
    }
  });
  it('键盘弹起（触屏、未缩放、收缩够大）→ 可视区下沿', () => {
    expect(chatViewportBottomPx(baseInput())).toBe(500);
  });

  it('把 offsetTop 一并算进下沿（iOS 会为露出输入框把可视区上推）', () => {
    expect(chatViewportBottomPx(baseInput({ vvOffsetTop: 120 }))).toBe(620);
  });

  it('下沿取整，避免半像素导致每帧都改写样式', () => {
    expect(chatViewportBottomPx(baseInput({ vvHeight: 499.6 }))).toBe(500);
  });

  it('没弹键盘（可视区与布局视口等高）→ null', () => {
    expect(chatViewportBottomPx(baseInput({ vvHeight: 800 }))).toBeNull();
  });

  it('只是地址栏收放（收缩 < 阈值）→ null', () => {
    expect(chatViewportBottomPx(baseInput({ vvHeight: 800 - (KEYBOARD_MIN_PX - 1) }))).toBeNull();
  });

  it('恰好到阈值就算键盘（边界含等）', () => {
    const vvHeight = 800 - KEYBOARD_MIN_PX;
    expect(chatViewportBottomPx(baseInput({ vvHeight }))).toBe(vvHeight);
  });

  it('捏合缩放（scale != 1）不当键盘 —— 否则界面被按倍率挤扁', () => {
    expect(chatViewportBottomPx(baseInput({ scale: 1.5 }))).toBeNull();
    expect(chatViewportBottomPx(baseInput({ scale: 0.5 }))).toBeNull();
    // 容差之内仍按未缩放处理
    expect(chatViewportBottomPx(baseInput({ scale: 1 + ZOOM_EPSILON / 2 }))).toBe(500);
  });

  it('非触屏（fine pointer）不进入键盘分支', () => {
    expect(chatViewportBottomPx(baseInput({ coarsePointer: false }))).toBeNull();
  });

  it('浏览器不支持 visualViewport → null', () => {
    expect(chatViewportBottomPx(baseInput({ supported: false }))).toBeNull();
  });

  it('几何非法（offsetTop 非有限数）→ null，不写出 NaN', () => {
    expect(chatViewportBottomPx(baseInput({ vvOffsetTop: Number.NaN }))).toBeNull();
    expect(chatViewportBottomPx(baseInput({ vvHeight: Number.POSITIVE_INFINITY }))).toBeNull();
  });
});

describe('applyChatViewportBottom —— DOM 副作用（幂等）', () => {
  function el(): HTMLElement {
    return document.createElement('div');
  }

  it('写入 / 幂等 / 清除', () => {
    const node = el();
    expect(applyChatViewportBottom(node, 500)).toBe(true);
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('500px');
    // 值没变 → 不再写 DOM
    expect(applyChatViewportBottom(node, 500)).toBe(false);
    // 值变了 → 覆盖
    expect(applyChatViewportBottom(node, 620)).toBe(true);
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('620px');
    // null → 移除
    expect(applyChatViewportBottom(node, null)).toBe(true);
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');
    // 已经没有了 → 不再写 DOM
    expect(applyChatViewportBottom(node, null)).toBe(false);
  });
});

// ── hook 集成：桩掉 visualViewport / matchMedia，用事件驱动 ───────────────────

/** jsdom 没有 visualViewport：用 EventTarget 造一个能派发 resize/scroll 的替身。 */
class FakeVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

const roots: Root[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  // 清掉本用例装上的全局桩，免得串到其它用例
  delete (window as unknown as { visualViewport?: unknown }).visualViewport;
});

function setVisualViewport(vv: FakeVisualViewport | undefined): void {
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true, writable: true });
}

function setCoarse(coarse: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function setInnerHeight(h: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: h });
}

/** 挂载一个把 ref 指向真实 div、并调用 hook 的探针，返回那个 div。 */
function mountHook(): HTMLDivElement {
  const ref = createRef<HTMLDivElement>();
  function Probe() {
    useChatViewport(ref);
    return createElement('div', { ref });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(Probe));
  });
  const node = ref.current;
  if (!node) throw new Error('探针 div 未挂载');
  return node;
}

describe('useChatViewport —— 生命周期', () => {
  it('键盘弹起写自定义属性，收起后清除', () => {
    const vv = new FakeVisualViewport();
    setVisualViewport(vv);
    setCoarse(true);
    setInnerHeight(800);
    const node = mountHook();

    // 挂载时未弹键盘 → 不写
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');

    vv.height = 500;
    act(() => vv.dispatchEvent(new Event('resize')));
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('500px');

    vv.height = 800; // 键盘收起
    act(() => vv.dispatchEvent(new Event('resize')));
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');
  });

  it('非触屏即使收缩也不写（桌面拖窗口不该动）', () => {
    const vv = new FakeVisualViewport();
    setVisualViewport(vv);
    setCoarse(false);
    setInnerHeight(800);
    const node = mountHook();

    vv.height = 400;
    act(() => vv.dispatchEvent(new Event('resize')));
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');
  });

  it('没有 visualViewport 的浏览器 → 保持 dvh 兜底（不写、不报错）', () => {
    setVisualViewport(undefined);
    setCoarse(true);
    const node = mountHook();
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');
  });

  it('卸载摘掉监听并清掉自定义属性', () => {
    const vv = new FakeVisualViewport();
    setVisualViewport(vv);
    setCoarse(true);
    setInnerHeight(800);
    const node = mountHook();

    vv.height = 500;
    act(() => vv.dispatchEvent(new Event('resize')));
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('500px');

    act(() => roots.splice(0)[0].unmount());
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');

    // 监听已摘：再派发也不会重新写回
    vv.height = 500;
    act(() => vv.dispatchEvent(new Event('resize')));
    expect(node.style.getPropertyValue(CHAT_VV_BOTTOM_VAR)).toBe('');
  });
});
