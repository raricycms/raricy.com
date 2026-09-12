'use client';

import { useEffect, useRef } from 'react';

// 首页星空背景 — 逐字节对齐 Flask homepage.html 的内联脚本（保留 Flask 原行为）
export default function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const hero = canvas.parentElement as HTMLElement | null;
    if (!hero) return;

    interface Particle { x: number; y: number; dx: number; dy: number; radius: number; color: string; update(): void; draw(): void }
    let particles: Particle[] = [];
    let mouse = { x: null as number | null, y: null as number | null };

    function debounce(func: (...args: unknown[]) => void, wait = 250) {
      let timeout: ReturnType<typeof setTimeout>;
      return function (this: unknown, ...args: unknown[]) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    }

    function resizeCanvas() {
      canvas!.width = window.innerWidth;
      canvas!.height = hero!.offsetHeight;
      init();
    }

    function onMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    }
    function onOut() {
      mouse.x = null;
      mouse.y = null;
    }

    class P {
      x: number; y: number; dx: number; dy: number; radius: number; color: string;
      constructor(x: number, y: number, dx: number, dy: number, radius: number, color: string) {
        this.x = x; this.y = y; this.dx = dx; this.dy = dy;
        this.radius = radius; this.color = color;
      }
      draw() {
        ctx!.beginPath();
        ctx!.arc(this.x, this.y, this.radius, 0, Math.PI * 2, false);
        ctx!.fillStyle = this.color;
        ctx!.fill();
      }
      update() {
        if (this.x + this.radius > canvas!.width || this.x - this.radius < 0) this.dx = -this.dx;
        if (this.y + this.radius > canvas!.height || this.y - this.radius < 0) this.dy = -this.dy;
        this.x += this.dx; this.y += this.dy;
        this.draw();
      }
    }

    function init() {
      particles = [];
      for (let i = 0; i < 80; i++) {
        const radius = Math.random() * 2 + 1;
        const x = Math.random() * (canvas!.width - radius * 2) + radius;
        const y = Math.random() * (canvas!.height - radius * 2) + radius;
        const dx = (Math.random() - 0.5) * 0.5;
        const dy = (Math.random() - 0.5) * 0.5;
        particles.push(new P(x, y, dx, dy, radius, 'rgba(255, 255, 255, 0.5)'));
      }
    }

    let animationFrameId: number | null = null;
    function animate() {
      animationFrameId = requestAnimationFrame(animate);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      particles.forEach((p) => p.update());
    }
    function handleVisibilityChange() {
      if (document.hidden) {
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
      } else {
        if (!animationFrameId) animate();
      }
    }

    resizeCanvas();
    animate();
    window.addEventListener('resize', debounce(resizeCanvas));
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onOut);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', debounce(resizeCanvas));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onOut);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return <canvas id="hero-canvas" aria-hidden="true" ref={ref} />;
}