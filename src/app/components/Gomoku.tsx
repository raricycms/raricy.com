'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 五子棋入口分发壳：本地对局（pvp / 人机）与联机对战二选一。
//
// 【为什么靠 props 而不是 useSearchParams】useSearchParams 要求调用方包一层
// <Suspense>，否则 next build 直接报「useSearchParams() should be wrapped in a
// suspense boundary」。页面是 async 服务端组件、本来就拿得到 searchParams，
// 当 props 传下来最省事，也没有 hydration 闪烁。
//
// 【同一个页面、两种模式】菜单里五子棋在「单机」与「联机」两区各出现一次，
// 进去是同一个路由，靠 ?mode= 决定默认模式（见 app/game/page.tsx）。
// ─────────────────────────────────────────────────────────────────────────────

import GomokuLocal from './GomokuLocal';
import OnlineGomoku from './OnlineGomoku';

export interface GomokuProps {
  /** 默认模式；联机入口传 'online'。 */
  defaultMode?: 'pvp' | 'online';
  /** 从 URL 带过来的房号 —— 可分享链接的落点。 */
  initialRoom?: string | null;
}

export default function Gomoku({ defaultMode = 'pvp', initialRoom = null }: GomokuProps) {
  if (defaultMode === 'online') return <OnlineGomoku initialRoom={initialRoom} />;
  return <GomokuLocal />;
}
