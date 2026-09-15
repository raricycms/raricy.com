// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// use-move-selection.test.ts —— 走子类棋**共用**的选子状态机
//
// 【为什么值得单测】这个钩子被三款棋（国际象棋 / 中国象棋 / 国际跳棋）一字不差地
// 共用，它出的错**不会让任何东西转红**：合法落点在函数里算得好好的，坏掉的只是
// 画出来的样子。所以下面两条最容易静默坏掉的行为必须钉住：
//
//   · targets 只在**选中之后**才算落点。没选子时，每条着法的第一格是"我自己那些
//     能动的子" —— 照单全收地画出来，就是在自己的子身上点圆点（绿了之后像棋子
//     长了脑袋）。这条一坏，三款棋的开局盘面会同时变花，而测试全绿。
//   · rejected 是**瞬时**的：棋盘靠类名播放抖动动画，而类名不变动画不会重放 ——
//     不撤掉的话，同一个格子第二次点就跟没点一样。
//
// 【环境】不引 @testing-library/react（本仓库没有这个依赖），与
// use-resolved-content.test.ts 同一套：createRoot + act 直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { MoveInput, Square } from '@/lib/board-shared';
import { useMoveSelection, type MoveSelection } from '@/app/components/useMoveSelection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sq = (r: number, c: number): Square => [r, c];
const move = (...path: Square[]): MoveInput => ({ path });

/** 假装是国际象棋的开局：e2 兵可走 e3/e4，b1 马可走 a3/c3。 */
const OPENING: MoveInput[] = [
  move(sq(6, 4), sq(5, 4)),
  move(sq(6, 4), sq(4, 4)),
  move(sq(7, 1), sq(5, 0)),
  move(sq(7, 1), sq(5, 2)),
];

let out: MoveSelection | null = null;
const played: MoveInput[] = [];

function Probe({ moves, canPlay, resetKey }: { moves: MoveInput[]; canPlay: boolean; resetKey: number }) {
  out = useMoveSelection(
    moves,
    canPlay,
    (m) => {
      played.push(m);
    },
    resetKey
  );
  return null;
}

function mount(props: { moves?: MoveInput[]; canPlay?: boolean; resetKey?: number } = {}) {
  const full = { moves: OPENING, canPlay: true, resetKey: 0, ...props };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe, full));
  });
  return {
    rerender: (next: Partial<typeof full>) =>
      act(() => {
        root.render(createElement(Probe, { ...full, ...next }));
      }),
    unmount: () => act(() => root.unmount()),
  };
}

/** 点一格（钩子的 click 会改 state，必须包在 act 里）。 */
function click(r: number, c: number) {
  act(() => out!.click(sq(r, c)));
}

afterEach(() => {
  out = null;
  played.length = 0;
});

describe('没选子时不给落点', () => {
  it('开局（没选子）targets 为空 —— 否则会在每个能动的子身上点圆点', () => {
    const h = mount();
    expect(out!.path).toEqual([]);
    expect(out!.targets).toEqual([]);
    h.unmount();
  });

  it('选中一个子之后，targets 才是它真能落的那几格', () => {
    const h = mount();
    click(6, 4); // 点 e2 兵
    expect(out!.path).toEqual([sq(6, 4)]);
    expect(out!.targets).toEqual([sq(5, 4), sq(4, 4)]);
    h.unmount();
  });

  it('走完一手、选中被清空后，又回到不给落点', () => {
    const h = mount();
    click(6, 4);
    click(4, 4); // e2e4，正好凑成一条完整着法
    expect(played).toEqual([move(sq(6, 4), sq(4, 4))]);
    expect(out!.path).toEqual([]);
    expect(out!.targets).toEqual([]);
    h.unmount();
  });
});

describe('点不动要留下痕迹（供棋盘做反馈）', () => {
  it('点空格：算"点不动"，但那一格没有子 —— 判定归棋盘，这里只如实报出格子', () => {
    const h = mount();
    click(3, 3); // 空格
    expect(out!.rejected).toEqual(sq(3, 3));
    h.unmount();
  });

  it('点自己的另一个子 = 改选，是成功的操作，不该被当成"点不动"', () => {
    const h = mount();
    click(6, 4); // 先选 e2 兵
    click(7, 1); // 再点 b1 马
    expect(out!.path).toEqual([sq(7, 1)]);
    expect(out!.rejected).toBeNull();
    h.unmount();
  });

  it('几百毫秒后自动清空 —— 不撤掉的话同一个格子再点一次动画不会重放', async () => {
    const h = mount();
    click(3, 3);
    expect(out!.rejected).toEqual(sq(3, 3));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650));
    });
    expect(out!.rejected).toBeNull();
    h.unmount();
  });

  it('局面变了（resetKey）要连同选择一起清空', () => {
    const h = mount();
    click(3, 3);
    h.rerender({ resetKey: 1 });
    expect(out!.rejected).toBeNull();
    expect(out!.path).toEqual([]);
    h.unmount();
  });
});
