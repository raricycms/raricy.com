// ─────────────────────────────────────────────────────────────────────────────
// tictactoe-room.ts — 井字棋联机的房间层（薄封装 + 落子类适配器）
//
// 【实现全在 board-room.ts】与 gomoku-room.ts 是同一个门面换一张棋盘：房间生命周期
// （建房 / 入座 / 观战 / 掉线判胜 / 再来一局 / TTL 回收 / revision 语义）对所有
// 联机棋类都一样，改行为请去 board-room.ts。
//
// 【棋盘规则不在这里】胜负判定跑的是 tictactoe-rules.ts，前端与服务端共用同一份。
// 适配器只把统一棋路翻成落子接口，一行规则都不许有。
// ─────────────────────────────────────────────────────────────────────────────

import type { GameDefinition, RoomBoard } from './board-room';
import { TicTacToeBoard } from './tictactoe-rules';
import { makeRoomApi } from './board-room';
import type { Cell, Move, MoveInput, Outcome, Player } from './board-shared';

export type { RoomUser, RoomBoard, GameDefinition } from './board-room';
export type { RoomError, RoomResult } from './board-shared';
export { __constants, refreshPresence, sweepRooms } from './board-room';

/**
 * 把 TicTacToeBoard 接到房间层的统一棋盘接口上。
 *
 * 与五子棋那份是同一个形状：`path` 恒一格、`check` 恒 null、和棋只有"下满"。
 * 差别只在棋盘尺寸与胜型，而那两样都由 TicTacToeBoard 自己带着。
 */
class TicTacToeRoomBoard implements RoomBoard {
  private readonly inner = new TicTacToeBoard();

  get rows(): number {
    return this.inner.size;
  }

  get cols(): number {
    return this.inner.size;
  }

  get grid(): Cell[][] {
    return this.inner.grid;
  }

  reset(): void {
    this.inner.reset();
  }

  submit(player: Player, move: MoveInput): Outcome | null {
    if (move.path.length !== 1) return null;
    const [row, col] = move.path[0];

    if (!this.inner.placeStone(row, col, player)) return null;

    // 【顺序要紧】先判胜再判满。3×3 上"最后一手既连成三子又下满棋盘"是可能的
    // （第 9 手），反过来写就把它判成平局了。tests/service/tictactoe-room.test.ts
    // 有一条平局用例正好走满九手，顺序错了会先在那里暴露。
    const win = this.inner.checkWinAt(row, col, player);
    if (win.won) return { status: 'won', winner: player, highlight: win.line, reason: 'line' };
    if (this.inner.isFull()) return { status: 'draw', reason: 'board-full' };
    return { status: 'playing', check: null };
  }

  getLastMove(): Move | null {
    const last = this.inner.getLastMove();
    return last ? { path: [[last.row, last.col]], player: last.player } : null;
  }
}

/** 井字棋在房间层里的身份。3×3、三连即胜由 TicTacToeBoard 自己带着。 */
const TICTACTOE_GAME: GameDefinition = {
  kind: 'tictactoe',
  createBoard: () => new TicTacToeRoomBoard(),
};

// 编译期钉子：棋盘必须满足房间层要的那几个方法。五子棋靠「结构性匹配」直接
// 通过，井字棋这里显式钉一次 —— 少了哪个方法，改棋盘时立刻在这里报错，
// 而不是等到线上某个 API 500。
const _boardFitsRoom: () => RoomBoard = () => new TicTacToeRoomBoard();
void _boardFitsRoom;

const api = makeRoomApi(TICTACTOE_GAME);

/**
 * 整套房间函数，给 `api/game/_shared.ts` 的 handler 工厂用。
 * 路由文件因此只剩「import + 一行赋值」，40 个 route.ts 不会各自漂移。
 */
export const roomApi = api;

export const createRoom = api.createRoom;
export const joinRoom = api.joinRoom;
export const getSnapshot = api.getSnapshot;
export const playMove = api.playMove;
export const resign = api.resign;
export const claimAbandoned = api.claimAbandoned;
export const requestRematch = api.requestRematch;

/** 仅供测试：清空井字棋的房间（不动其它棋的）。 */
export const __resetTicTacToeRooms = api.__reset;
/** 仅供测试：当前井字棋房间数。 */
export const __roomCount = api.__roomCount;
