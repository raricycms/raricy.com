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

/**
 * 错误码 → 玩家可读的一句话。四个游戏客户端（wand / wand2 / public-space / quandi）
 * 此前都只特判 `permission_revoked`，其余一律说成「身份验证失败」或「连接已关闭」：
 * `rate_limited` 被说成验证失败会让人去重新登录，`internal_error` 被说成关闭会让人
 * 反复重连。码的含义是传输契约的一部分，文案跟码放在一处，客户端不再各自坍缩。
 */
const REALTIME_ERROR_TEXT: Readonly<Record<RealtimeErrorCode, string>> = {
  invalid_message: '收到无效的消息，连接已关闭。',
  authentication_failed: '身份验证失败，请重新登录或稍后重试。',
  authentication_timeout: '认证超时，请重新连接。',
  permission_revoked: '账号状态已变化，连接已关闭。',
  rate_limited: '操作过于频繁，请稍后重试。',
  internal_error: '服务暂时不可用，请稍后重试。',
};

/** 未知码（协议升级后的新码）走兜底文案，不抛异常。 */
export function realtimeErrorText(code: unknown): string {
  return (typeof code === 'string' && REALTIME_ERROR_TEXT[code as RealtimeErrorCode]) || '连接已关闭，请重新连接。';
}

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
