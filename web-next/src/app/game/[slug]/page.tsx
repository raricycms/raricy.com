import Link from 'next/link';
import { notFound } from 'next/navigation';

// ─────────────────────────────────────────────────────────────────────────────
// 待移植游戏的占位页。这些游戏在 Flask 侧是较大/复杂的纯前端引擎
// （3D 渲染、AI 搜索、复杂动画等），尚未移植到 Next.js。
// 此页面诚实说明状态，并链回仍可用的 Flask 版本 /game/<slug>。
//
// 注意：/game/utictactoe、/game/gomoku、/game/2048 有独立的原生页面（已移植），Next.js 路由
//       会优先匹配具体段而非本 [slug] 动态段，因此不会命中这里。
// ─────────────────────────────────────────────────────────────────────────────

const FLASK_ORIGIN = (process.env.NEXT_PUBLIC_FLASK_ORIGIN || 'https://raricy.com').replace(
  /\/$/,
  ''
);

type PendingGame = {
  title: string;
  desc: string;
  reason: string;
};

// 键即 URL slug（对齐 Flask 路由；2048 路由为 /game/2048）。
const PENDING: Record<string, PendingGame> = {
  cube: {
    title: '立方体滚滚',
    desc: '在多面体上涂满蓝色，用最少步数把所有面变蓝。',
    reason: '依赖 3D 多面体渲染与滚动动画，属大型客户端引擎。',
  },
  galaxies: {
    title: '螺旋星系',
    desc: '将网格划分为围绕圆点 180 度旋转对称的星系区域。',
    reason: '含复杂的对称求解与网格交互逻辑。',
  },
  connect4: {
    title: '四子棋',
    desc: '经典四子连线棋，含普通/障碍/盲棋等多种模式。',
    reason: '多模式规则与 AI 逻辑，体量较大。',
  },
  speed: {
    title: '速度接龙',
    desc: '本地双人竞速纸牌，红黑对拼，比谁先出完牌。',
    reason: '实时双人牌局状态机，交互密集。',
  },
  cubetictactoe: {
    title: '立方棋',
    desc: '4×4×4 立体井字棋，76 种连线，可旋转视角。',
    reason: '依赖 3D 视角旋转渲染。',
  },
  atamas: {
    title: 'ATÅMAS',
    desc: '在圆环上放置数字与加号，触发链式合并挑战高分。',
    reason: '完整的圆盘组合游戏引擎（链式合并 / 特殊加号 / 记分），最复杂的一项。',
  },
};

export function generateStaticParams() {
  return Object.keys(PENDING).map((slug) => ({ slug }));
}

export default async function PendingGamePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const game = PENDING[slug];
  if (!game) notFound();

  const flaskUrl = `${FLASK_ORIGIN}/game/${slug}`;

  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">{game.title}</h1>
      <p className="lede">{game.desc}</p>

      <div
        className="card"
        style={{ marginTop: 20, cursor: 'default', display: 'block' }}
      >
        <h3 style={{ marginTop: 0 }}>迁移进行中</h3>
        <p style={{ marginBottom: 12 }}>
          {/* TODO: 将此游戏从 app/static/js/game/{slug}.js 移植为 Next.js 客户端组件。 */}
          此游戏尚未移植到新版站点。原因：{game.reason}
        </p>
        <p style={{ marginBottom: 0 }}>
          目前可在旧版（Flask）站点体验：{' '}
          <a href={flaskUrl} target="_blank" rel="noopener noreferrer">
            {flaskUrl}
          </a>
        </p>
      </div>
    </main>
  );
}
