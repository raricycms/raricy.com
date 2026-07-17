import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';

// ─────────────────────────────────────────────────────────────────────────────
// 玩具（game）菜单 — 对齐 Flask 原站 app/templates/game/menu.html
//
// 可见行为对齐：
//   • 照片墙卡片按登录/认证态门控（core 用户 → 可进入；否则 → 锁定占位）。
//   • 卡片顺序、文案、类名与原站逐字一致，末尾补"更多玩具筹备中"占位卡。
//   • 与原站一致：游戏卡片不带徽章；全部 9 款游戏均已在 Next.js 原生实现，链到各自 /game/<slug>。
//   • 照片墙已在 Next.js 独立实现，直接链到 /photowall。
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic'; // 照片墙卡片随登录态变化，禁用静态化

type GameCard = {
  href: string;
  medallion: string;
  title: string;
  desc: string;
};

// Flask 原站顺序（照片墙除外，单独门控渲染）
const games: GameCard[] = [
  {
    href: '/game/cube',
    medallion: 'g-cube',
    title: '立方体滚滚',
    desc: '在多面体上涂满蓝色。滚到蓝色格子上交换颜色，用最少的步数把多面体所有面都变成蓝色。',
  },
  {
    href: '/game/galaxies',
    medallion: 'g-galaxies',
    title: '螺旋星系',
    desc: '将网格划分为对称的星系区域，每个区域围绕一个圆点保持180度旋转对称。',
  },
  {
    href: '/game/2048',
    medallion: 'g-2048',
    title: '2048',
    desc: '滑动合并数字方块，挑战 2048！经典益智小游戏，支持触屏和键盘操作。',
  },
  {
    href: '/game/connect4',
    medallion: 'g-connect4',
    title: '四子棋',
    desc: '经典四子连线棋，支持普通、障碍、盲棋等多种模式，键盘操作快捷落子。',
  },
  {
    href: '/game/utictactoe',
    medallion: 'g-utictactoe',
    title: '超级井字棋',
    desc: '大棋盘套小棋盘，你的落子决定对手的战场。策略深度远超普通井字棋。',
  },
  {
    href: '/game/speed',
    medallion: 'g-speed',
    title: '速度接龙',
    desc: '本地双人竞速纸牌，红色对黑色，比谁更快出完手中的牌。支持键盘快捷键。',
  },
  {
    href: '/game/cubetictactoe',
    medallion: 'g-cubetictactoe',
    title: '立方棋',
    desc: '4×4×4 立体空间井字棋，拖拽旋转视角，76 种连线方式，3D 视觉盛宴。',
  },
  {
    href: '/game/gomoku',
    medallion: 'g-gomoku',
    title: '五子棋',
    desc: '15×15 棋盘五子连线，支持双人对战和人机对战，AI 带深度搜索策略。',
  },
  {
    href: '/game/atamas',
    medallion: 'g-atamas',
    title: 'ATÅMAS',
    desc: '在圆环上放置数字和加号，通过巧妙布局触发链式合并，挑战最高分！',
  },
];

const PHOTOWALL_DESC =
  '在软木板上自由张贴照片，拖动、旋转、缩放，和朋友一起装饰一面共同的回忆墙。';

export default async function GameMenuPage() {
  const user = await getCurrentUser();
  const canEnterPhotowall = isCoreUser(user);

  return (
    <>
      <section className="phero wrap">
        <h1 className="phero__title">玩具</h1>
        <p className="lede phero__lede">一些聪明山小游戏。</p>
      </section>

      <section className="section--tight wrap">
        <div className="game-grid">
          {canEnterPhotowall ? (
            <Link className="card card--link gcard" href="/photowall">
              <span className="gcard__medallion g-photowall"></span>
              <h3 className="gcard__title">照片墙</h3>
              <p className="gcard__desc">{PHOTOWALL_DESC}</p>
              <span className="gcard__go">进入照片墙</span>
            </Link>
          ) : (
            <div className="card gcard gcard--locked">
              <span className="gcard__medallion g-photowall"></span>
              <h3 className="gcard__title">照片墙</h3>
              <p className="gcard__desc">{PHOTOWALL_DESC}</p>
              <span className="gcard__hint">请先登录并通过认证</span>
            </div>
          )}

          {games.map((g) => (
            <Link key={g.href} href={g.href} className="card card--link gcard">
              <span className={`gcard__medallion ${g.medallion}`}></span>
              <h3 className="gcard__title">{g.title}</h3>
              <p className="gcard__desc">{g.desc}</p>
              <span className="gcard__go">开始游戏</span>
            </Link>
          ))}

          <div className="card gcard gcard--soon">
            <span className="gcard__medallion g-coming"></span>
            <h3 className="gcard__title">更多玩具筹备中</h3>
            <p className="gcard__desc">有想法的朋友欢迎向站长提议，好玩的一起做。</p>
            <span className="gcard__badge">即将到来</span>
          </div>
        </div>
      </section>
    </>
  );
}
