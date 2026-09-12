import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';

// 玩具（game）菜单 — 对齐 Flask `app/templates/game/menu.html`，在其上分了
// 「单机 / 联机」两个分区（Flask 时代全是单机，联机是后加的）。
//
// 【为什么是分区数组而不是给每张卡加 section 字段】渲染顺序即数据顺序，不必再维护
// 一个必须与数组顺序保持同步的字符串枚举。对齐 /tool 的 blocks（ToolMenu.tsx）。

export const dynamic = 'force-dynamic';

type GameCard = {
  href: string;
  icon: string;
  title: string;
  desc: string;
  /** 按钮文案；缺省「开始游戏」。 */
  cta?: string;
};

type GameSection = {
  key: 'solo' | 'online';
  title: string;
  desc: string;
  cards: GameCard[];
  /** 分区末尾的占位卡（非链接，故不属于 GameCard）。 */
  soon: { title: string; desc: string };
};

/** 同一个游戏出现在多个分区时的共享呈现量 —— 只定义一次，图标/标题不会漂。
 *  （desc 两边**故意不同**：单机讲规则、联机讲玩法。那是文案不是 drift。） */
const GOMOKU_BASE = {
  icon: 'game-card__icon--gomoku',
  title: '五子棋',
} as const;

const SECTIONS: GameSection[] = [
  {
    key: 'solo',
    title: '单机',
    desc: '一个人玩，或者两个人挤在同一块屏幕前。',
    cards: [
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
        ...GOMOKU_BASE,
        href: '/game/gomoku',
        desc: '15×15 棋盘五子连线，支持双人对战和人机对战，AI 带深度搜索策略。',
      },
      {
        href: '/game/atamas',
        icon: 'game-card__icon--atamas',
        title: 'ATÅMAS',
        desc: '在圆环上放置数字和加号，通过巧妙布局触发链式合并，挑战最高分！',
      },
    ],
    soon: {
      title: '更多玩具筹备中',
      desc: '有想法的朋友欢迎向站长提议，好玩的一起做。',
    },
  },
  {
    key: 'online',
    title: '联机',
    desc: '和远方的朋友隔空对弈。',
    cards: [
      {
        ...GOMOKU_BASE,
        href: '/game/gomoku?mode=online',
        desc: '开一间房，把房号发给朋友，隔空对弈。支持观战。',
        cta: '创建 / 加入房间',
      },
      {
        href: '/game/tictactoe',
        icon: 'game-card__icon--tictactoe',
        title: '井字棋',
        desc: '三子连线就赢，一局不到一分钟。开一间房，隔空和真人下一盘。',
        cta: '创建 / 加入房间',
      },
    ],
    soon: {
      title: '更多联机游戏筹备中',
      desc: '五子棋与井字棋之外，其它棋类陆续跟上。',
    },
  },
];

export default async function GameMenuPage() {
  const user = await getCurrentUser();

  // 专注模式：整页锁屏（入口禁用只是第一道，菜单页直接不给进）；
  // 已开的游戏子页 /game/* 不受影响（可直达，返回链会落回本页）。
  //
  // 【别在这里放任何 <Link className="game-card">】tests/e2e/focus-mode.spec.ts
  // 断言锁屏时 a.game-card 计数为 0 —— 整段替换网格才是它成立的原因。
  if (user?.focusMode) {
    return (
      <div className="container">
        <section className="game-hero">
          <h1 className="game-hero__title">玩具</h1>
          <p className="game-hero__description">一些聪明山小游戏。</p>
        </section>
        <section className="game-section">
          <div className="game-card game-card--locked game-card--focus-lock">
            <div className="game-card__body">
              <h3 className="game-card__title">已开启专注模式</h3>
              <p className="game-card__desc">「玩具」暂不可用。可在设置中随时关闭专注模式。</p>
              <Link className="game-card__btn game-card__btn--link" href="/settings#focus-mode">
                前往设置关闭
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="container">
      <section className="game-hero">
        <h1 className="game-hero__title">玩具</h1>
        <p className="game-hero__description">一些聪明山小游戏。</p>
      </section>

      {SECTIONS.map((sec) => (
        <section className="game-section" key={sec.key}>
          <h2 className="game-section__title">{sec.title}</h2>
          <p className="game-section__desc">{sec.desc}</p>

          <div className="game-grid">
            {sec.cards.map((g) => (
              <Link key={g.href} href={g.href} className="game-card">
                <div className="game-card__body">
                  <span className={`game-card__icon ${g.icon}`} aria-hidden="true" />
                  <h3 className="game-card__title">{g.title}</h3>
                  <p className="game-card__desc">{g.desc}</p>
                  <span className="game-card__btn">{g.cta ?? '开始游戏'}</span>
                </div>
              </Link>
            ))}

            <div className="game-card game-card--soon">
              <div className="game-card__body">
                <span className="game-card__icon game-card__icon--coming" aria-hidden="true" />
                <h3 className="game-card__title">{sec.soon.title}</h3>
                <p className="game-card__desc">{sec.soon.desc}</p>
                <span className="game-card__badge">即将到来</span>
              </div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
