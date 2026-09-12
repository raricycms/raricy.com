// ─────────────────────────────────────────────────────────────────────────────
// chess-room.ts — 国际象棋联机的房间层（薄封装）
//
// 【实现全在 board-room.ts】房间的开/关、席位、观战、掉线判胜、TTL 回收、revision
// 语义对**所有**联机棋类都一样，所以只写一份；本文件只负责把 国际象棋的棋盘
// （ChessBoard）绑上去。
//
// 【想改房间行为？改 board-room.ts】别在这里加逻辑 —— 另外四款棋走的是同一份代码，
// 在这里加一分歧，其它游戏就静默地少了那个行为。
//
// 【走子类棋不需要适配器】ChessBoard 本身就满足 RoomBoard（rows / cols / grid /
// reset / submit / getLastMove），所以这里直接把它交给 makeRoomApi 就行。
// 落子类棋（五子棋 / 井字棋）才需要一层适配器把"落一格"翻成 submit —— 那是
// 它们与这里的唯一差别。
// 【席位与颜色的映射】房间层的席位 id 是 `black`/`white`，那是"第几个座位"不是
// 棋子颜色。国际象棋**白先**，所以 `black` 席执白、`white` 席执黑 —— 与五子棋
// 恰好一致，但别把它当成通则（象棋就反过来）。
//
// 【棋盘规则不在这里】见 chess-rules.ts，前端与服务端共用同一份。
// ─────────────────────────────────────────────────────────────────────────────

import type { GameDefinition, RoomBoard } from './board-room';
import { ChessBoard } from './chess-rules';
import { makeRoomApi } from './board-room';

export type { RoomUser, RoomBoard, GameDefinition } from './board-room';
export type { RoomError, RoomResult } from './board-shared';
export { __constants, refreshPresence, sweepRooms } from './board-room';

/** 国际象棋在房间层里的身份。8×8、白先、王车易位与吃过路兵由 ChessBoard 自己带着。 */
const GAME: GameDefinition = {
  kind: 'chess',
  // 再来一局走的也是它：换一张全新棋盘，比 board.reset() 少一整类"漏清某个字段"的
  // 错误（走子类棋的"开局"还包括易位权利 / 过路兵目标格 / 重复局面历史）。
  createBoard: () => new ChessBoard(),
};

// 编译期钉子：棋盘必须满足房间层要的那几个成员。走子类棋靠结构匹配直接通过，
// 这里显式钉一次 —— 改棋盘签名时立刻在此报错，而不是等到线上某个 API 500。
const _boardFitsRoom: () => RoomBoard = () => new ChessBoard();
void _boardFitsRoom;

const api = makeRoomApi(GAME);

/**
// 整套房间函数，给 `api/game/_shared.ts` 的 handler 工厂用。
// 路由文件因此只剩「import + 一行赋值」，不会各自漂移。
 */
export const roomApi = api;

export const createRoom = api.createRoom;
export const joinRoom = api.joinRoom;
export const getSnapshot = api.getSnapshot;
export const playMove = api.playMove;
export const resign = api.resign;
export const claimAbandoned = api.claimAbandoned;
export const requestRematch = api.requestRematch;

/** 仅供测试：清空国际象棋的房间（不动其它棋的）。 */
export const __resetChessRooms = api.__reset;
/** 仅供测试：当前国际象棋房间数。 */
export const __roomCount = api.__roomCount;
