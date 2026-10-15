import type { RealtimeGame } from './game.js';

// ATÅMAS 是纯客户端游戏，不登记到这里。Wand 实现身份票据消费与玩法后再显式注册。
// 空清单只开放健康检查，任何 /realtime/<gameId> 升级请求都返回 404。
export const realtimeGames: readonly RealtimeGame[] = [];
