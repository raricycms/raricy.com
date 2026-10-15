'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react';
import { WAND_HEIGHT, WAND_WIDTH, WAND_TILES, WAND_RADIUS, WAND_INPUT, WAND_TICK_MS, encodeWandInput, parseWandSnapshot, type WandSnapshot } from '../../../shared/wand/protocol';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
type Connection = { dispose(): void; sendInput?(): void };
type Frame = { previous: WandSnapshot; current: WandSnapshot; at: number };
const KEY_INPUT: Record<string, number> = {
  ArrowUp: WAND_INPUT.up, KeyW: WAND_INPUT.up, ArrowDown: WAND_INPUT.down, KeyS: WAND_INPUT.down,
  ArrowLeft: WAND_INPUT.left, KeyA: WAND_INPUT.left, ArrowRight: WAND_INPUT.right, KeyD: WAND_INPUT.right,
};
const STATUS_LABELS: Record<Status, string> = { idle: '未连接', connecting: '正在连接…', connected: '已连接', disconnected: '连接已断开', error: '连接失败' };

export default function WandDemo() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const connection = useRef<Connection | null>(null);
  const frame = useRef<Frame | null>(null);
  const ownId = useRef('');
  const ready = useRef(false);
  const mounted = useRef(false);
  const keys = useRef(new Set<string>());
  const touches = useRef(new Map<number, number>());
  const [state, setState] = useState<{ status: Status; count: number; message: string }>({ status: 'idle', count: 0, message: '' });

  useEffect(() => {
    mounted.current = true;
    let animation = 0;
    const context = canvas.current?.getContext('2d');
    function draw() {
      if (!context) return;
      context.fillStyle = '#6cdc00';
      context.fillRect(0, 0, WAND_WIDTH, WAND_HEIGHT);
      context.fillStyle = '#17aefb';
      WAND_TILES.forEach((row, y) => row.forEach((tile, x) => { if (tile) context.fillRect(x * 50, y * 50, 50, 50); }));
      const latest = frame.current;
      if (latest) {
        const progress = Math.min(1, (performance.now() - latest.at) / WAND_TICK_MS);
        for (const player of latest.current.players) {
          const previous = latest.previous.players.find((entry) => entry.id === player.id) ?? player;
          const x = previous.x + (player.x - previous.x) * progress;
          const y = previous.y + (player.y - previous.y) * progress;
          const mine = player.id === ownId.current;
          context.beginPath();
          context.arc(x, y, WAND_RADIUS, 0, Math.PI * 2);
          context.fillStyle = mine ? '#fff' : '#6236d9';
          context.fill();
          context.strokeStyle = '#183522';
          context.lineWidth = 2;
          context.stroke();
          const nameX = Math.max(50, Math.min(WAND_WIDTH - 50, x));
          const nameY = y < 30 ? y + 28 : y - 18;
          context.font = '13px sans-serif';
          context.textAlign = 'center';
          context.lineWidth = 3;
          context.strokeText(`${player.name}${mine ? '（你）' : ''}`, nameX, nameY, 100);
          context.fillStyle = '#fff';
          context.fillText(`${player.name}${mine ? '（你）' : ''}`, nameX, nameY, 100);
        }
      }
      animation = requestAnimationFrame(draw);
    }
    draw();
    function clearInput() {
      keys.current.clear();
      touches.current.clear();
      connection.current?.sendInput?.();
    }
    function keyDown(event: KeyboardEvent) {
      if (!ready.current || !KEY_INPUT[event.code]) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      keys.current.add(event.code);
    }
    function keyUp(event: KeyboardEvent) { keys.current.delete(event.code); }
    function visibility() { if (document.hidden) clearInput(); }
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      connection.current?.dispose();
      cancelAnimationFrame(animation);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', clearInput);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const connect = useCallback(async () => {
    connection.current?.dispose();
    const controller = new AbortController();
    let socket: WebSocket | null = null;
    let inputTimer: ReturnType<typeof setInterval> | undefined;
    let sequence = 0;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const current: Connection = {
      dispose() {
        controller.abort();
        clearInterval(inputTimer);
        clearTimeout(startupTimer);
        if (socket) {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          socket.close();
        }
        if (connection.current === current) {
          connection.current = null;
          ready.current = false;
          ownId.current = '';
          frame.current = null;
          keys.current.clear();
          touches.current.clear();
        }
      },
    };
    connection.current = current;
    function finish(status: Status, message = '') {
      if (connection.current !== current) return;
      current.dispose();
      if (mounted.current) setState({ status, count: 0, message });
    }
    startupTimer = setTimeout(() => finish('error', '连接超时，请稍后重试。'), 12000);
    setState({ status: 'connecting', count: 0, message: '' });
    try {
      const response = await fetch('/api/game/wand/launch', { method: 'POST', signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) { finish('error', typeof result.message === 'string' ? result.message : '暂时无法连接，请稍后重试。'); return; }
      if (typeof result.ticket !== 'string' || typeof result.wsUrl !== 'string') throw new Error('invalid_launch');
      const url = new URL(result.wsUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/realtime/wand') throw new Error('invalid_url');
      socket = new WebSocket(url);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket: result.ticket }));
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') { finish('error', '收到无效的游戏消息。'); return; }
        let message: unknown;
        try { message = JSON.parse(event.data); } catch { finish('error', '收到无效的游戏消息。'); return; }
        if (!message || typeof message !== 'object') return;
        const packet = message as Record<string, unknown>;
        if (packet.type === 'realtime.ready' && packet.version === 1 && packet.gameId === 'wand' && typeof packet.connectionId === 'string') {
          if (ready.current) { finish('error', '连接状态异常，请重新连接。'); return; }
          ownId.current = packet.connectionId;
          ready.current = true;
          clearTimeout(startupTimer);
          setState({ status: 'connected', count: 0, message: '' });
          current.sendInput = () => {
            if (socket?.readyState !== WebSocket.OPEN || !ready.current) return;
            let buttons = 0;
            for (const code of keys.current) buttons |= KEY_INPUT[code] ?? 0;
            for (const mask of touches.current.values()) buttons |= mask;
            socket.send(encodeWandInput(buttons, sequence++ % 65536));
          };
          inputTimer = setInterval(current.sendInput, WAND_TICK_MS);
          return;
        }
        if (packet.type === 'realtime.error') {
          finish('error', packet.code === 'permission_revoked' ? '账号状态已变化，连接已关闭。' : '身份验证失败，请重新登录或稍后重试。');
          return;
        }
        if (packet.type === 'wand.full') { finish('error', '测试房间已满，请稍后重试。'); return; }
        const snapshot = parseWandSnapshot(packet);
        if (!ready.current || !snapshot) { finish('error', '收到无效的游戏消息。'); return; }
        frame.current = { previous: frame.current?.current ?? snapshot, current: snapshot, at: performance.now() };
        setState((previous) => previous.count === snapshot.players.length ? previous : { ...previous, count: snapshot.players.length });
      };
      socket.onerror = () => finish('error', '无法连接实时服务，请稍后重试。');
      socket.onclose = () => finish('disconnected');
    } catch {
      if (!controller.signal.aborted) finish('error', '无法连接实时服务，请稍后重试。');
    }
  }, []);

  function direction(event: PointerEvent<HTMLButtonElement>, mask: number, pressed: boolean) {
    event.preventDefault();
    if (pressed) { event.currentTarget.setPointerCapture(event.pointerId); touches.current.set(event.pointerId, mask); }
    else touches.current.delete(event.pointerId);
    connection.current?.sendInput?.();
  }
  const controls = [
    { label: '向上', mask: WAND_INPUT.up, Icon: ArrowUp },
    { label: '向左', mask: WAND_INPUT.left, Icon: ArrowLeft },
    { label: '向下', mask: WAND_INPUT.down, Icon: ArrowDown },
    { label: '向右', mask: WAND_INPUT.right, Icon: ArrowRight },
  ];
  return (
    <div className="container wand-page">
      <Link href="/game/collections/test" className="game-back">返回测试合集</Link>
      <section className="wand-panel">
        <h1>Wand demo</h1>
        <div className="wand-toolbar">
          <p className="wand-status" role="status">{STATUS_LABELS[state.status]}{state.status === 'connected' && <> · <span className="numeric">{state.count}</span> 人在线</>}</p>
          {state.status === 'connected' ? (
            <button className="game-action" type="button" onClick={() => { connection.current?.dispose(); setState({ status: 'idle', count: 0, message: '' }); }}>断开连接</button>
          ) : (
            <button className="game-action" type="button" disabled={state.status === 'connecting'} onClick={() => void connect()}>{state.status === 'idle' ? '开始联机' : '重新连接'}</button>
          )}
        </div>
        {state.message && <p className="wand-error" role="alert">{state.message}</p>}
        <canvas ref={canvas} className="wand-canvas" width={WAND_WIDTH} height={WAND_HEIGHT} aria-label="Wand 游戏地图" />
        <div className="wand-controls" aria-label="移动方向">
          {controls.map(({ label, mask, Icon }) => (
            <button key={label} type="button" className="wand-direction" aria-label={label} disabled={state.status !== 'connected'}
              onPointerDown={(event) => direction(event, mask, true)} onPointerUp={(event) => direction(event, mask, false)}
              onPointerCancel={(event) => direction(event, mask, false)} onLostPointerCapture={(event) => { touches.current.delete(event.pointerId); }}>
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
        <p className="wand-help">方向键或 WASD 移动，手机可按住方向按钮。白点是你，蓝色湖泊无法进入。</p>
      </section>
    </div>
  );
}
