import Link from 'next/link';
import type { ReactNode } from 'react';
import { FOCUS_MODE_BLOCKED_TITLE } from '@/lib/focus-mode';

/**
 * 练手盘的外部入口（`/fish` 卡片两处 + `/fish/market` 页脚一处，共用这一个组件）。
 *
 * 【专注模式下是「置灰」不是「藏起来」】保留这一行、看着像灰掉的入口、hover 告诉你
 * 为什么 —— 与讨论侧栏那颗被禁用的大区行同一个意思（见 src/app/chat/ChatSidebar.tsx）。
 * 别改成整行不渲染：入口照常渲染、点了才拿 403 是本站的既定口径
 *（「入口不跟着藏」），而「看不见入口」会让开着专注模式的人以为练手盘被下线了。
 *
 * ⚠️ 禁用态**换成 `<span>`，不是给 `<Link>` 挂个 is-disabled**：
 *   · 挂着类名而 href 还在，链接照样导航 —— 灰了却点得动，比不灰更糟，而且
 *     `aria-disabled="true"` 成了对读屏软件的谎话；
 *   · 用 `<span>` 而不是 `<div>`：这三处都住在 `<p>` 里，块级元素会被 HTML 解析器
 *     提前闭合，把行拆成两段（`<p><div>` 是非法嵌套）；
 *   · 元素不再导航、也不进标签序，所以这里**没有** ChatSidebar 那颗 `<button>` 的
 *     `tabIndex={-1}` 与 `onClick` 置空 —— 那两条是补按钮天生可点可聚焦的，<span> 不需要。
 * 将来若给这里加「点一下提示一句」之类的交互，那时才需要把 tabIndex 补回来。
 */
export default function TradeEntry({
  href,
  disabled,
  className,
  children,
}: {
  href: string;
  /** 当前用户开了专注模式 —— 服务端算好传进来（这个组件是服务端组件，别在里面取用户） */
  disabled: boolean;
  /** 沿用调用点的既有类名（.fish-card__info-link / .market-foot__link），别新造 */
  className: string;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span className={`${className} is-disabled`} aria-disabled="true" title={FOCUS_MODE_BLOCKED_TITLE}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
