'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnlineGomoku.tsx — 五子棋联机对战
//
// 【服务端权威】本组件不做任何规则判定：能不能走、走哪儿合法、谁赢了，全由
// 服务端说了算（见 lib/gomoku-room.ts）。这里只做三件事：把服务端下发的 grid
// 画出来、把自己的点击 POST 上去、把实时帧应用进来。
//
// 【为什么是 SSE 不是 WebSocket】棋是回合制，走子间隔以秒计，单向下行完全够用；
// 而走子走 POST 白拿 CSRF 同源校验、限频与 session 鉴权。开 WS 要自定义 server，
// 会顶掉 next start 与 systemd unit。响应头那套坑全在 lib/sse.ts。
//
// 【revision 去重】走子的 POST 响应与 SSE 推的帧是同一份状态，谁先到不一定。
// 两者都过 applyView，按 revision 丢弃过期的 —— 不去重的话棋盘会闪回上一手。
//
// 【StrictMode】next.config 开了 reactStrictMode，dev 下 effect 双跑。
// 建房是按钮触发的（不会双跑），但带 ?room= 进来自动加入会 —— 用 joinedRef 闩住。
// 何况服务端 join 本身幂等，重连/刷新都靠它回到原座。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BLACK, type Player } from '@/lib/gomoku-rules';
import { FOCUS_MODE_SETTINGS_HREF } from '@/lib/focus-mode';
import type {
  GomokuRoomSnapshot,
  GomokuRoomView,
  GomokuStreamEvent,
  RoomRole,
  Seat,
} from '@/lib/gomoku-shared';
import GomokuCanvas from './GomokuCanvas';

/** 对手掉线满这么久，本方可以判胜（与服务端 DISCONNECT_CLAIM_MS 一致）。 */
const CLAIM_AFTER_MS = 60_000;

type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';

export interface OnlineGomokuProps {
  initialRoom?: string | null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '出错了，请重试';
}

export default function OnlineGomoku({ initialRoom = null }: OnlineGomokuProps) {
  const [snapshot, setSnapshot] = useState<GomokuRoomSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState(initialRoom ?? '');
  /** 对手掉线后的本地秒表（配合服务端给的 disconnectedForMs 一起算）。 */
  const [tick, setTick] = useState(0);

  // 事件回调里要读最新快照，用 ref 避开闭包过期
  const snapshotRef = useRef<GomokuRoomSnapshot | null>(null);
  snapshotRef.current = snapshot;
  /** StrictMode 闩锁：带 ?room= 进来自动加入只做一次。 */
  const joinedRef = useRef(false);

  const code = snapshot?.view.code ?? null;

  /** 应用一份服务端状态。POST 响应与 SSE 帧都走这里，按 revision 去重。 */
  const applyView = useCallback((view: GomokuRoomView) => {
    setSnapshot((prev) => {
      if (!prev) return prev; // 还没 join（you 未知），忽略
      if (view.revision < prev.view.revision) return prev; // 过期帧
      return { ...prev, view };
    });
    setTick(0); // 新状态到了，本地秒表归零（disconnectedForMs 已是服务端最新值）
  }, []);

  /** POST 一个联机接口，返回 data.room（若有）。 */
  const post = useCallback(async (path: string, body?: unknown) => {
    const res = await fetch(path, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      room?: GomokuRoomSnapshot;
    };
    if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
    return data;
  }, []);

  /** 进入房间：记录快照、把房号写回 URL（可分享/可收藏）。 */
  const enterRoom = useCallback((room: GomokuRoomSnapshot) => {
    setSnapshot(room);
    setError(null);
    setConn('connecting');
    const url = new URL(window.location.href);
    url.searchParams.set('mode', 'online');
    url.searchParams.set('room', room.view.code);
    // replaceState 而非 router.push：URL 只是应用状态自己的镜像，不该触发一次 RSC 往返
    window.history.replaceState({}, '', url.toString());
  }, []);

  const createRoom = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post('/api/game/gomoku/rooms');
      if (data.room) enterRoom(data.room);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [post, enterRoom]);

  const joinRoom = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      setBusy(true);
      setError(null);
      try {
        const data = await post(`/api/game/gomoku/rooms/${encodeURIComponent(value)}/join`);
        if (data.room) enterRoom(data.room);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [post, enterRoom]
  );

  /** 走子 / 认输 / 判胜 / 再来一局 —— 都是 POST 一个动作，拿回新状态。 */
  const action = useCallback(
    async (suffix: string, body?: unknown) => {
      const current = snapshotRef.current;
      if (!current) return;
      setError(null);
      try {
        const data = await post(
          `/api/game/gomoku/rooms/${current.view.code}${suffix}`,
          body
        );
        if (data.room) applyView(data.room.view);
      } catch (e) {
        setError(errText(e));
      }
    },
    [post, applyView]
  );

  // 带房号进来自动加入（幂等；闩锁防 StrictMode 双跑）
  useEffect(() => {
    if (!initialRoom || joinedRef.current) return;
    joinedRef.current = true;
    void joinRoom(initialRoom);
  }, [initialRoom, joinRoom]);

  // ── 实时流 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!code) return;
    let es: EventSource | null = null;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      setConn((c) => (c === 'idle' || c === 'connecting' ? 'connecting' : 'reconnecting'));
      es = new EventSource(`/api/game/gomoku/rooms/${code}/stream`);

      es.onopen = () => setConn('open');
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as GomokuStreamEvent;
          if (event.type === 'state') applyView(event.view);
        } catch {
          /* 坏帧忽略：下一帧仍是全量状态，不会因此丢数据 */
        }
      };
      es.onerror = () => {
        // EventSource 会自己按 retry 重连；readyState=CLOSED 表示它放弃了重试
        // （服务端返了非 200：403 权限变了 / 404 房间过期）。
        if (es && es.readyState === EventSource.CLOSED) {
          setConn('dead');
        } else {
          setConn('reconnecting');
        }
      };
    };

    open();

    // 标签页隐藏时主动断开：HTTP/1.1 同源并发上限 6，SSE 占一条且跨标签页共享连接池
    // （同 ChatApp 的处理）。回前台再连，一连上就会收到全量状态，不会漏。
    const onVisibility = () => {
      if (document.hidden) {
        es?.close();
        es = null;
        setConn('reconnecting');
      } else if (!es) {
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      es?.close();
    };
  }, [code, applyView]);

  // 连接彻底断了：区分「房间过期」与「权限变了」，好给不同的出路
  useEffect(() => {
    if (conn !== 'dead' || !code) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/game/gomoku/rooms/${code}`);
        if (cancelled) return;
        if (res.status === 403) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          setError(data.message || '你现在无法进入这个房间');
        } else {
          setError('房间已失效（空闲超过 30 分钟会被回收）');
        }
      } catch {
        if (!cancelled) setError('连接已断开');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn, code]);

  // ── 派生状态 ──────────────────────────────────────────────────────────────
  const view = snapshot?.view ?? null;
  const you = snapshot?.you ?? { role: 'spectator' as RoomRole, seat: null as Seat | null };

  const mySeat: Seat | null = you.seat;
  const oppSeat: Seat | null = mySeat === 'black' ? 'white' : mySeat === 'white' ? 'black' : null;
  const opp = oppSeat && view ? view.seats[oppSeat] : null;
  const oppGone = !!opp && !opp.connected;

  // 对手掉线期间本地每秒 tick 一次，让「已掉线 N 秒」走起来
  useEffect(() => {
    if (!oppGone) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [oppGone]);

  const oppGoneMs = oppGone ? (opp?.disconnectedForMs ?? 0) + tick * 1000 : 0;
  const canClaim =
    view?.status === 'playing' && !!oppSeat && oppGoneMs >= CLAIM_AFTER_MS && conn === 'open';

  const isPlayer = you.role === 'player' && !!mySeat;
  const myTurn =
    isPlayer && view?.status === 'playing' && (view.turn === BLACK) === (mySeat === 'black');
  const canPlay = myTurn && conn === 'open';

  const onCellClick = useCallback(
    (row: number, col: number) => {
      if (!canPlay) return;
      void action('/moves', { row, col });
    },
    [canPlay, action]
  );

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败，请手动从地址栏复制');
    }
  }, []);

  const leave = useCallback(() => {
    setSnapshot(null);
    setConn('idle');
    setError(null);
    const url = new URL(window.location.href);
    url.searchParams.set('mode', 'online');
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  }, []);

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  // 还没进房：房间面板
  if (!snapshot || !view) {
    return (
      <div className="gomoku-container gomoku-room-panel">
        <h2 className="gomoku-room-panel__title">五子棋 · 联机对战</h2>
        <p className="gomoku-room-panel__desc">
          开一间房，把链接发给朋友；也可以输入对方给的房号加入。需要核心用户权限。
        </p>

        <button
          type="button"
          className="gomoku-btn gomoku-btn--primary"
          onClick={createRoom}
          disabled={busy}
        >
          创建房间
        </button>

        <div className="gomoku-room-panel__join">
          <input
            className="gomoku-room-panel__input"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void joinRoom(joinCode);
            }}
            placeholder="输入 6 位房号"
            maxLength={12}
            aria-label="房号"
          />
          <button
            type="button"
            className="gomoku-btn"
            onClick={() => void joinRoom(joinCode)}
            disabled={busy || !joinCode.trim()}
          >
            加入
          </button>
        </div>

        {error && <p className="gomoku-room-panel__error">{error}</p>}
      </div>
    );
  }

  const statusText = (() => {
    if (view.status === 'waiting') return '等待对手加入…';
    if (view.status === 'won') {
      if (!view.winner) return '对局结束';
      return isPlayer && view.winner === mySeat ? '你赢了！' : '你输了';
    }
    if (view.status === 'draw') return '平局！';
    if (!isPlayer) return '观战中';
    if (oppGone) return '对手已掉线';
    return myTurn ? '轮到你走' : '等对手落子…';
  })();

  return (
    <div className="gomoku-container gomoku-online">
      {conn !== 'open' && (
        <div className="gomoku-banner" role="status">
          {conn === 'dead' ? '连接已断开' : '连接中断，正在重连…'}
        </div>
      )}

      {/* 席位栏 */}
      <div className="gomoku-seats">
        <span className={`gomoku-seat gomoku-seat--black${view.turn === BLACK && view.status === 'playing' ? ' gomoku-seat--active' : ''}`}>
          <span className="gomoku-seat__stone" aria-hidden="true" />
          {view.seats.black?.name ?? '空位'}
          {view.seats.black && !view.seats.black.connected && '（掉线）'}
          {mySeat === 'black' && ' · 你'}
        </span>
        <span className={`gomoku-seat gomoku-seat--white${view.turn !== BLACK && view.status === 'playing' ? ' gomoku-seat--active' : ''}`}>
          <span className="gomoku-seat__stone" aria-hidden="true" />
          {view.seats.white?.name ?? '空位'}
          {view.seats.white && !view.seats.white.connected && '（掉线）'}
          {mySeat === 'white' && ' · 你'}
        </span>
        {view.spectatorCount > 0 && (
          <span className="gomoku-seat gomoku-seat--spec">围观 {view.spectatorCount}</span>
        )}
      </div>

      <div className="gomoku-status">{statusText}</div>

      {/* 房号 + 复制链接 */}
      <div className="gomoku-room-bar">
        <span className="gomoku-room-bar__code">房号 {view.code.toUpperCase()}</span>
        <button type="button" className="gomoku-btn gomoku-btn--small" onClick={copyLink}>
          {copied ? '已复制' : '复制邀请链接'}
        </button>
        <button type="button" className="gomoku-btn gomoku-btn--small" onClick={leave}>
          离开
        </button>
      </div>

      <GomokuCanvas
        grid={view.grid}
        lastMove={view.lastMove}
        winningLine={view.winningLine.length > 0 ? view.winningLine : null}
        version={view.revision}
        onCellClick={onCellClick}
        disabled={!canPlay}
      />

      {/* 控制 */}
      <div className="gomoku-controls">
        {view.status === 'playing' && isPlayer && (
          <button type="button" className="gomoku-btn" onClick={() => void action('/resign')}>
            认输
          </button>
        )}
        {view.status === 'playing' && oppSeat && oppGone && (
          <button
            type="button"
            className="gomoku-btn"
            onClick={() => void action('/claim')}
            disabled={!canClaim}
            title={canClaim ? '' : `对手掉线满 ${CLAIM_AFTER_MS / 1000} 秒后可判胜`}
          >
            {canClaim
              ? '判胜'
              : `判胜（${Math.max(0, Math.ceil((CLAIM_AFTER_MS - oppGoneMs) / 1000))}s）`}
          </button>
        )}
        {(view.status === 'won' || view.status === 'draw') && isPlayer && (
          <button
            type="button"
            className="gomoku-btn gomoku-btn--primary"
            onClick={() => void action('/rematch')}
          >
            {view.rematchVotes > 0 && view.rematchVotes < 2
              ? '已申请，等对手'
              : '再来一局（需双方同意）'}
          </button>
        )}
        {!isPlayer && (
          <span className="gomoku-hint">
            你在观战。两席坐满后加入的人自动成为观众。
          </span>
        )}
      </div>

      {error && <p className="gomoku-room-panel__error">{error}</p>}
    </div>
  );
}

/** 专注模式下的占位（页面层用它，避免进房面板闪一下）。 */
export function OnlineGomokuFocusLock() {
  return (
    <div className="gomoku-container">
      <div className="game-card game-card--locked game-card--focus-lock">
        <div className="game-card__body">
          <h3 className="game-card__title">已开启专注模式</h3>
          <p className="game-card__desc">
            联机对战是社交玩法，「玩具」暂不可用。可在设置中随时关闭专注模式。
          </p>
          <Link className="game-card__btn game-card__btn--link" href={FOCUS_MODE_SETTINGS_HREF}>
            前往设置关闭
          </Link>
        </div>
      </div>
    </div>
  );
}
