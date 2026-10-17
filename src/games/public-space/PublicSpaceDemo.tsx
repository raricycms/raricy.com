'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Grid2X2, Users } from 'lucide-react';
import Avatar from '@/app/components/Avatar';
import { REALTIME_PROTOCOL_VERSION } from '../../../shared/realtime/protocol';
import { PUBLIC_SPACE_SIZE, PUBLIC_SPACE_CELLS, PUBLIC_SPACE_HEARTBEAT_MS, PUBLIC_SPACE_TIMEOUT_MS,
  parsePublicSpaceSnapshot, type PublicSpaceSnapshot } from '../../../shared/public-space/protocol';

type Status = 'connecting' | 'connected' | 'disconnected' | 'error';
type Connection = { dispose(): void; move(cell: number | null): void };
const STATUS_LABELS: Record<Status, string> = {
  connecting: '正在连接…', connected: '已连接', disconnected: '已离开', error: '连接失败',
};

export default function PublicSpaceDemo({ userId }: { userId: string }) {
  const connection = useRef<Connection | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('');
  const [snapshot, setSnapshot] = useState<PublicSpaceSnapshot>({ type: 'public-space.snapshot', users: [] });
  const [pending, setPending] = useState(false);

  const connect = useCallback(() => {
    connection.current?.dispose();
    const controller = new AbortController();
    let socket: WebSocket | null = null;
    let ready = false, disposed = false, errorMessage = '';
    let lastSeen = performance.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => finish('error', '连接超时，请重新连接。'), 12_000);
    function dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      clearTimeout(deadline);
      clearInterval(heartbeat);
      socket?.close();
    }
    function finish(next: Status, text = '') {
      if (disposed) return;
      dispose();
      setStatus(next);
      setMessage(text);
      setPending(false);
      setSnapshot({ type: 'public-space.snapshot', users: [] });
    }
    connection.current = {
      dispose,
      move(cell) {
        if (!disposed && ready && socket?.readyState === WebSocket.OPEN) {
          setPending(true);
          setMessage('');
          socket.send(JSON.stringify({ type: 'public-space.move', cell }));
        }
      },
    };
    setStatus('connecting');
    setMessage('');
    setPending(false);
    setSnapshot({ type: 'public-space.snapshot', users: [] });
    void (async () => {
      try {
        const response = await fetch('/api/game/public-space/launch', { method: 'POST', signal: controller.signal });
        const data = await response.json();
        if (disposed) return;
        if (!response.ok) throw new Error(data.message || '暂时无法进入公共空间。');
        socket = new WebSocket(data.wsUrl);
        socket.onopen = () => {
          if (!disposed) socket?.send(JSON.stringify({ type: 'realtime.authenticate', version: REALTIME_PROTOCOL_VERSION, ticket: data.ticket }));
        };
        socket.onmessage = (event) => {
          if (disposed || typeof event.data !== 'string') return;
          let value;
          try { value = JSON.parse(event.data); } catch { return; }
          lastSeen = performance.now();
          if (value.type === 'realtime.ready') {
            if (ready || value.gameId !== 'public-space' || value.version !== REALTIME_PROTOCOL_VERSION) return;
            ready = true;
            heartbeat = setInterval(() => {
              if (performance.now() - lastSeen >= PUBLIC_SPACE_TIMEOUT_MS) {
                finish('error', '连接已中断，请重新连接。');
              } else if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'public-space.ping' }));
              }
            }, PUBLIC_SPACE_HEARTBEAT_MS);
          } else if (value.type === 'realtime.error') {
            errorMessage = value.code === 'permission_revoked' ? '账号状态已变化，连接已关闭。' : '连接失败，请稍后重试。';
            finish('error', errorMessage);
          } else if (value.type === 'public-space.full') {
            finish('error', '公共空间已满，请稍后重试。');
          } else if (value.type === 'public-space.occupied') {
            setMessage('这个位置刚被占了，请选择其他空格。');
            setPending(false);
          } else if (ready) {
            const next = parsePublicSpaceSnapshot(value);
            if (next) {
              clearTimeout(deadline);
              setSnapshot(next);
              setStatus('connected');
              setPending(false);
            }
          }
        };
        socket.onerror = () => finish('error', '无法连接公共空间，请稍后重试。');
        socket.onclose = () => finish('error', errorMessage || '连接已断开，请重新连接。');
      } catch (error) {
        if (!disposed) finish('error', error instanceof Error ? error.message : '连接失败，请稍后重试。');
      }
    })();
  }, []);

  useEffect(() => {
    connect();
    const leave = () => {
      connection.current?.dispose();
      setStatus('disconnected');
      setPending(false);
      setSnapshot({ type: 'public-space.snapshot', users: [] });
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);
    return () => {
      connection.current?.dispose();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
    };
  }, [connect]);

  const mine = snapshot.users.find((user) => user.userId === userId);
  const seated = snapshot.users.filter((user) => user.cell !== null);
  const spectators = snapshot.users.filter((user) => user.cell === null);
  const connected = status === 'connected';

  return (
    <div className="container public-space-page">
      <Link href="/game/collections/test" className="game-back">返回测试合集</Link>
      <section className="public-space-panel" aria-labelledby="public-space-title">
        <header className="public-space-header">
          <h1 id="public-space-title">公共空间 <span>demo</span></h1>
          <div className="public-space-toolbar">
            <p className="public-space-status" role="status">{STATUS_LABELS[status]}{connected && <> · <span className="numeric">{snapshot.users.length}</span> 人在线</>}</p>
            {connected ? <button type="button" className="game-back" onClick={() => {
              connection.current?.dispose();
              setStatus('disconnected');
              setPending(false);
              setMessage('');
              setSnapshot({ type: 'public-space.snapshot', users: [] });
            }}>离开空间</button> : status !== 'connecting' && <button type="button" className="game-action" onClick={connect}>重新连接</button>}
          </div>
        </header>
        <p className="public-space-help">点击空格放入自己的头像，再点自己的位置回到观众席。</p>
        {message && <p className="public-space-error" role="alert">{message}</p>}
        <div className="public-space-layout">
          <section className="public-space-board" aria-labelledby="public-space-board-title">
            <h2 id="public-space-board-title"><Grid2X2 aria-hidden="true" />网格 <span className="numeric">{seated.length} / {PUBLIC_SPACE_CELLS}</span></h2>
            <div className="public-space-grid" aria-label="5 × 5 公共空间网格" aria-busy={pending}>
              {Array.from({ length: PUBLIC_SPACE_CELLS }, (_, cell) => {
                const user = seated.find((entry) => entry.cell === cell);
                const own = user?.userId === userId;
                const row = Math.floor(cell / PUBLIC_SPACE_SIZE) + 1, column = cell % PUBLIC_SPACE_SIZE + 1;
                return <button type="button" key={cell}
                  className={`public-space-cell${own ? ' public-space-cell--mine' : ''}`}
                  disabled={!connected || pending || (!!user && !own)}
                  aria-pressed={own}
                  aria-label={`第 ${row} 行第 ${column} 列${user ? `，${user.name}${own ? '（你），点击回到观众席' : '，已占用'}` : '，空位'}`}
                  onClick={() => connection.current?.move(own ? null : cell)}>
                  {user ? <>
                    <Avatar userId={user.userId} frameUrl={user.frameUrl} alt={user.name} className="public-space-avatar" />
                    <span className="public-space-name">{own ? '你' : user.name}</span>
                  </> : <span className="public-space-coordinate numeric" aria-hidden="true">{row},{column}</span>}
                </button>;
              })}
            </div>
          </section>
          <section className="public-space-audience" aria-labelledby="public-space-audience-title">
            <h2 id="public-space-audience-title"><Users aria-hidden="true" />观众席 <span className="numeric">{spectators.length}</span></h2>
            <p className="public-space-help">{connected ? mine?.cell != null ? '你在网格中，可以点击其他空格换位。' : '你在观众席，点击空格即可入座。' : '连接后加入观众席。'}</p>
            {connected && mine?.cell != null && <button type="button" className="game-back" disabled={pending} onClick={() => connection.current?.move(null)}>回到观众席</button>}
            {spectators.length ? <ul className="public-space-spectators">
              {spectators.map((user) => <li key={user.userId} title={`${user.name}${user.userId === userId ? '（你）' : ''}`}>
                <Avatar userId={user.userId} frameUrl={user.frameUrl} alt={user.name} className="public-space-avatar" />
                <span className="public-space-name">{user.userId === userId ? '你' : user.name}</span>
              </li>)}
            </ul> : <p className="public-space-empty">{connected ? '暂时没有观众' : '等待连接'}</p>}
          </section>
        </div>
      </section>
    </div>
  );
}
