'use client';

import { useEffect, useRef } from 'react';

// 首页星空背景：漂浮星点，深浅自适应，尊重 reduced-motion，后台暂停。
// 逐字节对齐原 homepage.html 的内联脚本。
export default function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const hero = canvas?.parentElement as HTMLElement | null;
    if (!canvas || !hero) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let particles: Array<{ x: number; y: number; dx: number; dy: number; r: number; color: string }> = [];
    let frameId: number | null = null;
    const reduceMotion =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function starColor() {
      return document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'rgba(255,255,255,0.55)'
        : 'rgba(90,100,130,0.38)';
    }
    function init() {
      canvas!.width = hero!.offsetWidth;
      canvas!.height = hero!.offsetHeight;
      const color = starColor();
      const count = Math.min(90, Math.round((canvas!.width * canvas!.height) / 14000));
      particles = [];
      for (let i = 0; i < count; i++) {
        const r = Math.random() * 1.6 + 0.6;
        particles.push({
          x: Math.random() * canvas!.width,
          y: Math.random() * canvas!.height,
          dx: (Math.random() - 0.5) * 0.45,
          dy: (Math.random() - 0.5) * 0.45,
          r,
          color,
        });
      }
    }
    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      for (const p of particles) {
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fillStyle = p.color;
        ctx!.fill();
      }
    }
    function step() {
      frameId = requestAnimationFrame(step);
      for (const p of particles) {
        if (p.x + p.r > canvas!.width || p.x - p.r < 0) p.dx = -p.dx;
        if (p.y + p.r > canvas!.height || p.y - p.r < 0) p.dy = -p.dy;
        p.x += p.dx;
        p.y += p.dy;
      }
      draw();
    }
    function start() {
      if (reduceMotion) {
        draw();
        return;
      }
      if (!frameId) step();
    }
    function stop() {
      if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    }
    function debounce(fn: () => void, wait: number) {
      let t: ReturnType<typeof setTimeout>;
      return () => {
        clearTimeout(t);
        t = setTimeout(fn, wait || 200);
      };
    }

    init();
    start();
    const onResize = debounce(() => {
      init();
      if (reduceMotion) draw();
    }, 200);
    const onVis = () => (document.hidden ? stop() : start());
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    const obs = new MutationObserver(() => {
      const c = starColor();
      for (const p of particles) p.color = c;
      if (reduceMotion) draw();
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      obs.disconnect();
    };
  }, []);

  return <canvas className="hero__canvas" id="hero-canvas" aria-hidden="true" ref={ref} />;
}
