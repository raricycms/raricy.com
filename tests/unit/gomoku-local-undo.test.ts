// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// gomoku-local-undo.test.ts —— 五子棋**单机**的悔棋：撤完轮到谁、撤了几步。
//
// 【为什么值得单测】悔棋要回答的是「撤完轮到谁」，而这件事**只在终局那一手**上
// 与「走一手翻一次面」分岔：终结比赛的那一手之后没人接着走，回合就停在落子方。
// 靠 switchTurn() 翻回来的实现在「刚有人获胜」时会把回合翻给对手 —— 表现是
// **同一方连下两步**。这条只有真玩到分出胜负才看得见，而那时测试往往已经走完了。
//
// 【怎么观察盘面】DOM 里能读的只有状态行与按钮，棋盘画在 canvas 上。所以要断言
// 「某一格还在不在」就走一步：那一格空着这一手就落得下（AI 随即应招），占着就
// 点不动。`ai.calls` 是 AI 被叫了几次的账 —— 由下面那个**剧本化**的假引擎记。
//
// 【为什么把 AI 换成剧本】真引擎的应招不可预知，没法摆出"AI 获胜"这类局面；
// 剧本还能让"撤了几步"变成可数的（多撤的那一步恰好是 AI 的某一手）。真引擎 /
// worker 那条链路另有 e2e 盯着（tests/e2e/gomoku-solo.spec.ts）。
//
// 【环境】jsdom + createRoot/act（本仓库没有 @testing-library/react，与
// use-move-selection.test.ts 同一套）。画布在 jsdom 里没有 2D 上下文，桩掉即可；
// 点击仍走真实的像素→格换算，见 `star()`。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BOARD_SIZE, EMPTY } from '@/lib/gomoku-rules';
import GomokuLocal from '@/app/components/GomokuLocal';

// React 要求显式声明「这是测试环境」，否则 act 会警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 假引擎：按 `script` 里的格子依次应招，每次都记一笔。
 * 用 vi.hoisted 是因为 vi.mock 的工厂会被提升到 import 之前，普通顶层变量那时还没初始化。
 */
const ai = vi.hoisted(() => ({
  script: [] as Array<[number, number]>,
  calls: [] as Array<[number, number]>,
}));

vi.mock('@/lib/gomoku-ai', () => ({
  findBestMove: (board: { size: number; grid: number[][] }) => {
    const next = ai.script.shift();
    if (next) {
      ai.calls.push(next);
      return { row: next[0], col: next[1] };
    }
    // 剧本用完了就随便找个空格 —— 免得用例因为"引擎交回一个占着的格子"而莫名其妙地崩
    for (let r = 0; r < board.size; r++) {
      for (let c = 0; c < board.size; c++) {
        if (board.grid[r][c] === EMPTY) {
          ai.calls.push([r, c]);
          return { row: r, col: c };
        }
      }
    }
    return { row: 0, col: 0 };
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // jsdom 没装 canvas 包：getContext('2d') 会返回 null 并往控制台扔一条
  // "Not implemented"。本用例不看像素，直接桩成 null —— GomokuCanvas 对它有守卫。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

  // jsdom 的 getBoundingClientRect 恒为全 0，点上去会除以 0。给一个与**逻辑尺寸**
  // 等大的方框：于是缩放系数为 1，clientX/Y 就是逻辑坐标。尺寸从 canvas 的
  // data-cell-size / data-margin 现取（resize 时写进去的），不在这里抄一遍公式。
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    const cell = Number(this.dataset.cellSize);
    const margin = Number(this.dataset.margin);
    const size = margin * 2 + cell * (BOARD_SIZE - 1);
    return {
      left: 0,
      top: 0,
      width: size,
      height: size,
      right: size,
      bottom: size,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

beforeEach(() => {
  ai.script.length = 0;
  ai.calls.length = 0;
});

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(GomokuLocal));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function status(): string {
  const el = container.querySelector('.board-status');
  if (!el) throw new Error('状态行还没渲染出来');
  return el.textContent ?? '';
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`找不到按钮「${label}」`);
  return found as HTMLButtonElement;
}

function tap(label: string) {
  act(() => button(label).click());
}

/** 勾一个单选（radio 的 click 会触发 React 的 onChange）。 */
function select(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (!input) throw new Error(`找不到选项 ${name}=${value}`);
  act(() => input.click());
}

/** 给假引擎排接下来这几手棋。 */
function script(...cells: Array<[number, number]>) {
  ai.script.push(...cells);
}

/** 点棋盘交叉点。换算与 GomokuCanvas.onCanvasClick 一致：格心 ± 半格以内才算点到。 */
function star(row: number, col: number) {
  const canvas = container.querySelector<HTMLCanvasElement>('.gomoku-canvas');
  if (!canvas) throw new Error('棋盘还没渲染出来');
  const cell = Number(canvas.dataset.cellSize);
  const margin = Number(canvas.dataset.margin);
  act(() => {
    canvas.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        clientX: margin + col * cell,
        clientY: margin + row * cell,
      })
    );
  });
}

/** 双方各走四手、黑在 7 行连成五子。第四手后白方在 0 行只有四子，不成五。 */
function blackWins() {
  for (let i = 0; i < 4; i++) {
    star(7, 7 + i);
    star(0, i);
  }
  star(7, 11);
}

describe('双人对战：悔棋之后轮到谁', () => {
  it('撤掉黑那一手，又轮到黑 —— 而不是让白连下两步', () => {
    mount();
    blackWins();
    expect(status()).toBe('黑方获胜！');

    tap('悔棋');
    // 撤掉的是黑刚落的制胜那一手 → 又轮到黑。按「翻面」算会翻给白：
    // 白刚走完 (0,3)，再走一次就是同一方连下两步。
    expect(status()).toBe('黑方落子');

    // 回合真的给了黑：这一手落下去仍然算黑胜（判给了白的话这一点是空的，落不下）
    star(7, 11);
    expect(status()).toBe('黑方获胜！');
    expect(ai.calls).toEqual([]); // 双人对战不该惊动引擎
  });

  it('对局中途撤一手，黑白照常交替', () => {
    mount();
    star(7, 7);
    expect(status()).toBe('白方落子');
    star(0, 0);
    expect(status()).toBe('黑方落子');
    star(7, 8);
    expect(status()).toBe('白方落子');

    tap('悔棋'); // 撤掉黑 (7,8)
    expect(status()).toBe('黑方落子');
    star(7, 8);
    expect(status()).toBe('白方落子');
  });
});

describe('人机对战：撤到「又轮到人类走」', () => {
  /** 人机、我执黑：人类走 7 行的五连，AI 的应招一路摆在 0 行。 */
  function humanBlackWins() {
    script([0, 0], [0, 1], [0, 2], [0, 3]);
    select('gomoku-mode', 'ai');
    expect(status()).toBe('黑方落子');
    for (let i = 0; i < 4; i++) {
      star(7, 7 + i);
      expect(status()).toBe('黑方落子'); // AI 应招完又轮到人类
    }
    star(7, 11);
    expect(status()).toBe('黑方获胜！');
  }

  it('人类那一手终结的比赛：只撤 1 步（它后面没有 AI 的应招）', () => {
    mount();
    humanBlackWins();
    expect(ai.calls).toHaveLength(4);

    tap('悔棋');
    expect(status()).toBe('黑方落子');

    // AI 的最后一步（0,3）还在盘上 —— 那一格点不动，引擎不会再被叫。
    // 若按"固定撤两步"撤，这一格会被腾空，人类就能落下去（引擎随即应招）。
    star(0, 3);
    expect(ai.calls).toHaveLength(4);
    expect(status()).toBe('黑方落子');

    // 而人类自己那一格腾出来了：再落一次就是重新走那一手（制胜手，AI 不再应招）
    star(7, 11);
    expect(status()).toBe('黑方获胜！');
    expect(ai.calls).toHaveLength(4);
  });

  it('AI 那一手终结的比赛：连人类上一步一起撤 —— 人类重走，不是白得一手', () => {
    mount();
    // AI 执黑先手：开局 (0,0)，之后一路在 0 行摆到成五；人类在 7 行应四手（不成五）
    script([0, 0], [0, 1], [0, 2], [0, 3], [0, 4]);
    select('gomoku-mode', 'ai');
    select('gomoku-first', 'white');
    expect(status()).toBe('白方落子'); // AI 已开局
    // 人类在 7 行摆到第四子（不成五）；AI 的第五子应招回来正好连成五 → AI 获胜
    for (let i = 0; i < 3; i++) {
      star(7, 7 + i);
      expect(status()).toBe('白方落子');
    }
    star(7, 10);
    expect(status()).toBe('黑方获胜！');
    expect(ai.calls).toHaveLength(5);

    tap('悔棋');
    expect(status()).toBe('白方落子');

    // 人类那一手（7,10）被撤掉了 —— 那一格又能落：落下去 AI 会应招。
    // 只撤 AI 那一手的话（按「翻面」算正是如此），7,10 还占着，人类连下两步。
    star(7, 10);
    expect(ai.calls).toHaveLength(6);

    // 而 AI 的开局手不在可撤范围内，撤到底就停在它上面
    expect(button('悔棋').disabled).toBe(false);
  });

  it('我执白：悔棋停在 AI 的开局手之后，又轮到人类', () => {
    mount();
    script([0, 0], [0, 1]);
    select('gomoku-mode', 'ai');
    select('gomoku-first', 'white');
    expect(status()).toBe('白方落子'); // AI 执黑，自己开了局

    star(7, 7); // 人类应一手
    expect(status()).toBe('白方落子'); // AI 应招完，又轮到人类

    tap('悔棋'); // 撤掉人类那一手（连同 AI 的应招）
    expect(status()).toBe('白方落子');

    // 停在 AI 的开局那一手上：再撤就该撤走它了，所以按钮此刻是灰的。
    // （曾经这里会把回合算成黑方 —— 而 AI 不会自己再动，棋盘就冻住了。）
    expect(button('悔棋').disabled).toBe(true);
    star(0, 0); // AI 的开局那一格还占着 → 点不动
    expect(ai.calls).toHaveLength(2);
  });

  it('我执黑：悔棋撤两步（自己那一手 + AI 的应招），回到空盘', () => {
    mount();
    script([0, 0], [0, 5]);
    select('gomoku-mode', 'ai');
    expect(status()).toBe('黑方落子');

    star(7, 7);
    expect(status()).toBe('黑方落子'); // AI 应招完，又轮到人类
    expect(ai.calls).toHaveLength(1); // (0,0)

    tap('悔棋');
    expect(status()).toBe('黑方落子');
    // 撤到空盘：人类那一格与 AI 那一格**都**腾出来了（只撤一步的话前者还占着）
    star(7, 7);
    expect(ai.calls).toHaveLength(2); // 落得下 → AI 应招 (0,5)
    star(0, 0);
    expect(ai.calls).toHaveLength(3); // AI 那一步也撤掉了，这一格同样落得下
  });
});
