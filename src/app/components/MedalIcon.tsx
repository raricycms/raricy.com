// 排行榜金银铜奖牌（吊带 + 圆牌，固定配色不随主题）。
//
// 原先住在 GameIcons.tsx，与游戏专用的 SuitIcon / AtamasRingIcon 同处一个文件。
// 玩具区移除后那两个图标一并删除，只剩这一枚 —— 它服务的是签到卡（CheckinCard），
// 与游戏无关，所以文件也改名以免误导。
const MEDAL_COLORS: Record<1 | 2 | 3, { ring: string; core: string }> = {
  1: { ring: '#FFD54A', core: '#B8860B' }, // 金
  2: { ring: '#E8ECF1', core: '#8E9BAA' }, // 银
  3: { ring: '#E8A87C', core: '#A15C33' }, // 铜
};

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
