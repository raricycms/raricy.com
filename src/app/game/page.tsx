import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';

// 玩具（game）菜单 — 对齐 Flask `app/templates/game/menu.html`。
// 9 款游戏 + 照片墙 + 即将到来占位。

export const dynamic = 'force-dynamic';

type GameCard = {
  href: string;
  icon: string;
  title: string;
  desc: string;
};

const games: GameCard[] = [
  {
    href: '/game/cube',
    icon: 'game-card__icon--cube',
    title: '立方体滚滚',
    desc: '在多面体上涂满蓝色。滚到蓝色格子上交换颜色，用最少的步数把所有面都变成蓝色。',
  },
  {
    href: '/game/galaxies',
    icon: 'game-card__icon--galaxies',
    title: '螺旋星系',
    desc: '将网格划分为对称的星系区域，每个区域围绕一个圆点保持180度旋转对称。',
  },
  {
    href: '/game/2048',
    icon: 'game-card__icon--2048',
    title: '2048',
    desc: '滑动合并数字方块，挑战 2048！经典益智小游戏，支持触屏和键盘操作。',
  },
  {
    href: '/game/connect4',
    icon: 'game-card__icon--connect4',
    title: '四子棋',
    desc: '经典四子连线棋，支持普通、障碍、盲棋等多种模式，键盘操作快捷落子。',
  },
  {
    href: '/game/utictactoe',
    icon: 'game-card__icon--utictactoe',
    title: '超级井字棋',
    desc: '大棋盘套小棋盘，你的落子决定对手的战场。策略深度远超普通井字棋。',
  },
  {
    href: '/game/speed',
    icon: 'game-card__icon--speed',
    title: '速度接龙',
    desc: '本地双人竞速纸牌，红色对黑色，比谁更快出完手中的牌。支持键盘快捷键。',
  },
  {
    href: '/game/cubetictactoe',
    icon: 'game-card__icon--cubetictactoe',
    title: '立方棋',
    desc: '4×4×4 立体空间井字棋，拖拽旋转视角，76 种连线方式，3D 视觉盛宴。',
  },
  {
    href: '/game/gomoku',
    icon: 'game-card__icon--gomoku',
    title: '五子棋',
    desc: '15×15 棋盘五子连线，支持双人对战和人机对战，AI 带深度搜索策略。',
  },
  {
    href: '/game/atamas',
    icon: 'game-card__icon--atamas',
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
    <div className="container">
      <section className="game-hero">
        <h1 className="game-hero__title">玩具</h1>
        <p className="game-hero__description">一些聪明山小游戏。</p>
      </section>

      <section className="game-section">
        <div className="game-grid">
          {canEnterPhotowall ? (
            <Link href="/photowall" className="game-card">
              <div className="game-card__body">
                <span className="game-card__icon game-card__icon--photowall" aria-hidden="true" />
                <h3 className="game-card__title">照片墙</h3>
                <p className="game-card__desc">{PHOTOWALL_DESC}</p>
                <span className="game-card__btn">进入照片墙</span>
              </div>
            </Link>
          ) : (
            <div className="game-card game-card--locked" aria-disabled="true">
              <div className="game-card__body">
                <span className="game-card__icon game-card__icon--photowall" aria-hidden="true" />
                <h3 className="game-card__title">照片墙</h3>
                <p className="game-card__desc">{PHOTOWALL_DESC}</p>
                <span className="game-card__hint">请先登录并通过认证</span>
              </div>
            </div>
          )}

          {games.map((g) => (
            <Link key={g.href} href={g.href} className="game-card">
              <div className="game-card__body">
                <span className={`game-card__icon ${g.icon}`} aria-hidden="true" />
                <h3 className="game-card__title">{g.title}</h3>
                <p className="game-card__desc">{g.desc}</p>
                <span className="game-card__btn">开始游戏</span>
              </div>
            </Link>
          ))}

          <div className="game-card game-card--soon">
            <div className="game-card__body">
              <span className="game-card__icon game-card__icon--coming" aria-hidden="true" />
              <h3 className="game-card__title">更多玩具筹备中</h3>
              <p className="game-card__desc">
                有想法的朋友欢迎向站长提议，好玩的一起做。
              </p>
              <span className="game-card__badge">即将到来</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}