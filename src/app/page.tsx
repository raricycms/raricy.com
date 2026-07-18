import Link from 'next/link';
import HeroCanvas from './components/HeroCanvas';
import HomeFooterNote from './components/HomeFooterNote';

// 严格对齐原 homepage.html：hero(星空 canvas) + features(fcard 网格)。
export default function HomePage() {
  return (
    <>
      <section className="hero" id="home">
        <HeroCanvas />
        <div className="wrap">
          <h1 className="hero__title">聪明山</h1>
          <p className="hero__tagline">我们总将找到答案</p>
          <p className="hero__desc">
            欢迎访问聪明山 website。这里是 Raricy.com 的主页面，你可以由此进入 Raricy.com
            的大部分页面。
          </p>
        </div>
      </section>

      <section className="features" id="features">
        <div className="wrap">
          <div className="features__head">
            <h2>探索</h2>
            <p>以下是此网站的核心内容。</p>
          </div>

          <div className="features__grid">
            <Link className="card card--link fcard fcard--story" href="/story">
              <span className="fcard__icon" aria-hidden="true"></span>
              <h3 className="fcard__title">故事/小说</h3>
              <p className="fcard__desc">
                聪明山故事集，这里有一些聪明山的原创故事和小说，也有代发的原创小说。
              </p>
              <span className="fcard__btn">开始阅读</span>
            </Link>

            <Link className="card card--link fcard fcard--game" href="/game">
              <span className="fcard__icon" aria-hidden="true"></span>
              <h3 className="fcard__title">玩具</h3>
              <p className="fcard__desc">一些神秘小游戏。感谢各位创作者的贡献！</p>
              <span className="fcard__btn">进入玩具区</span>
            </Link>

            <Link className="card card--link fcard fcard--blog" href="/blog">
              <span className="fcard__icon" aria-hidden="true"></span>
              <h3 className="fcard__title">博客/文章</h3>
              <p className="fcard__desc">
                这里有一些博客文章和思考分享，涵盖技术、生活、思考等多个方面。
              </p>
              <span className="fcard__btn">阅读文章</span>
            </Link>

            <Link className="card card--link fcard fcard--tool" href="/tool">
              <span className="fcard__icon" aria-hidden="true"></span>
              <h3 className="fcard__title">工具</h3>
              <p className="fcard__desc">常用小工具合集：Base 编码、Hex 查看等，助你更高效。</p>
              <span className="fcard__btn">打开工具箱</span>
            </Link>
          </div>
        </div>
      </section>

      {/* 仅首页可见的页脚提示（对齐原 homepage.html 的 footer_text 块） */}
      <HomeFooterNote />
    </>
  );
}
