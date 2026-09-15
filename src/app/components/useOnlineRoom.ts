'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useOnlineRoom.ts — 联机棋类的房间客户端状态机（五子棋 / 井字棋共用）
//
// 【服务端权威】本 hook 不做任何规则判定：能不能走、走哪儿合法、谁赢了，全由
// 服务端说了算（见 lib/board-room.ts）。这里只做三件事：把服务端下发的 view 收进来、
// 把自己的动作 POST 上去、把实时帧应用进来。
//
// 【为什么是 SSE 不是 WebSocket】棋是回合制，走子间隔以秒计，单向下行完全够用；
// 而走子走 POST 白拿 CSRF 同源校验、限频与 session 鉴权。开 WS 要自定义 server，
// 会顶掉 next start 与 systemd unit。响应头那套坑全在 lib/sse.ts。
//
// 【revision 去重】走子的 POST 响应与 SSE 推的帧是同一份状态，谁先到不一定。
// 两者都过 applyView，按 revision 丢弃过期的 —— 不去重的话棋盘会闪回上一手。
//
// 【路径字面量必须留在各游戏的组件里】actions 里的 URL 是**写全的字面量**而不是
// 由 basePath 拼出来的：`scripts/check-links.mjs` 静态校验源码里的接口路径有没有
// 对应路由，而 `${basePath}/rooms/${code}/moves` 在它眼里是两段占位符连在一起，
// 校验不了 —— 路径写错一个字母就是线上 404，且 tsc 与单测都看不见。
// 所以本文件只提供机制，路径由每个游戏自己写全（见 OnlineGomoku / OnlineTicTacToe）。
//
// 【StrictMode】next.config 开了 reactStrictMode，dev 下 effect 双跑。
// 建房是按钮触发的（不会双跑），但带 ?room= 进来自动加入会 —— 用 joinedRef 闩住。
// 何况服务端 join 本身幂等，重连/刷新都靠它回到原座。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FIRST,
  undoPlies,
  type MoveInput,
  type RoomRole,
  type RoomSnapshot,
  type RoomStreamEvent,
  type RoomView,
  type Seat,
  type SpectatorView,
  type UndoRequest,
} from '@/lib/board-shared';

/** 对手掉线满这么久，本方可以判胜（与服务端 board-room 的 DISCONNECT_CLAIM_MS 一致）。 */
export const CLAIM_AFTER_MS = 60_000;

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';

/** 一个联机接口的返回：`message` 用于错误文案，`room` 是成功时的新状态。 */
export interface RoomPostResult {
  message?: string;
  room?: RoomSnapshot;
}

/**
 * 一种棋的接口地址与调用方式。
 *
 * **路径必须是写全的字面量**（理由见文件头）。整个对象在各游戏组件里定义在
 * **模块级**，因此引用恒定 —— 不必再包 useMemo。
 */
export interface RoomActions {
  create(): Promise<RoomPostResult>;
  /** 进房：落点永远是**观战台**，坐哪一席由 takeSeat 点名（见 board-room.ts）。 */
  join(code: string): Promise<RoomPostResult>;
  /** 坐上空着的一席。已经坐在另一席的人调它就是换先。 */
  takeSeat(code: string, seat: Seat): Promise<RoomPostResult>;
  /** 从席位退到观战台。 */
  leaveSeat(code: string): Promise<RoomPostResult>;
  /**
   * 走一手。棋路的形状见 `MoveInput`（board-shared.ts）：落子类棋 `path` 只有一格，
   * 走子类棋是起点→终点，连吃则更长。**整手一次提交**，没有半步状态。
   */
  move(code: string, move: MoveInput): Promise<RoomPostResult>;
  resign(code: string): Promise<RoomPostResult>;
  claim(code: string): Promise<RoomPostResult>;
  /** 请求悔棋；自己已经有一条待回应的请求时，同一个接口就是撤回。 */
  undo(code: string): Promise<RoomPostResult>;
  /** 回应对手的悔棋请求。 */
  undoRespond(code: string, accept: boolean): Promise<RoomPostResult>;
  rematch(code: string): Promise<RoomPostResult>;
  /** SSE 流地址。 */
  streamUrl(code: string): string;
  /** 快照地址：连接彻底断开时用来分辨「房间过期」与「权限变了」。 */
  snapshotUrl(code: string): string;
}

export interface OnlineRoomOptions {
  /**
   * 进房后写回 URL 的固定参数。五子棋必须带 `mode=online` —— 否则复制出去的
   * 邀请链接一刷新就掉回单机模式。井字棋只有一个模式，不传。
   */
  urlParams?: Record<string, string>;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '出错了，请重试';
}

/** POST 一个 JSON 接口，非 2xx 时把服务端的 message 抛成 Error。 */
export async function postJson(path: string, body?: unknown): Promise<RoomPostResult> {
  const res = await fetch(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as RoomPostResult;
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
  return data;
}

export interface OnlineRoom {
  snapshot: RoomSnapshot | null;
  view: RoomView | null;
  /** 我的 userId —— 大厅名单里标「· 你」用（名单里的 id 就是我）。 */
  myId: string | null;
  mySeat: Seat | null;
  oppSeat: Seat | null;
  /** 观战台名单。对局进行中服务端下发空数组（大厅的规矩是开局后隐藏观战台）。 */
  spectators: SpectatorView[];
  /** 已走步数（悔棋按钮据此判断撤不撤得动）。 */
  plyCount: number;
  /** 待回应的悔棋请求；没有则 null。 */
  undoRequest: UndoRequest | null;
  /** 「悔棋」按钮点不点得动（含"我发的请求可以撤回"那一档）。 */
  canRequestUndo: boolean;
  /** 我在这一局里是棋手（而非观众）。 */
  isPlayer: boolean;
  /** 轮到我走（服务端口径）。 */
  myTurn: boolean;
  /** 轮到我走 **且** 连接正常 —— 棋盘点得动的前提。 */
  canPlay: boolean;
  conn: ConnState;
  error: string | null;
  busy: boolean;
  copied: boolean;
  joinCode: string;
  setJoinCode: (v: string) => void;
  /** 对手当前是否掉线。与 oppGoneMs 分开给：刚掉线的那一瞬 oppGoneMs 还是 0。 */
  oppGone: boolean;
  /** 对手已掉线多久（ms）；对手在线时为 0。 */
  oppGoneMs: number;
  /** 对手掉线满 60 秒且连接正常 —— 可以点「判胜」。 */
  canClaim: boolean;
  createRoom: () => Promise<void>;
  joinRoom: (raw: string) => Promise<void>;
  takeSeat: (seat: Seat) => void;
  leaveSeat: () => void;
  playMove: (move: MoveInput) => void;
  resign: () => void;
  claim: () => void;
  requestUndo: () => void;
  respondUndo: (accept: boolean) => void;
  rematch: () => void;
  copyLink: () => Promise<void>;
  leave: () => void;
}

export function useOnlineRoom(
  actions: RoomActions,
  initialRoom: string | null = null,
  options: OnlineRoomOptions = {}
): OnlineRoom {
  const urlParams = options.urlParams;

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState(initialRoom ?? '');
  /** 对手掉线后的本地秒表（配合服务端给的 disconnectedForMs 一起算）。 */
  const [tick, setTick] = useState(0);

  // 事件回调里要读最新快照，用 ref 避开闭包过期
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  snapshotRef.current = snapshot;
  /** StrictMode 闩锁：带 ?room= 进来自动加入只做一次。 */
  const joinedRef = useRef(false);
  /** 自动坐回原席的在途闩（见 reclaimSeat）。 */
  const reclaimingRef = useRef(false);

  const code = snapshot?.view.code ?? null;

  /**
   * 应用一份服务端状态。POST 响应与 SSE 帧都走这里，按 revision 去重。
   *
   * `you` 是可选的第二份：**只有建流那一帧**与换座类接口的响应带它（见 board-shared.ts
   * 的 RoomStreamEvent）。它说的是「你是谁」，与局面的新旧无关 —— 所以 view 按 revision
   * 丢弃过期帧，`you` 一律照单全收。少了这一步，席位被释放过的人会一直以为自己还在座上。
   */
  const applyView = useCallback((view: RoomView, you?: RoomSnapshot['you']) => {
    setSnapshot((prev) => {
      if (!prev) return prev; // 还没 join（you 未知），忽略
      // 过期帧只丢 view：you 是身份，不跟着局面过期
      if (view.revision < prev.view.revision) return you ? { ...prev, you } : prev;
      return { view, you: you ?? prev.you };
    });
    setTick(0); // 新状态到了，本地秒表归零（disconnectedForMs 已是服务端最新值）
  }, []);

  /**
   * 重连后**自动坐回原来那一席**（只要还空着）。
   *
   * 【为什么需要】没在对局中时，一个人从席位上断开就等于把席位交出去了（见 board-room.ts
   * 的席位规则），而客户端的 SSE 在标签页切到后台时会主动断开（省连接）—— 没有这一步，
   * "切出去看一眼再回来"就变成"座位没了"。席位被别人抢先坐走时不抢（大厅里能看见是谁），
   * 失败也**不报错**：坐不回去不是错误，大厅里点一下「加入」就行。
   */
  const reclaimSeat = useCallback(
    async (seat: Seat) => {
      if (reclaimingRef.current) return; // 在途闩：建流帧之后紧跟的帧可能重复触发
      reclaimingRef.current = true;
      try {
        const current = snapshotRef.current;
        if (!current) return;
        const data = await actions.takeSeat(current.view.code, seat);
        if (data.room) applyView(data.room.view, data.room.you);
      } catch {
        /* 席位被占了 / 被限频挡了：留在观战台，大厅里手点「加入」 */
      } finally {
        reclaimingRef.current = false;
      }
    },
    [actions, applyView]
  );

  /** 把房号写回地址栏（可分享 / 可收藏 / 刷新回到原局）。 */
  const writeUrl = useCallback(
    (roomCode: string | null) => {
      const url = new URL(window.location.href);
      for (const [k, v] of Object.entries(urlParams ?? {})) url.searchParams.set(k, v);
      if (roomCode) url.searchParams.set('room', roomCode);
      else url.searchParams.delete('room');
      // replaceState 而非 router.push：URL 只是应用状态自己的镜像，不该触发一次 RSC 往返
      window.history.replaceState({}, '', url.toString());
    },
    [urlParams]
  );

  /** 进入房间：记录快照、把房号写回 URL。 */
  const enterRoom = useCallback(
    (room: RoomSnapshot) => {
      setSnapshot(room);
      setError(null);
      setConn('connecting');
      writeUrl(room.view.code);
    },
    [writeUrl]
  );

  const createRoom = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await actions.create();
      if (data.room) enterRoom(data.room);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [actions, enterRoom]);

  const joinRoom = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      setBusy(true);
      setError(null);
      try {
        const data = await actions.join(value);
        if (data.room) enterRoom(data.room);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [actions, enterRoom]
  );

  /**
   * 走子 / 认输 / 判胜 / 换座 / 悔棋 / 再来一局 —— 都是 POST 一个动作，拿回新状态。
   * 响应里的 `you` 一并应用：换座类接口会改身份（坐上空席、退到观战台都是）。
   */
  const run = useCallback(
    async (fn: (code: string) => Promise<RoomPostResult>) => {
      const current = snapshotRef.current;
      if (!current) return;
      setError(null);
      try {
        const data = await fn(current.view.code);
        if (data.room) applyView(data.room.view, data.room.you);
      } catch (e) {
        setError(errText(e));
      }
    },
    [applyView]
  );

  const playMove = useCallback(
    (move: MoveInput) => {
      void run((c) => actions.move(c, move));
    },
    [run, actions]
  );

  const takeSeat = useCallback(
    (seat: Seat) => {
      void run((c) => actions.takeSeat(c, seat));
    },
    [run, actions]
  );

  const leaveSeat = useCallback(() => {
    void run((c) => actions.leaveSeat(c));
  }, [run, actions]);

  const resign = useCallback(() => {
    void run((c) => actions.resign(c));
  }, [run, actions]);

  const claim = useCallback(() => {
    void run((c) => actions.claim(c));
  }, [run, actions]);

  const requestUndo = useCallback(() => {
    void run((c) => actions.undo(c));
  }, [run, actions]);

  const respondUndo = useCallback(
    (accept: boolean) => {
      void run((c) => actions.undoRespond(c, accept));
    },
    [run, actions]
  );

  const rematch = useCallback(() => {
    void run((c) => actions.rematch(c));
  }, [run, actions]);

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
      es = new EventSource(actions.streamUrl(code));

      es.onopen = () => setConn('open');
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as RoomStreamEvent;
          if (event.type !== 'state') return;

          // 建流那一帧带 `you`（见 board-shared.ts）：它可能告诉我「你已经不在座位上了」——
          // 没在对局中时断开过 SSE 就会被释放席位。原来那一席还空着就自动坐回去。
          // 在被坐走的情况下不动手：大厅里能看见是谁坐了，硬抢才是错的。
          const prev = snapshotRef.current;
          const prevSeat = prev?.you.role === 'player' ? prev.you.seat : null;
          if (
            prevSeat !== null &&
            event.you?.role === 'spectator' &&
            event.view.status !== 'playing' &&
            event.view.seats[prevSeat] === null
          ) {
            void reclaimSeat(prevSeat);
          }

          applyView(event.view, event.you);
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
  }, [code, applyView, reclaimSeat, actions]);

  // 连接彻底断了：区分「房间过期」与「权限变了」，好给不同的出路
  useEffect(() => {
    if (conn !== 'dead' || !code) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(actions.snapshotUrl(code));
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
  }, [conn, code, actions]);

  // ── 派生状态 ──────────────────────────────────────────────────────────────
  const view = snapshot?.view ?? null;
  const you: RoomSnapshot['you'] = snapshot?.you ?? {
    id: '',
    role: 'spectator' as RoomRole,
    seat: null as Seat | null,
  };

  const myId = you.id || null;
  const mySeat: Seat | null = you.seat;
  const oppSeat: Seat | null =
    mySeat === 'black' ? 'white' : mySeat === 'white' ? 'black' : null;
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
  // 先手 = 黑席。房间层保证 turn 的取值与席位一一对应（1 → black）。
  const myTurn =
    isPlayer && view?.status === 'playing' && (view.turn === FIRST) === (mySeat === 'black');
  const canPlay = myTurn && conn === 'open';

  // 观战台名单与悔棋状态。对局进行中服务端不下发名单（大厅规矩），所以恒为空数组。
  const spectators = view?.spectators ?? [];
  const plyCount = view?.plyCount ?? 0;
  const undoRequest = view?.undoRequest ?? null;

  // 撤几步算得出「撤到轮到我走」：与**服务端同一份** undoPlies（协议层导出）——
  // 客户端各算一遍的表现是按钮亮着却报「没有可撤的棋」。
  const canRequestUndo =
    view?.status === 'playing' &&
    isPlayer &&
    mySeat !== null &&
    conn === 'open' &&
    // 自己那条待回应的请求要放行：那个按钮此刻是「撤回」
    (undoRequest === null || undoRequest.by === mySeat) &&
    plyCount >= undoPlies(view.turn, mySeat);

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
    writeUrl(null);
  }, [writeUrl]);

  return {
    snapshot,
    view,
    myId,
    mySeat,
    oppSeat,
    spectators,
    plyCount,
    undoRequest,
    canRequestUndo,
    isPlayer,
    myTurn,
    canPlay,
    conn,
    error,
    busy,
    copied,
    joinCode,
    setJoinCode,
    oppGone,
    oppGoneMs,
    canClaim,
    createRoom,
    joinRoom,
    takeSeat,
    leaveSeat,
    playMove,
    resign,
    claim,
    requestUndo,
    respondUndo,
    rematch,
    copyLink,
    leave,
  };
}
