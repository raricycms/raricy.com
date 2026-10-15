import { performance } from 'node:perf_hooks';
import { WAND_MAX_PLAYERS, WAND_TICK_MS, decodeWandInput, type WandPlayer } from '../../../shared/wand/protocol.js';
import { stepWandPosition } from '../../../shared/wand/physics.js';
import type { RealtimeGame, RealtimePeer } from './game.js';
import type { TicketAuthority } from './site-auth.js';

interface PlayerState { peer: RealtimePeer; player: WandPlayer; buttons: number; sequence: number; lastInput: number }

export function createWandGame(authority: TicketAuthority): RealtimeGame {
  const players = new Map<string, PlayerState>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousTick = performance.now();
  function snapshot() {
    return JSON.stringify({ type: 'wand.snapshot', players: [...players.values()].map(({ player }) => ({
      ...player, x: Math.round(player.x * 100) / 100, y: Math.round(player.y * 100) / 100,
    })) });
  }
  function broadcast() {
    const packet = snapshot();
    for (const { peer } of players.values()) peer.send(packet);
  }
  function tick() {
    const now = performance.now();
    const dt = (now - previousTick) / 1000;
    previousTick = now;
    for (const state of players.values()) {
      const buttons = now - state.lastInput <= 250 ? state.buttons : 0;
      Object.assign(state.player, stepWandPosition(state.player, buttons, dt));
    }
    broadcast();
  }
  return {
    id: 'wand',
    authenticate: (input) => authority.consume(input),
    revalidate: ({ identity, signal }) => authority.validate({ gameId: 'wand', identity, signal }),
    connect(peer) {
      if (players.size >= WAND_MAX_PLAYERS) {
        peer.send(JSON.stringify({ type: 'wand.full' }));
        peer.disconnect();
        return { receive() {}, close() {} };
      }
      const state: PlayerState = {
        peer, player: { id: peer.id, name: peer.identity.username.slice(0, 32), x: 50, y: 50 },
        buttons: 0, sequence: -1, lastInput: performance.now(),
      };
      players.set(peer.id, state);
      if (!timer) {
        previousTick = performance.now();
        timer = setInterval(tick, WAND_TICK_MS);
        timer.unref();
      }
      broadcast();
      return {
        receive(message) {
          const input = message.binary ? decodeWandInput(message.data) : null;
          if (!input) { peer.disconnect(); return; }
          const difference = (input.sequence - state.sequence + 65536) % 65536;
          if (state.sequence >= 0 && (difference === 0 || difference > 32767)) return;
          state.sequence = input.sequence;
          state.buttons = input.buttons;
          state.lastInput = performance.now();
        },
        close() {
          players.delete(peer.id);
          if (!players.size) { clearInterval(timer); timer = undefined; }
          else broadcast();
        },
      };
    },
  };
}
