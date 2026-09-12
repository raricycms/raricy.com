// ─────────────────────────────────────────────────────────────────────────────
// tictactoe-room.ts — 井字棋联机的房间层（薄封装）
//
// 【实现全在 board-room.ts】与 gomoku-room.ts 是同一个门面换一张棋盘：房间生命周期
// （建房 / 入座 / 观战 / 掉线判胜 / 再来一局 / TTL 回收 / revision 语义）对所有
// 联机棋类都一样，改行为请去 board-room.ts。
//
// 【棋盘规则不在这里】胜负判定跑的是 tictactoe-rules.ts，前端与服务端共用同一份。
// ─────────────────────────────────────────────────────────────────────────────

import type { GameDefinition, RoomBoard } from './board-room';
import { TicTacToeBoard } from './tictactoe-rules';
import { makeRoomApi } from './board-room';

export type { RoomUser, RoomBoard, GameDefinition } from './board-room';
export type { RoomError, RoomResult } from './board-shared';
export { __constants, refreshPresence, sweepRooms } from './board-room';

/** 井字棋在房间层里的身份。3×3、三连即胜由 TicTacToeBoard 自己带着。 */
const TICTACTOE_GAME: GameDefinition = {
  kind: 'tictactoe',
  createBoard: () => new TicTacToeBoard(),
};

// 编译期钉子：棋盘必须满足房间层要的那几个方法。五子棋靠「结构性匹配」直接
// 通过，井字棋这里显式钉一次 —— 少了哪个方法，改棋盘时立刻在这里报错，
// 而不是等到线上某个 API 500。
const _boardFitsRoom: () => RoomBoard = () => new TicTacToeBoard();
void _boardFitsRoom;

const api = makeRoomApi(TICTACTOE_GAME);

export const createRoom = api.createRoom;
export const joinRoom = api.joinRoom;
export const getSnapshot = api.getSnapshot;
export const playMove = api.playMove;
export const resign = api.resign;
export const claimAbandoned = api.claimAbandoned;
export const requestRematch = api.requestRematch;

/** 仅供测试：清空井字棋的房间（不动五子棋的）。 */
export const __resetTicTacToeRooms = api.__reset;
/** 仅供测试：当前井字棋房间数。 */
export const __roomCount = api.__roomCount;
