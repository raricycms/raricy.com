// 零依赖的传输契约。时间限制由服务端执行，游戏帧的内容由各游戏自己定义。
export const REALTIME_PROTOCOL_VERSION = 1;
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024;
export const MAX_REALTIME_TICKET_LENGTH = 2048;
export const REALTIME_GAME_IDS = ['wand', 'wand2', 'public-space', 'quandi'] as const;
export type RealtimeGameId = typeof REALTIME_GAME_IDS[number];
export function isRealtimeGameId(value: unknown): value is RealtimeGameId {
  return REALTIME_GAME_IDS.some((id) => id === value);
}

export interface RealtimeIdentity {
  userId: string;
  username: string;
  sessionVersion: number;
  frameUrl?: string | null;
}

export function isRealtimeIdentity(value: unknown): value is RealtimeIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.userId === 'string' && identity.userId.length > 0 && identity.userId.length <= 128
    && typeof identity.username === 'string' && identity.username.length > 0 && identity.username.length <= 256
    && Number.isSafeInteger(identity.sessionVersion) && (identity.sessionVersion as number) >= 0
    && (identity.frameUrl === undefined || identity.frameUrl === null || typeof identity.frameUrl === 'string');
}

export interface RealtimeAuthentication {
  type: 'realtime.authenticate';
  version: typeof REALTIME_PROTOCOL_VERSION;
  ticket: string;
}

export type RealtimeErrorCode =
  | 'invalid_message'
  | 'authentication_failed'
  | 'authentication_timeout'
  | 'permission_revoked'
  | 'rate_limited'
  | 'internal_error';

export type RealtimeControlMessage =
  | { type: 'realtime.ready'; version: typeof REALTIME_PROTOCOL_VERSION; gameId: string; connectionId: string }
  | { type: 'realtime.error'; version: typeof REALTIME_PROTOCOL_VERSION; code: RealtimeErrorCode };

export function parseRealtimeAuthentication(text: string): RealtimeAuthentication | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'realtime.authenticate' || message.version !== REALTIME_PROTOCOL_VERSION
      || typeof message.ticket !== 'string' || !message.ticket.trim()
      || message.ticket.length > MAX_REALTIME_TICKET_LENGTH) return null;
  return { type: message.type, version: REALTIME_PROTOCOL_VERSION, ticket: message.ticket };
}
