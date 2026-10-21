import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { isFocusGamesBlocked } from '@/lib/focus-mode';
import HomeFooterNote from './components/HomeFooterNote';
import HeroLandscape from './components/HeroLandscape';
import { Gamepad2 } from 'lucide-react';

// 首页 — 样式结构：home-container / home-display / feature-card / home-btn
//
// 故事 → 玩具 → 博客 → 工具；玩具随「专注模式屏蔽玩具区」隐藏。
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
      <section className="hero-section" id="home" aria-labelledby="hero-title">
        <HeroLandscape />
        <div className="home-container">
          <div className="hero-content">
            <p className="hero-eyebrow">RARICY.COM</p>
            <h1 className="hero-title" id="hero-title">聪明山</h1>
            <p className="hero-tagline">我们总将找到答案</p>
            <p className="hero-description">这里是 Raricy.com 的主页面，<br />你可以由此进入站内的大部分页面。</p>
            <a className="hero-explore" href="#features">开始探索</a>
          </div>
        </div>
      </section>

      <section className="features-section" id="features">
        <div className="home-container">
          <div className="home-row" style={{ marginBottom: '2rem' }}>
            <div className="home-col-12 home-text-center">
              <h2 className="home-display">探索</h2>
              <p className="home-lead u-text-muted">以下是此网站的核心内容。</p>
            </div>
          </div>

          <div className="home-grid">
            <div className="home-grid-item">
              <Link className="feature-card card-story" href="/story">
                <div className="card-body home-text-center">
                  <span className="feature-icon" aria-hidden="true"></span>
                  <h4 className="card-title" style={{ marginBottom: '0.75rem' }}>故事/小说</h4>
                  <p className="card-text">聪明山故事集，收录站内作者创作的原创小说与互动故事。</p>
                  <span className="home-btn home-btn--outline-primary home-btn--sm">开始阅读</span>
                </div>
              </Link>
            </div>

            {!gamesBlocked && (
              <div className="home-grid-item">
                <Link className="feature-card card-game" href="/game">
                  <div className="card-body home-text-center">
                    <Gamepad2 className="feature-game-icon" aria-hidden="true" />
                    <h4 className="card-title" style={{ marginBottom: '0.75rem' }}>玩具</h4>
                    <p className="card-text">ATÅMAS 浏览器小游戏。</p>
                    <span className="home-btn">打开玩具</span>
                  </div>
                </Link>
              </div>
            )}

            <div className="home-grid-item">
              <Link className="feature-card card-blog" href={blogHref}>
                <div className="card-body home-text-center">
                  <span className="feature-icon" aria-hidden="true"></span>
                  <h4 className="card-title" style={{ marginBottom: '0.75rem' }}>博客/文章</h4>
                  <p className="card-text">这里有一些博客文章和思考分享，涵盖技术、生活、思考等多个方面。</p>
                  <span className="home-btn home-btn--outline-warning home-btn--sm">阅读文章</span>
                </div>
              </Link>
            </div>

            <div className="home-grid-item">
              <Link className="feature-card card-tool" href="/tool">
                <div className="card-body home-text-center">
                  <span className="feature-icon" aria-hidden="true"></span>
                  <h4 className="card-title" style={{ marginBottom: '0.75rem' }}>工具</h4>
                  <p className="card-text">常用小工具合集：Base 编码、Hex 查看等，助你更高效。</p>
                  <span className="home-btn home-btn--outline-info home-btn--sm">打开工具箱</span>
                </div>
              </Link>
            </div>

          </div>
        </div>
      </section>

      <HomeFooterNote />
    </>
  );
}
