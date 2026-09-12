// ─────────────────────────────────────────────────────────────────────────────
// gomoku-room.ts — 五子棋联机的房间层（薄封装）
//
// 【实现全在 board-room.ts】房间的开/关、席位、观战、掉线判胜、TTL 回收、
// revision 语义对**所有**联机棋类都一样，所以只写一份；本文件只负责把五子棋的
// 棋盘（GomokuBoard）绑上去，并保留原有一套对外名字，免得七条路由与测试全改一遍。
//
// 【想改房间行为？改 board-room.ts】别在这里加逻辑 —— 井字棋走的是同一份代码，
// 在这里加一分歧，另一个游戏就静默地少了那个行为。同理，两边的差异只允许是
// 「换了张棋盘」，多出来的任何一行都该先问一句「这是棋类共性吗」。
//
// 【棋盘规则不在这里】胜负判定跑的是 gomoku-rules.ts，前端与服务端共用同一份。
// ─────────────────────────────────────────────────────────────────────────────

import type { GameDefinition } from './board-room';
import { GomokuBoard } from './gomoku-rules';
import { makeRoomApi } from './board-room';

export type { RoomUser, RoomBoard, GameDefinition } from './board-room';
export type { RoomError, RoomResult } from './board-shared';
export { __constants, refreshPresence, sweepRooms } from './board-room';

/** 五子棋在房间层里的身份。15×15、五连（长连也算）由 GomokuBoard 自己带着。 */
const GOMOKU_GAME: GameDefinition = {
  kind: 'gomoku',
  createBoard: () => new GomokuBoard(),
};

const api = makeRoomApi(GOMOKU_GAME);

export const createRoom = api.createRoom;
export const joinRoom = api.joinRoom;
export const getSnapshot = api.getSnapshot;
export const playMove = api.playMove;
export const resign = api.resign;
export const claimAbandoned = api.claimAbandoned;
export const requestRematch = api.requestRematch;

/** 仅供测试：清空五子棋的房间（不动井字棋的）。 */
export const __resetGomokuRooms = api.__reset;
/** 仅供测试：当前五子棋房间数。 */
export const __roomCount = api.__roomCount;
