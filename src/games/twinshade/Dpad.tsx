// ─────────────────────────────────────────────────────────────────────────────
// Dpad.tsx — 方向键。桌面端也保留（不藏）：鼠标玩家和触屏玩家是同一批人，
// 而「藏起来」意味着桌面端只能用键盘，触屏端才需要它 —— 反过来更常见的场景是
// 一只手拿平板点、一只手在键盘上按。所以它常驻，只是窄屏更容易点。
//
// 组件本身不判方向能不能走：点了就交给 onMove，成不成立由容器的引擎决定。
// `disabled` 只在浮层打开 / 通关后这类「整组不该响应」的时刻由容器给。
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import type { DpadProps } from './ui-types';

export default function Dpad({ onMove, disabled }: DpadProps) {
  return (
    <div className="tw-dpad" role="group" aria-label="方向键">
      <button
        type="button"
        className="tw-dpad__btn tw-dpad__up"
        onClick={() => onMove('up')}
        disabled={disabled}
        aria-label="向上"
      >
        <ChevronUp size={22} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tw-dpad__btn tw-dpad__left"
        onClick={() => onMove('left')}
        disabled={disabled}
        aria-label="向左"
      >
        <ChevronLeft size={22} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tw-dpad__btn tw-dpad__right"
        onClick={() => onMove('right')}
        disabled={disabled}
        aria-label="向右"
      >
        <ChevronRight size={22} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tw-dpad__btn tw-dpad__down"
        onClick={() => onMove('down')}
        disabled={disabled}
        aria-label="向下"
      >
        <ChevronDown size={22} aria-hidden="true" />
      </button>
    </div>
  );
}
