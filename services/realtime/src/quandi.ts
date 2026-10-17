import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RealtimeGame, RealtimePeer } from './game.js';
import type { TicketAuthority } from './site-auth.js';
import ServerEngine from './quandi-engine/ServerEngine.js';
import {
  parseQuandiCommand, QUANDI_MAX_PLAYERS, QUANDI_MAX_ROOMS, QUANDI_ROOM_IDLE_MS, QUANDI_ROUND_MAX_MS,
  type QuandiCommand, type QuandiMode, type QuandiDifficulty,
} from '../../../shared/quandi/protocol.js';

interface Member { peer: RealtimePeer; room: Room | null; ready: boolean; sequence: number; actions: number; actionWindow: number; lastSeen: number }
interface Room {
  roomId: string; roomCode: string; hostPlayerId: string;
  gameConfig: { mode: QuandiMode; difficulty: QuandiDifficulty };
  members: Member[]; engine: ServerEngine | null; updatedAt: number; startedAt: number;
}
const COLORS = ['#E6194B', '#0047AB'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SNAPSHOT_BYTES = 192 * 1024;

export function createQuandiGame(authority: TicketAuthority): RealtimeGame {
  const members = new Map<string, Member>();
  const accounts = new Set<string>();
  const rooms = new Map<string, Room>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const send = (member: Member, type: string, data: unknown) => member.peer.send(JSON.stringify({ type, data }));
  const error = (member: Member, code: string, message: string) => send(member, 'S2C_ERROR', { code, message });
  function players(room: Room) {
    return room.members.map((member, slotIndex) => ({
      playerId: member.peer.id, name: member.peer.identity.username, color: COLORS[slotIndex], slotIndex,
      isReady: member.ready, isHost: member.peer.id === room.hostPlayerId, isConnected: true,
    }));
  }
  function broadcast(room: Room, type: string, data: unknown) {
    const packet = JSON.stringify({ type, data });
    if (Buffer.byteLength(packet) > MAX_SNAPSHOT_BYTES) { abort(room); return; }
    for (const member of room.members) member.peer.send(packet);
  }
  function update(room: Room) {
    broadcast(room, 'S2C_ROOM_UPDATE', { room: {
      roomId: room.roomId, roomCode: room.roomCode, hostPlayerId: room.hostPlayerId,
      gameConfig: room.gameConfig, maxPlayers: 2, state: room.engine ? 'playing' : 'waiting', players: players(room),
    } });
  }
  function removeRoom(room: Room) {
    room.engine?.stop(); room.engine = null;
    rooms.delete(room.roomCode);
    for (const member of room.members) { member.room = null; member.ready = false; }
    room.members = [];
  }
  function abort(room: Room) {
    for (const member of room.members) {
      error(member, 'ROUND_CLOSED', '本局已关闭，请重新创建或加入房间。');
      send(member, 'S2C_ROOM_LEFT', {});
    }
    removeRoom(room);
  }
  function leave(member: Member) {
    const room = member.room;
    if (!room) return;
    room.engine?.forfeitPlayer(member.peer.id);
    room.engine?.stop(); room.engine = null;
    member.room = null; member.ready = false;
    room.members = room.members.filter((entry) => entry !== member);
    for (const remaining of room.members) remaining.ready = false;
    if (!room.members.length) removeRoom(room);
    else { room.hostPlayerId = room.members[0].peer.id; room.updatedAt = performance.now(); update(room); }
  }
  function run(room: Room) {
    const engine = new ServerEngine({ gameConfig: room.gameConfig, getPlayers: () => players(room) });
    room.engine = engine; room.startedAt = performance.now(); room.updatedAt = room.startedAt;
    for (const member of room.members) member.sequence = 0;
    broadcast(room, 'S2C_GAME_START', {
      countdown: 3, gameConfig: room.gameConfig,
      players: players(room).map((player) => ({ ...player, id: player.playerId })),
    });
    engine.start(
      (state: unknown) => { if (room.engine === engine) broadcast(room, 'S2C_GAME_STATE', state); },
      (event: unknown) => broadcast(room, 'S2C_GAME_EVENT', event),
      (result: unknown) => {
        if (room.engine !== engine) return;
        room.engine = null; room.updatedAt = performance.now();
        for (const member of room.members) member.ready = false;
        broadcast(room, 'S2C_GAME_END', result); update(room);
      },
      () => abort(room),
    );
  }
  function command(member: Member, message: QuandiCommand) {
    const now = performance.now();
    member.lastSeen = now;
    if (message.type === 'C2S_PING') { send(member, 'S2C_PONG', {}); return; }
    // 移动另受传输层 60 帧/秒约束；创建、猜房间码等控制操作最多 12 次/10 秒。
    if (message.type !== 'C2S_PLAYER_INPUT') {
      if (now - member.actionWindow >= 10_000) { member.actionWindow = now; member.actions = 0; }
      if (++member.actions > 12) { member.peer.disconnect(); return; }
    }
    const room = member.room;
    switch (message.type) {
      case 'C2S_CREATE_ROOM': {
        if (room) { error(member, 'ALREADY_IN_ROOM', '请先离开当前房间。'); return; }
        if (rooms.size >= QUANDI_MAX_ROOMS) { error(member, 'ROOMS_FULL', '房间已满，请稍后重试。'); return; }
        let code: string;
        do { code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (rooms.has(code));
        const next: Room = { roomId: randomUUID(), roomCode: code, hostPlayerId: member.peer.id,
          gameConfig: message.data, members: [member], engine: null, updatedAt: now, startedAt: 0 };
        member.room = next; member.ready = false;
        rooms.set(code, next); update(next); return;
      }
      case 'C2S_JOIN_ROOM': {
        if (room) { error(member, 'ALREADY_IN_ROOM', '请先离开当前房间。'); return; }
        const next = rooms.get(message.data.roomCode);
        if (!next || next.members.length >= 2 || next.engine) { error(member, 'ROOM_UNAVAILABLE', '房间不存在、已满或正在游戏。'); return; }
        member.room = next; member.ready = false; next.members.push(member); next.updatedAt = now; update(next); return;
      }
      case 'C2S_LEAVE_ROOM': leave(member); send(member, 'S2C_ROOM_LEFT', {}); return;
      case 'C2S_SET_READY':
        if (room && !room.engine) { member.ready = message.data.isReady; room.updatedAt = now; update(room); }
        return;
      case 'C2S_START_GAME':
        if (!room || room.hostPlayerId !== member.peer.id || room.engine) { error(member, 'NOT_HOST', '只有等待中的房主可以开始游戏。'); return; }
        if (room.members.length !== 2 || room.members.some((entry) => !entry.ready)) { error(member, 'NOT_READY', '需要两位玩家都准备好。'); return; }
        run(room); return;
      case 'C2S_FORFEIT': room?.engine?.forfeitPlayer(member.peer.id); return;
      case 'C2S_PLAYER_INPUT':
        if (!room?.engine || message.data.seq <= member.sequence) return;
        member.sequence = message.data.seq;
        room.engine.onPlayerInput(member.peer.id, message.data); return;
    }
  }
  function sweep() {
    const now = performance.now();
    for (const member of members.values()) if (now - member.lastSeen > 20_000) member.peer.disconnect();
    for (const room of rooms.values()) {
      if (room.engine && now - room.startedAt > QUANDI_ROUND_MAX_MS) room.engine.endGame();
      else if (!room.engine && now - room.updatedAt > QUANDI_ROOM_IDLE_MS) abort(room);
    }
  }
  return {
    id: 'quandi',
    authenticate: (input) => authority.consume(input),
    revalidate: ({ identity, signal }) => authority.validate({ gameId: 'quandi', identity, signal }),
    connect(peer) {
      if (accounts.has(peer.identity.userId) || members.size >= QUANDI_MAX_PLAYERS) {
        peer.send(JSON.stringify({ type: 'S2C_ERROR', data: { code: 'CONNECTION_LIMIT', message: '该账号已在其他页面联机，或当前服务已满。' } }));
        peer.disconnect(); return { receive() {}, close() {} };
      }
      const member: Member = { peer, room: null, ready: false, sequence: 0, actions: 0, actionWindow: performance.now(), lastSeen: performance.now() };
      members.set(peer.id, member); accounts.add(peer.identity.userId);
      if (!timer) { timer = setInterval(sweep, 1000); timer.unref(); }
      send(member, 'S2C_CONNECTED', { playerId: peer.id, playerName: peer.identity.username });
      let closed = false;
      return {
        receive(message) {
          if (closed) return;
          let value: unknown;
          try { value = message.binary ? null : JSON.parse(message.data); } catch { value = null; }
          const parsed = parseQuandiCommand(value);
          if (!parsed) { peer.disconnect(); return; }
          command(member, parsed);
        },
        close() {
          if (closed) return;
          closed = true; leave(member);
          members.delete(peer.id); accounts.delete(peer.identity.userId);
          if (!members.size) { clearInterval(timer); timer = undefined; }
        },
      };
    },
  };
}
