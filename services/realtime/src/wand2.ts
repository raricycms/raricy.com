import { performance } from 'node:perf_hooks';
import { INPUT, MAX_PLAYERS, TICK_MS, decodeInput } from '../../../shared/wand2/protocol.js';
import { Meadow } from '../../../shared/wand2/world.js';
import type { RealtimeGame, RealtimePeer } from './game.js';
import type { TicketAuthority } from './site-auth.js';

export function createWand2Game(authority: TicketAuthority): RealtimeGame {
  const world = new Meadow();
  const peers = new Map<string, { peer: RealtimePeer; sequence: number; lastInput: number }>();
  let timer: ReturnType<typeof setInterval> | undefined, previous = 0;
  function broadcast() { const packet = JSON.stringify(world.snapshot()); for (const { peer } of peers.values()) peer.send(packet); }
  function tick() {
    const now = performance.now();
    for (const [id, state] of peers) if (now - state.lastInput > 250) { const p = world.players.get(id)!; p.buttons = 0; p.queuedAttack = false; }
    world.step(now - previous); previous = now; broadcast();
  }
  return {
    id: 'wand2', authenticate: input => authority.consume(input),
    revalidate: ({ identity, signal }) => authority.validate({ gameId: 'wand2', identity, signal }),
    connect(peer) {
      if (peers.size >= MAX_PLAYERS) { peer.send(JSON.stringify({ type: 'wand2.full' })); peer.disconnect(); return { receive() {}, close() {} }; }
      const state = { peer, sequence: -1, lastInput: performance.now() };
      peers.set(peer.id, state); world.join(peer.id, peer.identity.userId, peer.identity.username);
      if (!timer) { previous = performance.now(); timer = setInterval(tick, TICK_MS); timer.unref(); }
      broadcast();
      return {
        receive(message) {
          const input = message.binary ? decodeInput(message.data) : null;
          if (!input) { peer.disconnect(); return; }
          const diff = (input.sequence - state.sequence + 65536) % 65536;
          if (state.sequence >= 0 && (diff === 0 || diff > 32767)) return;
          state.sequence = input.sequence; state.lastInput = performance.now();
          const player = world.players.get(peer.id);
          if (player) {
            // 轻点可能在一个 tick 内完成按下和松开，保留攻击上升沿，避免触屏漏剑。
            player.queuedAttack ||= !!(input.buttons & INPUT.attack) && !(player.buttons & INPUT.attack);
            player.buttons = input.buttons;
          }
        },
        close() { peers.delete(peer.id); world.leave(peer.id); if (!peers.size) { clearInterval(timer); timer = undefined; } else broadcast(); },
      };
    },
  };
}
