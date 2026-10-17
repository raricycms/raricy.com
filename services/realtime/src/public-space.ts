import { performance } from 'node:perf_hooks';
import { PUBLIC_SPACE_HEARTBEAT_MS, PUBLIC_SPACE_TIMEOUT_MS, PUBLIC_SPACE_MAX_USERS,
  parsePublicSpaceCommand, type PublicSpaceUser } from '../../../shared/public-space/protocol.js';
import type { RealtimeGame, RealtimePeer } from './game.js';
import type { TicketAuthority } from './site-auth.js';

export function createPublicSpaceGame(authority: TicketAuthority): RealtimeGame {
  const users = new Map<string, PublicSpaceUser>();
  const connections = new Map<string, { peer: RealtimePeer; lastSeen: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  function broadcast() {
    const packet = JSON.stringify({ type: 'public-space.snapshot', users: [...users.values()] });
    for (const { peer } of connections.values()) peer.send(packet);
  }
  function remove(id: string) {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    const userId = connection.peer.identity.userId;
    // 同账号多标签共享一个位置；仅最后一条连接离开时释放。
    if (![...connections.values()].some(({ peer }) => peer.identity.userId === userId)) users.delete(userId);
    if (!connections.size) { clearInterval(timer); timer = undefined; }
    broadcast();
  }
  return {
    id: 'public-space',
    authenticate: (input) => authority.consume(input),
    revalidate: ({ identity, signal }) => authority.validate({ gameId: 'public-space', identity, signal }),
    connect(peer) {
      const userId = peer.identity.userId;
      if (!users.has(userId) && users.size >= PUBLIC_SPACE_MAX_USERS) {
        peer.send(JSON.stringify({ type: 'public-space.full' }));
        peer.disconnect();
        return { receive() {}, close() {} };
      }
      if (!users.has(userId)) users.set(userId, { userId, name: peer.identity.username,
        frameUrl: peer.identity.frameUrl ?? null, cell: null });
      const connection = { peer, lastSeen: performance.now() };
      connections.set(peer.id, connection);
      if (!timer) {
        timer = setInterval(() => {
          const now = performance.now();
          for (const [id, state] of connections) {
            if (now - state.lastSeen >= PUBLIC_SPACE_TIMEOUT_MS) { remove(id); state.peer.disconnect(); }
          }
        }, PUBLIC_SPACE_HEARTBEAT_MS);
        timer.unref();
      }
      broadcast();
      return {
        receive(message) {
          if (!connections.has(peer.id)) return;
          let value: unknown;
          try { value = message.binary ? null : JSON.parse(message.data); } catch { value = null; }
          const command = parsePublicSpaceCommand(value);
          if (!command) { peer.disconnect(); return; }
          connection.lastSeen = performance.now();
          if (command.type === 'public-space.ping') {
            peer.send(JSON.stringify({ type: 'public-space.pong' }));
            return;
          }
          if (command.cell !== null && [...users.values()].some((user) => user.userId !== userId && user.cell === command.cell)) {
            peer.send(JSON.stringify({ type: 'public-space.occupied' }));
            return;
          }
          // 检查占位与移动同步完成，两个连接争抢同一格只会有一个成功。
          users.get(userId)!.cell = command.cell;
          broadcast();
        },
        close() { remove(peer.id); },
      };
    },
  };
}
