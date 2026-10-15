import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { FOCUS_MODE_SETTINGS_HREF } from '@/lib/focus-mode';

// 菜单与直接访问的游戏页共用专注闸门；匿名访客可以玩纯客户端游戏。
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (user?.focusMode) {
    return (
      <div className="container game-menu">
        <h1>玩具</h1>
        <section className="game-focus-notice">
          <h2>已开启专注模式</h2>
          <p>玩具暂不可用，可在账号设置中关闭专注模式。</p>
          <Link className="game-action" href={FOCUS_MODE_SETTINGS_HREF}>前往设置</Link>
        </section>
      </div>
    );
  }
  return children;
}
