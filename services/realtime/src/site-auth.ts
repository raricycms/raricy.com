import { isRealtimeIdentity, type RealtimeIdentity } from '../../../shared/realtime/protocol.js';

export interface TicketAuthority {
  consume(input: { gameId: string; ticket: string; signal: AbortSignal }): Promise<RealtimeIdentity | null>;
  validate(input: { gameId: string; identity: RealtimeIdentity; signal: AbortSignal }): Promise<boolean>;
}

export function createSiteTicketAuthority(env: Readonly<Record<string, string | undefined>> = process.env): TicketAuthority {
  const token = env.REALTIME_SERVICE_TOKEN ?? '';
  if (token.length < 32 || token.length > 256) throw new Error('必须配置独立的 REALTIME_SERVICE_TOKEN（32–256 字符）');
  const base = new URL(env.REALTIME_AUTH_BASE_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('REALTIME_AUTH_BASE_URL 必须是主站 HTTP origin');
  }
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('非回环主站认证地址必须使用 HTTPS');
  }
  const url = new URL('/api/internal/realtime/session', base);
  async function request(body: object, signal: AbortSignal): Promise<RealtimeIdentity | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 2500);
    timeout.unref();
    try {
      const response = await fetch(url, {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      const result: unknown = await response.json();
      const identity = result && typeof result === 'object' ? (result as Record<string, unknown>).identity : null;
      return isRealtimeIdentity(identity) ? identity : null;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    consume: ({ gameId, ticket, signal }) => request({ action: 'consume', gameId, ticket }, signal),
    validate: async ({ gameId, identity, signal }) => {
      const current = await request({ action: 'validate', gameId, identity }, signal);
      return current?.userId === identity.userId && current.sessionVersion === identity.sessionVersion;
    },
  };
}
