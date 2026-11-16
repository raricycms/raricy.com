'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Gamepad2 } from 'lucide-react';
import HeroLandscape from './HeroLandscape';

type Props = {
  blogHref: string;
  gamesBlocked: boolean;
};

// 首屏是一次「镜头推进」：页面滚过一小段、或点「开始探索」，文字向上退场、
// 山景靠近并居中、暗色蒙层压下来，探索与四张卡随后浮到蒙层之上。
// 卡片视图固定在视口里，后面的滚动继续走山景的竖直视差，滚完这一段才是页脚。
export default function HomeStage({ blogHref, gamesBlocked }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    // 两个阈值：进入要比退出更难一点，停在交界处来回滚时不至于反复切换。
    const evaluate = () => {
      frame = 0;
      const travelled = -stage.getBoundingClientRect().top;
      const enter = window.innerHeight * 0.3;
      const exit = window.innerHeight * 0.18;
      setExpanded((prev) => (prev ? travelled > exit : travelled >= enter));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(evaluate);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    evaluate();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // 点「开始探索」：跳过默认的锚点跳转（sticky 层里锚点滚不动），把页面一次性挪到
  // 展开态该在的位置，地址栏仍留 #features 以便分享/刷新。
  // 这里用瞬时跳转而不是平滑滚动：sticky 层钉在原处，画面上看不出位移，
  // 而平滑滚动会让滚动与镜头推进抢同一条时间线，读起来就是一次抽搐。
  const onExplore = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.scrollTo({ top: Math.round(window.innerHeight * 0.55), behavior: 'auto' });
    window.history.replaceState(null, '', '#features');
    setExpanded(true);
  };

  return (
    <div className={`home-stage${expanded ? ' is-expanded' : ''}`} ref={stageRef}>
      <div className="hero-section" id="home">
        <div className="home-stage__viewport">
          <HeroLandscape />
          <div className="home-stage__scrim" aria-hidden="true" />

          <div className="home-container home-stage__copy">
            <div className="hero-content">
              <p className="hero-eyebrow">Raricy.com</p>
              <h1 className="hero-title" id="hero-title">聪明山</h1>
              <p className="hero-tagline">我们总将找到答案</p>
              <p className="hero-description">这里是 Raricy.com 的主页面，<br />你可以由此进入站内的大部分页面。</p>
              <a className="hero-explore" href="#features" onClick={onExplore}>开始探索</a>
            </div>
          </div>

          <section className="home-features" id="features" aria-labelledby="features-title">
            <h2 className="home-display" id="features-title">探索</h2>
            <p className="home-features__sub">从这里进入站内的各项内容。</p>
            <div className="home-grid">
              <div className="home-grid-item">
                <Link className="feature-card card-story" href="/story">
                  <div className="card-body home-text-center">
                    <span className="feature-icon" aria-hidden="true"></span>
                    <h4 className="card-title">故事/小说</h4>
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
                      <h4 className="card-title">玩具</h4>
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
                    <h4 className="card-title">博客/文章</h4>
                    <p className="card-text">这里有一些博客文章和思考分享，涵盖技术、生活、思考等多个方面。</p>
                    <span className="home-btn home-btn--outline-warning home-btn--sm">阅读文章</span>
                  </div>
                </Link>
              </div>

              <div className="home-grid-item">
                <Link className="feature-card card-tool" href="/tool">
                  <div className="card-body home-text-center">
                    <span className="feature-icon" aria-hidden="true"></span>
                    <h4 className="card-title">工具</h4>
                    <p className="card-text">常用小工具合集：Base 编码、Hex 查看等，助你更高效。</p>
                    <span className="home-btn home-btn--outline-info home-btn--sm">打开工具箱</span>
                  </div>
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
