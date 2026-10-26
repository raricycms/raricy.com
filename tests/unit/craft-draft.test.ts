// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// craft-draft.test.ts —— 手工间三款游戏共用的草稿钩子
//
// 【为什么值得单测】落盘有 220ms 防抖，而"最后一笔"恰恰是最容易丢的那一笔：
// 玩家拉完滑杆、剪完一刀、把纸揭起来，紧接着刷新或关标签 —— 组件在防抖到期前
// 就卸载了。若卸载时只是 `clearTimeout`，那一笔**永远不会落盘**，刷新回来看到的是
// 上一版草稿。症状是"刚才那步没生效"，看着像状态没提交，与存储无关。
//
// e2e 里这条正是偶发失败的来源（剪纸"放到窗前"之后刷新回到案上）：前面用例
// 跑得慢一点就碰上了。这里把它钉成确定性的用例。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCraftDraft } from '@/games/craft/use-draft';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Draft { readonly n: number }

/** 每个用例一个新的 storage 键，互不干扰。 */
let seq = 0;
function freshKey(): string {
  seq += 1;
  return `craft-test-${seq}`;
}

const out: { draft: Draft; setDraft: (next: Draft | ((current: Draft) => Draft)) => void; ready: boolean } = {
  draft: { n: 0 }, setDraft: () => undefined, ready: false,
};

function Probe({ storageKey }: { storageKey: string }): ReactElement | null {
  const { draft, setDraft, ready } = useCraftDraft<Draft>(
    storageKey,
    () => ({ n: 0 }),
    (raw) => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<Draft>;
        return typeof parsed.n === 'number' ? { n: parsed.n } : null;
      } catch {
        return null;
      }
    },
  );
  out.draft = draft;
  out.setDraft = setDraft;
  out.ready = ready;
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

/** 挂载并等读盘那一帧过去。 */
async function mount(storageKey: string) {
  await act(async () => { root.render(createElement(Probe, { storageKey })); });
  expect(out.ready).toBe(true);
}

describe('手工间草稿：最后一笔不能留在防抖里', () => {
  it('改动之后 220ms，草稿落到 localStorage', async () => {
    const key = freshKey();
    await mount(key);
    await act(async () => { out.setDraft({ n: 7 }); });
    // 防抖还没到期：此时盘上应该还是空的。
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(220); });
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ n: 7 });
  });

  it('改动之后立刻卸载（刷新 / 关标签），这一笔仍然写进 localStorage', async () => {
    const key = freshKey();
    await mount(key);
    await act(async () => { out.setDraft({ n: 42 }); });
    // 不走任何定时器，直接卸载 —— 模拟 220ms 内刷新页面。
    act(() => { root.unmount(); });
    // 重新给一个 root，让 afterEach 的 unmount 不出错。
    root = createRoot(container);
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ n: 42 });
  });

  it('卸载时写的是**最新**那一笔，不是挂载时的那份闭包', async () => {
    const key = freshKey();
    await mount(key);
    await act(async () => { out.setDraft({ n: 1 }); });
    await act(async () => { out.setDraft({ n: 2 }); });
    await act(async () => { out.setDraft({ n: 3 }); });
    act(() => { root.unmount(); });
    root = createRoot(container);
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ n: 3 });
  });

  it('pagehide 也立刻落盘 —— 移动端关标签走的是这条', async () => {
    const key = freshKey();
    await mount(key);
    await act(async () => { out.setDraft({ n: 9 }); });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ n: 9 });
  });

  it('页面转后台（visibilitychange → hidden）同样落盘', async () => {
    const key = freshKey();
    await mount(key);
    await act(async () => { out.setDraft({ n: 12 }); });
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ n: 12 });
    spy.mockRestore();
  });

  it('读盘之前不写盘 —— 别用空草稿盖掉真存档', async () => {
    const key = freshKey();
    localStorage.setItem(key, JSON.stringify({ n: 5 }));
    // 挂载的那一帧里 ready 还是 false，此时不该已经写过盘。
    await act(async () => { root.render(createElement(Probe, { storageKey: key })); });
    // 读回来了原始值，而不是被空草稿覆盖。
    expect(out.draft).toEqual({ n: 5 });
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ n: 5 });
  });
});
