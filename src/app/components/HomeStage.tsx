'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Gamepad2 } from 'lucide-react';
import HeroLandscape from './HeroLandscape';
import ScrollSnap from './ScrollSnap';

type Props = {
  blogHref: string;
  gamesBlocked: boolean;
};

// 卡片视图在滚动里的位置（相对 sticky 层高度的比例）：点「开始探索」跳到这里，
// 展开的进入/退出阈值按同一把尺子给，触屏吸附的卡片停靠点也取这个数 ——
// 三处用同一个值，停下时才是同一幅画面。
const CARD_VIEW_RATIO = 0.55;

/** 卡片视图那一格的滚动位置；sticky 层还没挂上时返回 null。 */
function cardViewScrollTop(layer: HTMLElement | null): number | null {
  return layer ? Math.round(layer.getBoundingClientRect().height * CARD_VIEW_RATIO) : null;
}

// 首屏是一次「镜头推进」：页面滚过一小段、或点「开始探索」，文字向上退场、
// 山景靠近并居中、暗色蒙层压下来，探索与四张卡随后浮到蒙层之上。
// 卡片视图固定在视口里，后面的滚动继续走山景的竖直视差，滚完这一段才是页脚。
export default function HomeStage({ blogHref, gamesBlocked }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // inert 只能等挂载后再加：SSR 里没有「展开态」这个概念，若把 inert 写进首屏 HTML，
  // 禁用 JS 的访客会看到卡片却点不动（`html:not(.js)` 只负责版面回退，管不了惰性）。
  // 挂载后客户端接管，收起态卡片与展开态文字层才真正退出焦点序列。
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const layer = layerRef.current;
    if (!stage || !layer) return;
    let frame = 0;
    // 两个阈值：进入要比退出更难一点，停在交界处来回滚时不至于反复切换。
    // 尺子用 sticky 层的高度（窄屏 lvh、桌面 vh − 顶栏），它不随地址栏收放变化。
    const evaluate = () => {
      frame = 0;
      const travelled = -stage.getBoundingClientRect().top;
      const unit = layer.getBoundingClientRect().height;
      const enter = unit * 0.3;
      const exit = unit * 0.18;
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

  // 深链：地址里带 #features 时直接进展开态。sticky 层里的锚点本身不产生滚动，
  // 所以这里按同样的位置把页面挪到位，分享与刷新都能回到卡片视图。
  useEffect(() => {
    const applyHash = () => {
      if (window.location.hash !== '#features') return;
      const top = cardViewScrollTop(layerRef.current);
      if (top === null) return;
      window.scrollTo({ top, behavior: 'auto' });
      setExpanded(true);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // 点「开始探索」：跳过默认的锚点跳转（sticky 层里锚点滚不动），把页面一次性挪到
  // 展开态该在的位置，地址栏仍留 #features 以便分享/刷新。
  // 这里用瞬时跳转而不是平滑滚动：sticky 层钉在原处，画面上看不出位移，
  // 而平滑滚动会让滚动与镜头推进抢同一条时间线，读起来就是一次抽搐。
  const onExplore = (event: MouseEvent<HTMLAnchorElement>) => {
    // 带修饰键的点击让它按浏览器默认行为走（新标签打开 #features）。
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const top = cardViewScrollTop(layerRef.current);
    if (top === null) return;
    event.preventDefault();
    window.scrollTo({ top, behavior: 'auto' });
    window.history.replaceState(null, '', '#features');
    setExpanded(true);
    // 焦点跟着视图走：否则键盘用户还停在已经淡出的「开始探索」上。等一帧 ——
    // 卡片区这一帧还带着 inert，立即调用 focus 会被浏览器忽略。
    window.requestAnimationFrame(() => {
      document.getElementById('features-title')?.focus({ preventScroll: true });
    });
  };

  return (
    <div className={`home-stage${expanded ? ' is-expanded' : ''}`} ref={stageRef}>
      <ScrollSnap mode="stage" />
      <div className="hero-section" id="home">
        {/* 触屏吸附的两个停靠点：0 与卡片视图。都用 1px 标记 —— 整屏高的元素当停靠点时，
            顶边与底边之间会空出一段不吸附的位置（见 styles-scss/base/_scroll-snap.scss）。
            卡片视图那格的 top 与「开始探索」的滚动位置同源，lvh 与窄屏 sticky 层等高。 */}
        <div className="home-stage__snap" aria-hidden="true" style={{ top: 0 }} />
        <div
          className="home-stage__snap home-stage__snap--card"
          aria-hidden="true"
          style={{ top: `calc(${CARD_VIEW_RATIO} * 100lvh)` }}
        />
        <div className="home-stage__viewport" ref={layerRef}>
          <HeroLandscape />
          <div className="home-stage__scrim" aria-hidden="true" />

          <div className="home-container home-stage__copy" inert={mounted && expanded}>
            <div className="hero-content">
              <p className="hero-eyebrow">Raricy.com</p>
              <h1 className="hero-title" id="hero-title">聪明山</h1>
              <p className="hero-tagline">我们总将找到答案</p>
              <p className="hero-description">这里是 Raricy.com 的主页面，<br />你可以由此进入站内的大部分页面。</p>
              <a className="hero-explore" href="#features" onClick={onExplore}>开始探索</a>
            </div>
          </div>

          <section className="home-features" id="features" aria-labelledby="features-title" inert={mounted && !expanded}>
            <h2 className="home-display" id="features-title" tabIndex={-1}>探索</h2>
            <div
              className="home-grid"
              style={{ '--home-card-count': gamesBlocked ? 3 : 4 } as CSSProperties}
            >
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
