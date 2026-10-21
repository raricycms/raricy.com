// ─────────────────────────────────────────────────────────────────────────────
// icons.tsx — 双影的站点级图标（GameCard / HUD / 关卡选择共用）
//
// 形象：两个圆 + 中间一条虚线 —— 「两个身体、同步的一次移动」，也是这个游戏唯一的
// 一句话说明。只画描边不画填充、颜色一律 currentColor：GameCard 的容器按 1em 缩放、
// HUD 里可能是 24px，同一个文件不该替调用方决定尺寸与颜色（深浅主题都靠文字色跟随）。
//
// 不依赖外部样式：width/height 自带 24，即使调用方忘了给 CSS，图标也不会退化成
// 浏览器对无尺寸 SVG 的默认 300×150。
// ─────────────────────────────────────────────────────────────────────────────

export interface TwinShadeIconProps {
  /** 透传给 <svg> 的类名（尺寸、外边距由调用方决定）。 */
  className?: string;
}

/**
 * 24×24 单色描边图标：左圆（本体）+ 右圆（影子）+ 中间虚线。
 * 圆环的右/左边缘正好落在 9.8 / 14.2，中间 4.2 单位的虚线用 "1.4 1.4" 切成三段，
 * 视觉上既不连成实线，也不会碎成看不清的短划。
 */
export function TwinShadeIcon({ className }: TwinShadeIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6.2" cy="12" r="3.6" />
      <circle cx="17.8" cy="12" r="3.6" />
      <line x1="9.9" y1="12" x2="14.1" y2="12" strokeDasharray="1.4 1.4" />
    </svg>
  );
}
