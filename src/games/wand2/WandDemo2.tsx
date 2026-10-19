'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Swords, Leaf, Trophy, Users, Maximize } from 'lucide-react';
import { INPUT, TICK_MS, encodeInput, parseSnapshot, type Snapshot } from '../../../shared/wand2/protocol';
import { makeGround, render, type Assets, type FloatText, type Frame } from './render';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
type Connection = { dispose(): void; sendInput?(): void };
const KEY_INPUT: Record<string, number> = {
  ArrowUp: INPUT.up, KeyW: INPUT.up, ArrowDown: INPUT.down, KeyS: INPUT.down,
  ArrowLeft: INPUT.left, KeyA: INPUT.left, ArrowRight: INPUT.right, KeyD: INPUT.right, Space: INPUT.attack, KeyJ: INPUT.attack,
};
const LABELS: Record<Status, string> = { idle: '未连接', connecting: '正在连接…', connected: '已连接', disconnected: '连接已断开', error: '连接失败' };

export default function WandDemo2() {
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null);
  const connection = useRef<Connection | null>(null), frame = useRef<Frame | null>(null);
  const ownId = useRef(''), ready = useRef(false), mounted = useRef(false);
  const keys = useRef(new Set<string>()), touches = useRef(new Map<number, number>()), floating = useRef<FloatText[]>([]);
  const joystickPointer = useRef<number | null>(null);
  const [stick, setStick] = useState({ x: 0, y: 0, active: false });
  const [status, setStatus] = useState<Status>('idle'), [message, setMessage] = useState(''), [assetsReady, setAssetsReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [myId, setMyId] = useState('');

  const clearInput = useCallback(() => {
    keys.current.clear(); touches.current.clear(); joystickPointer.current = null;
    if (mounted.current) setStick({ x: 0, y: 0, active: false });
    connection.current?.sendInput?.();
  }, []);

  useEffect(() => {
    mounted.current = true;
    let animation = 0, disposed = false, ground: HTMLCanvasElement | null = null;
    const context = canvas.current?.getContext('2d');
    const assets: Assets = { character: new Image(), attack: new Image(), world: new Image() };
    Promise.all(Object.entries(assets).map(([key, img]) => new Promise<void>((resolve, reject) => {
      img.onload = () => resolve(); img.onerror = () => reject(new Error('asset'));
      img.src = `/static/games/wand2/${key}.webp`;
    }))).then(() => { if (!disposed) { ground = makeGround(assets); setAssetsReady(true); } })
      .catch(() => { if (!disposed) setMessage('美术素材加载失败，请刷新页面重试。'); });
    function draw(now: number) {
      if (context && ground) {
        const compact = (canvas.current?.clientWidth ?? 960) < 640;
        const desiredHeight = compact ? 720 : 640;
        if (context.canvas.height !== desiredHeight) context.canvas.height = desiredHeight;
        render(context, assets, ground, frame.current, ownId.current, now, compact, floating.current);
      }
      animation = requestAnimationFrame(draw);
    }
    animation = requestAnimationFrame(draw);
    // React 的 touchstart 是被动监听；在游戏操作面上提前取消原生长按，避免选字/菜单的触觉反馈。
    const play = stage.current;
    function preventTouchGesture(event: TouchEvent) {
      if (event.target instanceof Element && event.target.closest('.wand2-canvas, .wand2-joystick, .wand2-attack') && event.cancelable) event.preventDefault();
    }
    play?.addEventListener('touchstart', preventTouchGesture, { passive: false });
    function keyDown(event: KeyboardEvent) {
      if (!ready.current || !KEY_INPUT[event.code]) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space' && event.target instanceof Element && event.target.closest('button, a')) return;
      event.preventDefault();
      if (keys.current.has(event.code)) return;
      keys.current.add(event.code); connection.current?.sendInput?.();
    }
    function keyUp(event: KeyboardEvent) { if (keys.current.delete(event.code)) { event.preventDefault(); connection.current?.sendInput?.(); } }
    function visibility() { if (document.hidden) clearInput(); }
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true; mounted.current = false; connection.current?.dispose(); cancelAnimationFrame(animation);
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', clearInput);
      document.removeEventListener('visibilitychange', visibility);
      play?.removeEventListener('touchstart', preventTouchGesture);
    };
  }, [clearInput]);

  const connect = useCallback(async () => {
    connection.current?.dispose();
    const controller = new AbortController();
    let socket: WebSocket | null = null, inputTimer: ReturnType<typeof setInterval> | undefined;
    let sequence = 0, lastUI = 0, startupTimer: ReturnType<typeof setTimeout> | undefined;
    const current: Connection = {
      dispose() {
        controller.abort(); clearInterval(inputTimer); clearTimeout(startupTimer);
        if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
        if (connection.current === current) {
          connection.current = null; ready.current = false; ownId.current = ''; frame.current = null;
          clearInput(); floating.current = [];
        }
      },
    };
    connection.current = current;
    function finish(next: Status, reason = '') {
      if (connection.current !== current) return;
      current.dispose(); if (mounted.current) { setStatus(next); setMessage(reason); setSnapshot(null); setMyId(''); }
    }
    startupTimer = setTimeout(() => finish('error', '连接超时，请稍后重试。'), 12000);
    setStatus('connecting'); setMessage(''); setSnapshot(null);
    try {
      const response = await fetch('/api/game/wand2/launch', { method: 'POST', signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) { finish('error', typeof result.message === 'string' ? result.message : '暂时无法连接，请稍后重试。'); return; }
      if (typeof result.ticket !== 'string' || typeof result.wsUrl !== 'string') throw new Error('invalid_launch');
      const url = new URL(result.wsUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/realtime/wand2') throw new Error('invalid_url');
      socket = new WebSocket(url);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket: result.ticket }));
      socket.onmessage = (event: MessageEvent) => {
        let packet: Record<string, unknown>;
        try { if (typeof event.data !== 'string') throw new Error('binary'); packet = JSON.parse(event.data); if (!packet || typeof packet !== 'object') throw new Error('packet'); }
        catch { finish('error', '收到无效的游戏消息。'); return; }
        if (packet.type === 'realtime.ready' && packet.version === 1 && packet.gameId === 'wand2' && typeof packet.connectionId === 'string') {
          if (ready.current) { finish('error', '连接状态异常，请重新连接。'); return; }
          ownId.current = packet.connectionId; setMyId(packet.connectionId); ready.current = true; clearTimeout(startupTimer); setStatus('connected');
          current.sendInput = () => {
            if (socket?.readyState !== WebSocket.OPEN || !ready.current) return;
            let buttons = 0; for (const code of keys.current) buttons |= KEY_INPUT[code] ?? 0;
            for (const mask of touches.current.values()) buttons |= mask;
            socket.send(encodeInput(buttons, sequence++ % 65536));
          };
          inputTimer = setInterval(current.sendInput, TICK_MS); return;
        }
        if (packet.type === 'realtime.error') { finish('error', packet.code === 'permission_revoked' ? '账号状态已变化，连接已关闭。' : '身份验证失败，请重新登录或稍后重试。'); return; }
        if (packet.type === 'wand2.full') { finish('error', '草地已满，请稍后重试。'); return; }
        const next = parseSnapshot(packet);
        if (!ready.current || !next) { finish('error', '收到无效的游戏消息。'); return; }
        const now = performance.now(), before = frame.current?.current;
        for (const p of next.players) {
          const old = before?.players.find(a => a.id === p.id);
          if (old && p.catnip > old.catnip) floating.current.push({ x: p.x, y: p.y, text: `+${p.catnip - old.catnip} 猫薄荷`, at: now });
        }
        floating.current = floating.current.filter(f => now - f.at < 1400);
        frame.current = { previous: before ?? next, current: next, at: now };
        if (now - lastUI > 150 || !before) { lastUI = now; setSnapshot(next); }
      };
      socket.onerror = () => finish('error', '无法连接实时服务，请稍后重试。'); socket.onclose = () => finish('disconnected');
    } catch { if (!controller.signal.aborted) finish('error', '无法连接实时服务，请稍后重试。'); }
  }, [clearInput]);

  function control(event: PointerEvent<HTMLElement>, mask: number) {
    event.preventDefault();
    if (!ready.current || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId); touches.current.set(event.pointerId, mask);
    connection.current?.sendInput?.();
  }
  function releaseControl(event: PointerEvent<HTMLElement>) {
    event.preventDefault();
    if (joystickPointer.current === event.pointerId) {
      joystickPointer.current = null; setStick({ x: 0, y: 0, active: false });
    }
    if (touches.current.delete(event.pointerId)) connection.current?.sendInput?.();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function moveJoystick(event: PointerEvent<HTMLButtonElement>) {
    if (joystickPointer.current !== event.pointerId) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect(), radius = box.width * .28;
    const dx = event.clientX - box.left - box.width / 2, dy = event.clientY - box.top - box.height / 2;
    const distance = Math.hypot(dx, dy), scale = distance > radius ? radius / distance : 1;
    let mask = 0;
    // 中心留死区，方向按 45° 分成八区；沿用服务端按键协议，斜向速度仍由服务端归一化。
    if (distance > radius * .2) {
      const threshold = distance * Math.sin(Math.PI / 8);
      if (Math.abs(dx) >= threshold) mask |= dx > 0 ? INPUT.right : INPUT.left;
      if (Math.abs(dy) >= threshold) mask |= dy > 0 ? INPUT.down : INPUT.up;
    }
    setStick({ x: dx * scale, y: dy * scale, active: true });
    if (touches.current.get(event.pointerId) !== mask) {
      touches.current.set(event.pointerId, mask); connection.current?.sendInput?.();
    }
  }
  const me = snapshot?.players.find(p => p.id === myId);
  const connected = status === 'connected';
  return (
    <div className="container wand2-page">
      <Link href="/game/collections/test" className="game-back">返回测试合集</Link>
      <section className="wand2-panel">
        <header className="wand2-header">
          <div><p className="wand2-eyebrow">WAND / MULTIPLAYER</p><h1>Wand demo 2</h1></div>
          <div className="wand2-toolbar">
            <p className="wand2-status" role="status" data-connected={connected}>{LABELS[status]}</p>
            <button className="game-action" type="button" disabled={status === 'connecting' || !assetsReady}
              onClick={(event) => {
                event.currentTarget.blur();
                if (connected) { connection.current?.dispose(); setStatus('idle'); setSnapshot(null); setMyId(''); setMessage(''); }
                else void connect();
              }}>{connected ? '离开草地' : status === 'idle' ? '开始联机' : '重新连接'}</button>
          </div>
        </header>
        {message && <p className="wand2-error" role="alert">{message}</p>}
        <div className="wand2-layout">
          <div className="wand2-play" ref={stage} onContextMenu={event => event.preventDefault()}>
            <div className="wand2-stage">
              <canvas ref={canvas} className="wand2-canvas" width={960} height={640} tabIndex={0} aria-label="Wand demo 2 共享草地，方向键移动，空格或 J 挥剑"
                onPointerDown={e => { if (connected) { e.currentTarget.focus({ preventScroll: true }); control(e, INPUT.attack); } }}
                onPointerUp={releaseControl} onPointerCancel={releaseControl} onLostPointerCapture={releaseControl} />
              <div className="wand2-hud"><span><Users size={14} aria-hidden="true" /><span className="numeric">{snapshot?.leaderboard.length ?? 0}</span> 人在线</span>
                <span><Leaf size={14} aria-hidden="true" /><span className="numeric">{me?.catnip ?? 0}</span> 猫薄荷</span></div>
              {!connected && <div className="wand2-overlay"><span>{status === 'connecting' ? '正在进入草地…' : assetsReady ? '点击「开始联机」进入草地' : '正在加载精灵…'}</span></div>}
              <button type="button" className="wand2-fullscreen" aria-label="全屏地图" onClick={event => {
                event.currentTarget.blur();
                if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
                else if (stage.current?.requestFullscreen) void stage.current.requestFullscreen().catch(() => {});
              }}><Maximize size={18} aria-hidden="true" /></button>
            </div>
            <div className="wand2-inputs">
              <div className="wand2-movement">
                <button type="button" className="wand2-joystick" aria-label="移动摇杆" aria-describedby="wand2-joystick-help" disabled={!connected} data-active={stick.active}
                  onPointerDown={event => {
                    event.preventDefault();
                    if (!ready.current || event.button !== 0 || joystickPointer.current !== null) return;
                    joystickPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); moveJoystick(event);
                  }} onPointerMove={moveJoystick} onPointerUp={releaseControl} onPointerCancel={releaseControl} onLostPointerCapture={releaseControl}>
                  <ArrowUp size={16} aria-hidden="true" /><ArrowLeft size={16} aria-hidden="true" /><ArrowDown size={16} aria-hidden="true" /><ArrowRight size={16} aria-hidden="true" />
                  <span className="wand2-joystick-knob" aria-hidden="true" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }} />
                </button>
                <span className="wand2-touchhelp" id="wand2-joystick-help">拖动移动 · 松手停止</span>
              </div>
              <p className="wand2-keyhelp"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / 方向键移动<br /><kbd>Space</kbd> / <kbd>J</kbd> / 点击地图挥剑</p>
              <button type="button" className="wand2-attack" aria-label="挥剑" disabled={!connected}
                onPointerDown={e => control(e, INPUT.attack)} onPointerUp={releaseControl} onPointerCancel={releaseControl}
                onLostPointerCapture={releaseControl}><Swords size={25} aria-hidden="true" /><span>挥剑</span></button>
            </div>
          </div>
          <aside className="wand2-sidebar">
            <div className="wand2-leaderboard"><h2><Trophy size={18} aria-hidden="true" />猫薄荷排行</h2><p className="wand2-caption">当前在线玩家 · 实时更新</p>
              {snapshot?.leaderboard.length ? <ol>{snapshot.leaderboard.map((r, i) => (
                <li key={r.id} data-mine={snapshot.players.some(p => p.id === myId && p.name === r.name)}><span className="wand2-rank numeric">{i + 1}</span>
                  <span className="wand2-player-name">{r.name}{r.connections > 1 && <small> ×<span className="numeric">{r.connections}</span></small>}</span>
                  <strong className="numeric">{r.catnip}</strong><Leaf size={13} aria-hidden="true" /></li>
              ))}</ol> : <p className="wand2-empty">进入草地后显示排行</p>}
            </div>
            <div className="wand2-guide"><h2><Swords size={18} aria-hidden="true" />草地手册</h2>
              <p>面向史莱姆挥剑，击败后自动获得猫薄荷。按住攻击可连续挥剑。</p>
              <div className="wand2-rewards"><span>青绿 <b className="numeric">+1</b></span><span>淡紫 <b className="numeric">+3</b></span><span>金色 <b className="numeric">+5</b></span></div>
              <p>看到蓄力圆圈就躲开！碰撞会触发受击、后退与短暂无敌，不扣除猫薄荷。</p>
              <p className="wand2-caption">猫薄荷仅用于本 demo，按账号共享，本次服务运行内累计；服务重启后清零。</p>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
