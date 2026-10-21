// ─────────────────────────────────────────────────────────────────────────────
// Onboarding.tsx — 首屏引导（只在「从没看过」时由容器打开）
//
// 三条规则各配一张**手画的极简示意图**（两个圆 + 箭头），不引任何素材：
// 这个游戏的全部信息就是「两个身体 + 一个方向」，一张 64×32 的小图能讲清的事，
// 不值得一个 GIF，也不值得一段文字堆叠。
// SVG 的坐标是刻意手调的固定 viewBox，跟着字号缩放，不做响应式计算。
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import type { OnboardingProps } from './ui-types';

/** 共同的画布尺寸。三张图同宽同高，列表左侧才对得齐。 */
const VIEW = '0 0 64 32';

/** 地面基线：三张图都有，让「这两个圆站在同一片地上」这件事一致。 */
function FloorLine() {
  return (
    <path
      d="M4 27h56"
      fill="none"
      stroke="currentColor"
      strokeOpacity=".22"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  );
}

/** 规则一：同时移动 —— 两个身体同向各走一格。 */
function MoveIcon() {
  return (
    <svg viewBox={VIEW} aria-hidden="true" focusable="false">
      <FloorLine />
      <circle cx="18" cy="19" r="6" style={{ fill: 'var(--tw-body)' }} />
      <circle cx="46" cy="19" r="6" style={{ fill: 'var(--tw-shade)' }} />
      {/* 两个同向箭头：这是「一次操作，两个身体」的画面本身 */}
      <path
        d="M26 12h8m0 0-3-2.6m3 2.6-3 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M54 12h8m0 0-3-2.6m3 2.6-3 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 规则二：推石头 —— 走进去，石块往前挪一格。 */
function PushIcon() {
  return (
    <svg viewBox={VIEW} aria-hidden="true" focusable="false">
      <FloorLine />
      <circle cx="14" cy="19" r="6" style={{ fill: 'var(--tw-body)' }} />
      <rect
        x="34"
        y="13"
        width="12"
        height="12"
        rx="3"
        style={{ fill: 'var(--tw-wall-1)' }}
        stroke="currentColor"
        strokeOpacity=".45"
        strokeWidth="1"
      />
      {/* 箭头压在两者之间：推的方向 */}
      <path
        d="M23 19h7m0 0-2.6-2.6M30 19l-2.6 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 规则三：目标 —— 两个身体各自踩上一盏灯。 */
function GoalIcon() {
  return (
    <svg viewBox={VIEW} aria-hidden="true" focusable="false">
      <FloorLine />
      <circle cx="18" cy="19" r="8.5" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.5" />
      <circle cx="46" cy="19" r="8.5" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.5" />
      <circle cx="18" cy="19" r="5" style={{ fill: 'var(--tw-body)' }} />
      <circle cx="46" cy="19" r="5" style={{ fill: 'var(--tw-shade)' }} />
      {/* 两盏灯各自被踩亮：灯环外的一圈光 */}
      <circle cx="18" cy="19" r="11" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="1" />
      <circle cx="46" cy="19" r="11" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="1" />
    </svg>
  );
}

export default function Onboarding({ open, onStart, onDismiss }: OnboardingProps) {
  if (!open) return null;

  return (
    <div className="tw-onboard" role="dialog" aria-modal="true" aria-label="玩法说明">
      <div className="tw-onboard__panel">
        <h2>一次操作，两个身体</h2>
        <p>方向键同时驱动本体与影子；两侧都走得通，这一步才成立。</p>

        <ul className="tw-onboard__rules">
          <li className="tw-rule">
            <span className="tw-rule__icon">
              <MoveIcon />
            </span>
            <span>
              <strong>同时移动</strong>
              <span>一次操作让两个身体各走一格；任意一侧被挡住，整步作废。</span>
            </span>
          </li>
          <li className="tw-rule">
            <span className="tw-rule__icon">
              <PushIcon />
            </span>
            <span>
              <strong>推石头</strong>
              <span>走进石块就把它推一格；石块后面不是空地时推不动。</span>
            </span>
          </li>
          <li className="tw-rule">
            <span className="tw-rule__icon">
              <GoalIcon />
            </span>
            <span>
              <strong>目标</strong>
              <span>两个身体各自踩上一盏灯。</span>
            </span>
          </li>
        </ul>

        <footer>
          <button type="button" className="tw-btn tw-btn--soft" onClick={onDismiss}>
            跳过
          </button>
          <button type="button" className="tw-btn tw-btn--primary" onClick={onStart}>
            开始
          </button>
        </footer>
      </div>
    </div>
  );
}
