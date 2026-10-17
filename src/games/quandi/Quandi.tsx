'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseQuandiCommand } from '../../../shared/quandi/protocol';
import { REALTIME_PROTOCOL_VERSION } from '../../../shared/realtime/protocol';

export default function Quandi() {
  const iframe = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<MessagePort | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const [status, setStatus] = useState('未连接');
  const [error, setError] = useState('');
  const attach = useCallback(() => {
    cleanup.current();
    bridge.current?.close();
    const target = iframe.current?.contentWindow;
    if (!target) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    bridge.current = port;
    let socket: WebSocket | null = null;
    let pending = false, ready = false, disposed = false, generation = 0;
    let controller: AbortController | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let lastReceived = 0, lastPing = 0;
    const post = (message: object) => { if (!disposed) port.postMessage(message); };
    function stop(message = '', report = true) {
      generation++;
      controller?.abort(); controller = null;
      clearInterval(heartbeat); clearTimeout(deadline);
      if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); socket = null; }
      pending = ready = false;
      if (report && !disposed) {
        setStatus('未连接'); setError(message);
        post({ type: 'closed', message });
      }
    }
    cleanup.current = () => { disposed = true; stop('', false); port.close(); };
    async function connect() {
      if (pending || socket || disposed) return;
      const attempt = ++generation;
      pending = true; setStatus('正在连接'); setError('');
      controller = new AbortController();
      deadline = setTimeout(() => stop('连接超时，请重新连接。'), 10_000);
      try {
        const response = await fetch('/api/game/quandi/launch', { method: 'POST', signal: controller.signal });
        const result = await response.json();
        if (disposed || !pending || attempt !== generation) return;
        if (!response.ok) { stop(typeof result.message === 'string' ? result.message : '无法连接实时服务。'); return; }
        const url = new URL(result.wsUrl);
        if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/realtime/quandi'
            || url.username || url.password || url.search || url.hash
            || typeof result.ticket !== 'string' || result.ticket.length > 2048) throw new Error('invalid_launch');
        const current = new WebSocket(url);
        socket = current;
        current.onopen = () => current.send(JSON.stringify({ type: 'realtime.authenticate', version: REALTIME_PROTOCOL_VERSION, ticket: result.ticket }));
        current.onmessage = (event) => {
          if (typeof event.data !== 'string' || event.data.length > 256 * 1024) { stop('收到无效的游戏消息。'); return; }
          let packet: { type?: string; code?: string; version?: number; gameId?: string; data?: unknown };
          try { packet = JSON.parse(event.data); } catch { stop('收到无效的游戏消息。'); return; }
          if (!packet || typeof packet !== 'object') { stop('收到无效的游戏消息。'); return; }
          lastReceived = performance.now();
          if (packet.type === 'realtime.error') {
            stop(packet.code === 'permission_revoked' ? '账号状态已变化，连接已关闭。' : '连接已关闭，请重新连接。'); return;
          }
          if (packet.type === 'realtime.ready') {
            if (ready || packet.version !== REALTIME_PROTOCOL_VERSION || packet.gameId !== 'quandi') { stop('游戏协议不匹配。'); return; }
            ready = true; pending = false; clearTimeout(deadline); setStatus('已连接');
            const ping = () => {
              if (performance.now() - lastReceived > 15_000) { stop('连接无响应，请重新连接。'); return; }
              lastPing = performance.now(); current.send(JSON.stringify({ type: 'C2S_PING', data: {} }));
            };
            heartbeat = setInterval(ping, 5000); ping(); return;
          }
          if (!ready || typeof packet.type !== 'string' || !/^S2C_[A-Z_]+$/.test(packet.type)) { stop('收到无效的游戏消息。'); return; }
          if (packet.type === 'S2C_PONG') post({ type: 'latency', milliseconds: Math.round(performance.now() - lastPing) });
          else post({ type: 'packet', packet });
        };
        current.onclose = () => stop('连接已断开，重连后需重新加入房间。');
        current.onerror = () => stop('无法连接实时服务，请稍后重试。');
      } catch (cause) {
        if (!disposed && attempt === generation && !(cause instanceof DOMException && cause.name === 'AbortError')) stop('无法连接实时服务，请稍后重试。');
      }
    }
    port.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object' || disposed) return;
      if (message.type === 'connect') { void connect(); return; }
      if (message.type === 'disconnect') { stop(); return; }
      if (message.type === 'send') {
        const command = parseQuandiCommand(message.command);
        if (!command) { stop('游戏操作无效。'); return; }
        if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
      }
    };
    // iframe 是不透明来源，因此 targetOrigin 必须为 *；唯一的端口只交给本 iframe。
    target.postMessage({ type: 'quandi.bridge' }, '*', [channel.port2]);
  }, []);
  useEffect(() => () => { cleanup.current(); bridge.current?.close(); }, []);

  return (
    <div className="container quandi-page">
      <div className="quandi-toolbar">
        <Link className="game-back" href="/game/collections/test">返回测试合集</Link>
        <h1>圈地运动</h1>
        <span className="quandi-status" role="status">{status}</span>
      </div>
      {error && <p className="quandi-error" role="alert">{error}</p>}
      <p className="quandi-help">本地双人：WASD / 方向键。联机：使用本站账号，创建房间后分享房间码。点击游戏画面后操作。</p>
      <iframe ref={iframe} onLoad={attach} className="quandi-frame" title="圈地运动游戏" src="/game/quandi/play" sandbox="allow-scripts" referrerPolicy="no-referrer" />
      <p className="quandi-credit">原作：<a href="https://github.com/yao1145/quandiyundong" target="_blank" rel="noreferrer">yaozitao / yao1145</a>，经授权适配本站。</p>
    </div>
  );
}
