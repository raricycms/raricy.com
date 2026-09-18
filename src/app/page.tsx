import Link from 'next/link';
import HomeFooterNote from './components/HomeFooterNote';
import HeroCanvas from './components/HeroCanvas';

// 首页 — 样式结构：home-container / home-display / feature-card / home-btn
//
// 【四张卡都对所有人渲染，含「讨论」】/chat 是 core+ 档，非核心用户点进去会撞 403 ——
// 这是**有意保留**的：功能存在、但需要更高权限，是正常的权限阶梯（与顶栏「博客」
// 「日志」同一种待遇）。曾经按「入口与门禁同档」把讨论卡藏起来过，站长明确不要那样。
// 注意别把这条与另一种情况混为一谈：/admin/users 那种「入口有、门禁却不认」的
// 自相矛盾（核心用户看得到侧栏却被 403）才是必须修的，见 access-control.spec。
export default function HomePage() {
  return (
    <>
      <section className="hero-section" id="home">
        <HeroCanvas />
        <div className="home-container">
          <div className="home-row home-text-center">
            <div className="home-col-6">
              <div className="text-white fade-in-up hero-content">
                <h1 className="home-display" style={{ color: '#fff', marginBottom: '1rem' }}>聪明山</h1>
                <p className="home-lead" style={{ color: '#fff', opacity: 0.9, marginBottom: '1rem', fontSize: '1.5rem' }}>我们总将找到答案</p>
                <p style={{ color: '#fff', opacity: 0.9, marginBottom: '1rem', fontSize: '1.125rem' }}>
                  欢迎访问聪明山 website。这里是 Raricy.com 的主页面，你可以由此进入 Raricy.com 的大部分页面
                </p>
              </div>
            </div>
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

            <div className="home-grid-item">
              <Link className="feature-card card-blog" href="/blog">
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

            <div className="home-grid-item">
              <Link className="feature-card card-chat" href="/chat">
                <div className="card-body home-text-center">
                  <span className="feature-icon" aria-hidden="true"></span>
                  <h4 className="card-title" style={{ marginBottom: '0.75rem' }}>讨论</h4>
                  <p className="card-text">站内讨论区，欢迎在这里交流想法、分享发现。</p>
                  <span className="home-btn home-btn--outline-success home-btn--sm">进入讨论</span>
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