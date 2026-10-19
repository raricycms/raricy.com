import type { RealtimeGame } from './game.js';
import { createWandGame } from './wand.js';
import { createWand2Game } from './wand2.js';
import { createPublicSpaceGame } from './public-space.js';
import { createQuandiGame } from './quandi.js';
import type { TicketAuthority } from './site-auth.js';

// ATÅMAS 是纯客户端游戏，不登记到实时服务。
export function createRealtimeGames(authority: TicketAuthority): readonly RealtimeGame[] {
  return [createWandGame(authority), createWand2Game(authority), createPublicSpaceGame(authority), createQuandiGame(authority)];
}
