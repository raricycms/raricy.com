// ─────────────────────────────────────────────────────────────────────────────
// gomoku-room.ts — 五子棋联机的房间层（薄封装 + 落子类适配器）
//
// 【实现全在 board-room.ts】房间的开/关、席位、观战、掉线判胜、TTL 回收、
// revision 语义对**所有**联机棋类都一样，所以只写一份；本文件只负责把五子棋的
// 棋盘（GomokuBoard）绑上去，并保留原有一套对外名字，免得七条路由与测试全改一遍。
//
// 【想改房间行为？改 board-room.ts】别在这里加逻辑 —— 另外四款棋走的是同一份代码，
// 在这里加一分歧，其它游戏就静默地少了那个行为。同理，各款的差异只允许是
// 「换了张棋盘 + 换了套判终局」，多出来的任何一行都该先问一句「这是棋类共性吗」。
//
// 【适配器只做翻译，不做规则】下面的 GomokuRoomBoard 把房间层的统一棋路
// （`MoveInput.path`）翻成 GomokuBoard 的落子接口，胜负仍然完全由 gomoku-rules
// 判定 —— 这里**一行规则都不许有**，否则前端单机与服务端就会跑出两份判定。
//
// 【棋盘规则不在这里】见 gomoku-rules.ts，前端与服务端共用同一份。
// ─────────────────────────────────────────────────────────────────────────────

import type { GameDefinition, RoomBoard } from './board-room';
import { GomokuBoard } from './gomoku-rules';
import { makeRoomApi } from './board-room';
import type { Cell, Move, MoveInput, Outcome, Player } from './board-shared';

export type { RoomUser, RoomBoard, GameDefinition } from './board-room';
export type { RoomError, RoomResult } from './board-shared';
export { __constants, refreshPresence, sweepRooms } from './board-room';

/**
 * 把 GomokuBoard 接到房间层的统一棋盘接口上。
 *
 * 【落子类棋的特征】`path` 恒为一格（没有起点），`check` 恒为 null（没有"将军"），
 * 和棋只有"下满"一种。这三条正是它与走子类棋的全部差别。
 */
class GomokuRoomBoard implements RoomBoard {
  private readonly inner = new GomokuBoard();

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
    // 落子类棋没有"从哪走到哪"：多过一格的路径不是这个棋的着法。
    // （房间层已挡住非整数坐标，这里判的是"这一手像不像落子"。）
    if (move.path.length !== 1) return null;
    const [row, col] = move.path[0];

    // placeStone 内部会先判空位与越界，不合法直接返回 false 且**不改棋盘**。
    if (!this.inner.placeStone(row, col, player)) return null;

    // 【顺序要紧】**先判胜再判满**：第 225 手既连成五子又填满棋盘时，
    // 那是赢棋不是和棋。反过来写会把这一手判成平局 —— 玩家看得见，测试却未必有。
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

/** 五子棋在房间层里的身份。15×15、五连（长连也算）由 GomokuBoard 自己带着。 */
const GOMOKU_GAME: GameDefinition = {
  kind: 'gomoku',
  createBoard: () => new GomokuRoomBoard(),
};

// 编译期钉子：适配器必须满足房间层要的那几个成员。少了哪个，改棋盘时立刻在这里
// 报错，而不是等到线上某个 API 500。
const _boardFitsRoom: () => RoomBoard = () => new GomokuRoomBoard();
void _boardFitsRoom;

const api = makeRoomApi(GOMOKU_GAME);

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

/** 仅供测试：清空五子棋的房间（不动其它棋的）。 */
export const __resetGomokuRooms = api.__reset;
/** 仅供测试：当前五子棋房间数。 */
export const __roomCount = api.__roomCount;
