import { createHash, randomBytes } from 'node:crypto';
import { prisma } from './db';
import { isCurrentlyBanned } from './auth';
import { isFocusGamesBlocked } from './focus-mode';
import { isRealtimeGameId, type RealtimeGameId, type RealtimeIdentity } from '../../shared/realtime/protocol';
import { frameUrlFor } from './frame-service';

export const REALTIME_TICKET_TTL_MS = 60_000;
const MAX_PENDING_TICKETS = 1024;
const MAX_USER_TICKETS = 4;
type Player = { id: string; username: string; sessionVersion: number; focusMode: boolean; focusBlockGames: boolean; isBanned: boolean | null; banUntil: Date | null };
interface Ticket { gameId: RealtimeGameId; identity: RealtimeIdentity; expiresAt: number }

// 多条 Next 路由会分别编译模块；瞬时票据必须共用进程级状态。
// 票据不落库，主站重启后重新申请即可；库内时间戳不参与这份真实毫秒 TTL。
const shared = globalThis as typeof globalThis & { __raricyRealtimeTickets?: Map<string, Ticket> };
const tickets = shared.__raricyRealtimeTickets ??= new Map<string, Ticket>();
const hash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');

export function canPlayRealtime(player: Player | null): player is Player {
  // 只认「专注模式 + 屏蔽玩具区」这个组合，不是总开关本身 —— 用户可以开着专注
  // 模式而保留玩具。判据唯一来源见 focus-mode.isFocusGamesBlocked。
  return !!player && !isFocusGamesBlocked(player) && !isCurrentlyBanned(player);
}

export function issueRealtimeTicket(player: Player, gameId: RealtimeGameId) {
  if (!canPlayRealtime(player)) return null;
  const now = Date.now();
  for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
  const own = [...tickets].filter(([, value]) => value.identity.userId === player.id);
  while (own.length >= MAX_USER_TICKETS) tickets.delete(own.shift()![0]);
  if (tickets.size >= MAX_PENDING_TICKETS) return null;
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(hash(ticket), {
    gameId,
    identity: { userId: player.id, username: player.username, sessionVersion: player.sessionVersion },
    expiresAt: now + REALTIME_TICKET_TTL_MS,
  });
  return { ticket, expiresIn: REALTIME_TICKET_TTL_MS / 1000 };
}

export async function validateRealtimeIdentity(identity: RealtimeIdentity, gameId?: RealtimeGameId): Promise<RealtimeIdentity | null> {
  const user = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { id: true, username: true, sessionVersion: true, focusMode: true, focusBlockGames: true, isBanned: true, banUntil: true,
      equippedFrameKey: true, equippedFrameExpiresAt: true },
  });
  if (!canPlayRealtime(user) || user.sessionVersion !== identity.sessionVersion) return null;
  return { userId: user.id, username: user.username, sessionVersion: user.sessionVersion,
    ...(gameId === 'public-space' ? { frameUrl: frameUrlFor(user) } : {}) };
}

export async function consumeRealtimeTicket(ticket: string, gameId: string): Promise<RealtimeIdentity | null> {
  if (ticket.length > 2048 || !isRealtimeGameId(gameId)) return null;
  const key = hash(ticket);
  const entry = tickets.get(key);
  if (!entry || entry.gameId !== gameId) return null;
  // 第一次 await 前消费，两个并发请求不能都拿到身份；失效验证失败也不复用票据。
  tickets.delete(key);
  if (entry.expiresAt <= Date.now()) return null;
  return validateRealtimeIdentity(entry.identity, gameId);
}
