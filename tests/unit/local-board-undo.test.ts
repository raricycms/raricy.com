// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// local-board-undo.test.ts —— 走子类棋**单机**的悔棋：从终局退回之后轮到谁。
//
// 【为什么值得单测】单机悔棋要同时恢复两样东西：**棋盘**（各棋自己的 undo：格子、
// 易位权利、吃过路兵、重复局面计数…）与压在 LocalBoardGame 里那份**终局判定栈**。
// 少同步一处，症状就是「同一方连下两步」或者状态行还写着上一步的胜负 —— 而两者
// 都只在走到终局（将死）之后才现形，平时怎么走都看不出。
//
// 【为什么挑将死】终局那一手是不翻面的（走完就没人接着走了），回合在那一刻最容易
// 被算错；国际象棋四手杀正好四步走到将死。规则的逐字段回退另有
// tests/unit/chess-rules.test.ts「悔棋」一节盯着（快照里带 turn），这里盯的是
// 组件把两份状态接起来的那一段。
//
// 棋盘格子是 DOM（data-row / data-col / data-piece），点得动也读得出 ——
// 不必像五子棋那样隔着 canvas 猜。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Chess from '@/app/components/Chess';

// React 要求显式声明「这是测试环境」，否则 act 会警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Chess));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 行 0 是 8 线（黑方底线），与 chess-rules 的 parseSquareName 同一口径。 */
function square(r: number, c: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-row="${r}"][data-col="${c}"]`);
  if (!el) throw new Error(`找不到格子 ${r},${c}`);
  return el;
}

/** 那一格上的棋子；空格是空串。大写 = 白（先手方）。 */
function pieceAt(r: number, c: number): string {
  return square(r, c).dataset.piece ?? '';
}

function click(r: number, c: number) {
  act(() => square(r, c).click());
}

/** 走一手（先点起点选中，再点终点）。 */
function play(r1: number, c1: number, r2: number, c2: number) {
  click(r1, c1);
  click(r2, c2);
}

function status(): string {
  const el = container.querySelector('.board-status');
  if (!el) throw new Error('状态行还没渲染出来');
  return el.textContent ?? '';
}

function undoButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === '悔棋');
  if (!found) throw new Error('找不到「悔棋」按钮');
  return found as HTMLButtonElement;
}

function tapUndo() {
  act(() => undoButton().click());
}

describe('走子类单机：悔棋', () => {
  it('将死之后悔棋：被撤那一手回到原位，回合也还给刚走的那一方', () => {
    mount();
    // 1. f3 e5 2. g4 Qh4#（黑后从 d8 杀到 h4）
    play(6, 5, 5, 5);
    play(1, 4, 3, 4);
    play(6, 6, 4, 6);
    expect(pieceAt(4, 7)).toBe('');
    play(0, 3, 4, 7);
    expect(status()).toBe('黑方获胜！（将死）');
    expect(pieceAt(4, 7)).toBe('q');

    tapUndo();
    // 撤掉的是黑那一手 → 又轮到黑。若回合被翻面，这里会是「白方走棋」，
    // 而白方刚被将死、棋盘却重新能走 —— 正是「同一方连下两步」的那类错。
    expect(status()).toBe('黑方走棋');
    expect(pieceAt(4, 7)).toBe(''); // 后回到 d8
    expect(pieceAt(0, 3)).toBe('q');
    expect(pieceAt(5, 5)).toBe('P'); // 前面几步原封不动（只撤了一手）
    expect(pieceAt(4, 6)).toBe('P');

    // 还能把这一手重新走出来 —— 终局判定也跟着退回去了
    play(0, 3, 4, 7);
    expect(status()).toBe('黑方获胜！（将死）');
  });

  it('连撤到开局：棋盘回到初始局面，悔棋按钮随之变灰', () => {
    mount();
    play(6, 5, 5, 5); // f3
    play(1, 4, 3, 4); // e5
    expect(undoButton().disabled).toBe(false);

    tapUndo();
    tapUndo();
    expect(status()).toBe('白方走棋');
    expect(pieceAt(6, 5)).toBe('P'); // 兵回到 f2
    expect(pieceAt(1, 4)).toBe('p'); // 黑兵回到 e7
    expect(undoButton().disabled).toBe(true); // 栈底那条是"开局"，没得撤了
  });
});
