import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { isFocusGamesBlocked } from '@/lib/focus-mode';
import HomeFooterNote from './components/HomeFooterNote';
import HomeStage from './components/HomeStage';

// 首页 — 首屏是一次镜头推进（见 components/HomeStage.tsx）：
// 滚过一小段或点「开始探索」后，文字退场、山景靠近、四张卡浮到蒙层之上，
// 背景始终铺满视口，卡片视图之后的滚动继续走山景的竖直视差。
// 博客按档位分流：core+ 去站内 /blog，其余去对外公开列表 /explore。
export default async function HomePage() {
  // 为分流取一次登录态。⚠️ 首页因此从同步组件变成 async，并比从前多一次
  // getCurrentUser()（读 cookie + 一次主键查询）。根 layout 已经查过一次，但那个
  // 函数没有 React cache()，两处不共享 —— 一次主键查询，可接受。要收口得给它加
  // cache()，那动的是全站鉴权路径，得单独一批做并单独验。
  const user = await getCurrentUser();
  const blogHref = isCoreUser(user) ? '/blog' : '/explore';
  const gamesBlocked = isFocusGamesBlocked(user);

  return (
    <>
      <HomeStage blogHref={blogHref} gamesBlocked={gamesBlocked} />
      <HomeFooterNote />
    </>
  );
}
