// ─────────────────────────────────────────────────────────────────────────────
// gomoku-shared.ts — 五子棋联机的 DTO、SSE 事件与房间码规范化（前后端共享）
//
// 【零依赖】与 gomoku-rules.ts 一样，不得 import prisma / next/headers / server-only
// —— 客户端组件要直接引用这里的类型与 normalizeRoomCode。
//
// 【协议：每次变化都推全量状态】棋盘只有 15×15 = 225 格（约 1KB JSON），而一局
// 走子间隔以秒计。全量推送换来的是**没有增量协议的那一整类 bug**：漏推、乱序、
// 断线后增量对不上。断线重连也不需要 Last-Event-ID 补齐 —— SSE 一连上服务端就
// 推一次当前状态，客户端按 revision 丢弃过期的即可。
// 因此这里没有 delta 事件、没有环形缓冲、没有 resync。
// ─────────────────────────────────────────────────────────────────────────────

import type { Cell, Move, Player } from './gomoku-rules';

/** 房间码长度。 */
export const ROOM_CODE_LENGTH = 6;

/**
 * 房间码字母表：31 个字符，剔掉 0/o/1/l/i —— 房号要靠人念、手抄、发消息，
 * 这五个字符是抄错的主要来源。约 8.9e8 种组合。
 * 展示用大写，存储与 URL 一律小写（normalizeRoomCode 归一小写）。
 */
export const ROOM_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export type Seat = 'black' | 'white';
export type RoomStatus = 'waiting' | 'playing' | 'won' | 'draw';
export type RoomRole = 'player' | 'spectator';

/**
 * 把用户输入/URL 参数规范化成房间码；非法返回 null。
 * 容忍用户抄成大写、带空格或连字符、粘贴时带上首尾空白。
 */
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleaned.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ROOM_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** 席位在快照里的公开信息 —— **绝不含 userId**。 */
export interface SeatView {
  name: string;
  connected: boolean;
  /**
   * 已掉线多久（ms）；在线时为 null。
   * **由服务端算**（now - disconnectedAt）而不是让客户端拿时间戳自己减：
   * 客户端的钟可能偏，而且刷新页面后光有 connected 是推不出「等了多久」的 ——
   * 那会让判胜按钮永远不出现。客户端收到后按本地计时继续累加。
   */
  disconnectedForMs: number | null;
}

/**
 * 房间的公开状态。同一房间里所有连接收到的都是这一份（走子是公开信息），
 * 因此**不含「你是谁」** —— 角色由 join / 快照接口单独返回（见 GomokuRoomSnapshot）。
 */
export interface GomokuRoomView {
  code: string;
  status: RoomStatus;
  /** 轮到谁走。终局时无意义。 */
  turn: Player;
  winner: Seat | null;
  winningLine: Array<[number, number]>;
  /** 服务端权威棋盘。客户端只渲染，不据此判定。 */
  grid: Cell[][];
  lastMove: Move | null;
  seats: { black: SeatView | null; white: SeatView | null };
  spectatorCount: number;
  /** 已经点了「再来一局」的人数（满 2 即重开）。 */
  rematchVotes: number;
  /** 单调递增，永不重置（含再来一局）。客户端据此丢弃过期的全量状态。 */
  revision: number;
  /** 服务端此刻的时间（ms），供客户端算「对手掉线多久了」。 */
  now: number;
}

/** join / 快照接口的返回：公开状态 + 「你是谁」。 */
export interface GomokuRoomSnapshot {
  view: GomokuRoomView;
  you: { role: RoomRole; seat: Seat | null };
}

/** SSE 事件。只有全量状态一种，理由见文件头。 */
export type GomokuStreamEvent = { type: 'state'; view: GomokuRoomView };
