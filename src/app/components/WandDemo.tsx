'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 魔杖（Wand）demo — 从 Flask 侧 app/templates/game/wand_demo.html 的内联脚本
// 忠实移植到 React 客户端组件。
//
// 内容：
//   • 500×500 <canvas>，绿底（#6cdc00），一个白色小圆点玩家，用方向键移动。
//   • 一张 10×10 tile 地图，值为 1 的格子是“湖”（蓝色 #17aefb）不可进入；
//     逐轴（先 X 后 Y）解析碰撞 + 安全网回退，与原实现逐行对应。
//   • 启动流程 run()：先 POST /api/game/game_token 取令牌（同站自动带 Cookie），
//     未登录则提示并跳转 /login；拿到令牌后连 WebSocket（ws://localhost:3033），
//     每 50ms 发一帧二进制位置包（9 字节：opcode/id/x/y/seq/flag）。
//
// 与原版差异（均属迁移必要项）：
//   • token 端点由 /game/api/game_token 改为 /api/game/game_token。
//   • WS 地址可用 NEXT_PUBLIC_WAND_WS_URL 覆盖，默认仍为 ws://localhost:3033。
//   • 所有游戏状态存 ref，循环用 requestAnimationFrame，组件卸载时清理定时器 /
//     动画帧 / 事件监听 / WebSocket。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

const W = 500;
const H = 500;
const TILE_SIZE = 50;

// 1 = 湖（不可进入），0 = 草地
const TILE: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 1, 1, 1, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
  [0, 0, 0, 1, 1, 1, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];

const WS_URL = process.env.NEXT_PUBLIC_WAND_WS_URL || 'ws://localhost:3033';

export default function WandDemo() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = W;
    canvas.height = H;

    let then = Date.now();
    const keys: Record<string, boolean> = {};

    const myId = 0;
    let seq = 0;

    const player = { x: 50, y: 50, radius: 10, speed: 95 };

    // ── 清理句柄 ──
    let rafId = 0;
    let sendTimer: number | null = null;
    let socket: WebSocket | null = null;
    let cancelled = false;

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.key] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.key] = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    function collidesAny(px: number, py: number): boolean {
      const r = player.radius;
      const colL = Math.floor((px - r) / TILE_SIZE);
      const colR = Math.floor((px + r) / TILE_SIZE);
      const rowT = Math.floor((py - r) / TILE_SIZE);
      const rowB = Math.floor((py + r) / TILE_SIZE);
      for (let row = rowT; row <= rowB; row++) {
        for (let col = colL; col <= colR; col++) {
          if (row < 0 || row >= TILE.length || col < 0 || col >= TILE[0].length) return true;
          if (TILE[row][col] === 1) return true;
        }
      }
      return false;
    }

    function update(dt: number): void {
      let dx = 0;
      let dy = 0;
      if (keys['ArrowLeft']) dx -= 1;
      if (keys['ArrowRight']) dx += 1;
      if (keys['ArrowUp']) dy -= 1;
      if (keys['ArrowDown']) dy += 1;

      if (dx !== 0 && dy !== 0) {
        const diag = Math.SQRT1_2 * 1.05;
        dx *= diag;
        dy *= diag;
      }

      const r = player.radius;
      const stepX = dx * player.speed * dt;
      const stepY = dy * player.speed * dt;

      // ── X 轴 ──
      const prevX = player.x;
      player.x += stepX;

      if (dx > 0) {
        const col = Math.floor((player.x + r) / TILE_SIZE);
        const rowT = Math.floor((player.y - r) / TILE_SIZE);
        const rowB = Math.floor((player.y + r) / TILE_SIZE);
        for (let row = rowT; row <= rowB; row++) {
          if (row < 0 || row >= TILE.length || col < 0 || col >= TILE[0].length || TILE[row][col] === 1) {
            player.x = col * TILE_SIZE - r;
            break;
          }
        }
      } else if (dx < 0) {
        const col = Math.floor((player.x - r) / TILE_SIZE);
        const rowT = Math.floor((player.y - r) / TILE_SIZE);
        const rowB = Math.floor((player.y + r) / TILE_SIZE);
        for (let row = rowT; row <= rowB; row++) {
          if (row < 0 || row >= TILE.length || col < 0 || col >= TILE[0].length || TILE[row][col] === 1) {
            player.x = (col + 1) * TILE_SIZE + r;
            break;
          }
        }
      }

      // 安全网：解析后如果还在湖里，回退 X
      if (collidesAny(player.x, player.y)) {
        player.x = prevX;
      }

      // ── Y 轴 ──
      const prevY = player.y;
      player.y += stepY;

      if (dy > 0) {
        const row = Math.floor((player.y + r) / TILE_SIZE);
        const colL = Math.floor((player.x - r) / TILE_SIZE);
        const colR = Math.floor((player.x + r) / TILE_SIZE);
        for (let col = colL; col <= colR; col++) {
          if (col < 0 || col >= TILE[0].length || row < 0 || row >= TILE.length || TILE[row][col] === 1) {
            player.y = row * TILE_SIZE - r;
            break;
          }
        }
      } else if (dy < 0) {
        const row = Math.floor((player.y - r) / TILE_SIZE);
        const colL = Math.floor((player.x - r) / TILE_SIZE);
        const colR = Math.floor((player.x + r) / TILE_SIZE);
        for (let col = colL; col <= colR; col++) {
          if (col < 0 || col >= TILE[0].length || row < 0 || row >= TILE.length || TILE[row][col] === 1) {
            player.y = (row + 1) * TILE_SIZE + r;
            break;
          }
        }
      }

      // 安全网：解析后如果还在湖里，回退 Y
      if (collidesAny(player.x, player.y)) {
        player.y = prevY;
      }
    }

    function render(): void {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < TILE.length; i++) {
        for (let j = 0; j < TILE[i].length; j++) {
          if (TILE[i][j] === 1) {
            ctx.fillStyle = '#17aefb';
            ctx.fillRect(j * 50, i * 50, 50, 50);
          }
        }
      }

      ctx.beginPath();
      ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.closePath();
    }

    function gameloop(): void {
      if (cancelled) return;
      const now = Date.now();
      const dt = (now - then) / 1000;
      update(dt);
      render();
      then = now;
      rafId = requestAnimationFrame(gameloop);
    }

    async function run(): Promise<void> {
      try {
        // 1. 请求游戏 token（自动带 Cookie，因为同站）
        const resp = await fetch('/api/game/game_token', { method: 'POST' });
        if (!resp.ok) {
          // 未登录或请求失败，提示并跳转登录页
          alert('请先登录');
          window.location.href = '/login';
          return;
        }
        const data = await resp.json();
        const token: string = data.token;

        if (cancelled) return;

        // 2. 用 token 连接 WebSocket
        const wsUrl = `${WS_URL}?token=${encodeURIComponent(token)}`;
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
          console.log('[open] Connection established');
          console.log('Sending to server');
          socket?.send('My name is Raricy');
        };

        socket.onmessage = (event: MessageEvent) => {
          console.log(`[message] Data received from server: ${event.data}`);
        };

        sendTimer = window.setInterval(() => {
          if (!socket || socket.readyState !== WebSocket.OPEN) return;
          const buffer = new ArrayBuffer(9);
          const view = new DataView(buffer);
          view.setUint8(0, 0x01);
          view.setUint8(1, myId);
          view.setInt16(2, player.x);
          view.setInt16(4, player.y);
          view.setUint16(6, seq);
          view.setUint8(8, 0);
          socket.send(buffer);
          seq = (seq + 1) % 65536;
        }, 50);
      } catch (err) {
        console.error('获取 token 失败', err);
      }

      rafId = requestAnimationFrame(gameloop);
    }

    run();

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (rafId) cancelAnimationFrame(rafId);
      if (sendTimer !== null) window.clearInterval(sendTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} id="wand-canvas" className="wand-canvas" aria-label="魔杖 demo 画布" />
    </>
  );
}

// 自包含样式：Flask 无 wand-* 等价；保留以维持画布绿底（#6cdc00）视觉。
const WAND_CSS = `
.wand-canvas {
  background: #6cdc00;
  display: block;
  max-width: 100%;
  border-radius: 4px;
}
`;
