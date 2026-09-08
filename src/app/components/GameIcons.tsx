// 游戏专用 SVG 图标：扑克花色 / 金银铜奖牌 / Atamas 标题环。
// 惯例：颜色继承 currentColor（MedalIcon 例外——奖牌三档固定色），
// 尺寸由全局 svg.rc-icon { width:1em; height:1em } 规则或 size props 控制。
import { Club, Diamond, Heart, Spade, type LucideIcon } from 'lucide-react';

export type SuitGlyph = '♥' | '♦' | '♠' | '♣';

const SUIT_COMPONENTS: Record<SuitGlyph, LucideIcon> = {
  '♥': Heart,
  '♦': Diamond,
  '♠': Spade,
  '♣': Club,
};

/** 扑克花色（实心填色渲染，近似原 ♥♦♠♣ 字形观感；红黑由父级 color 决定） */
export function SuitIcon({ suit, className }: { suit: SuitGlyph; className?: string }) {
  const C = SUIT_COMPONENTS[suit];
  return <C className={className} fill="currentColor" strokeWidth={1.4} aria-hidden="true" />;
}

const MEDAL_COLORS: Record<1 | 2 | 3, { ring: string; core: string }> = {
  1: { ring: '#FFD54A', core: '#B8860B' }, // 金
  2: { ring: '#E8ECF1', core: '#8E9BAA' }, // 银
  3: { ring: '#E8A87C', core: '#A15C33' }, // 铜
};

/** 排行榜金银铜奖牌（吊带 + 圆牌，固定配色不随主题） */
export function MedalIcon({ rank, size = 20 }: { rank: 1 | 2 | 3; size?: number }) {
  const { ring, core } = MEDAL_COLORS[rank];
  return (
    <span role="img" aria-label={`第${rank}名`} style={{ display: 'inline-block', lineHeight: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="rc-icon rc-medal"
        aria-hidden="true"
      >
        {/* 两根吊带（渲染于圆牌之下，仅露出顶部） */}
        <rect x="9" y="1" width="6" height="11.5" rx="1.8" fill={core} transform="rotate(28 12 6.5)" />
        <rect x="9" y="1" width="6" height="11.5" rx="1.8" fill={core} transform="rotate(-28 12 6.5)" />
        {/* 奖牌圆盘 */}
        <circle cx="12" cy="14" r="8" fill={ring} />
        <circle cx="12" cy="14" r="5.6" fill={core} />
      </svg>
    </span>
  );
}

/** ATAMAS 标题装饰环（圆环 + 四向元素点，呼应棋盘圆环） */
export function AtamasRingIcon() {
  return (
    <svg viewBox="0 0 24 24" className="rc-icon" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="12" cy="3.4" r="1.5" fill="currentColor" />
      <circle cx="20.6" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="20.6" r="1.5" fill="currentColor" />
      <circle cx="3.4" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
