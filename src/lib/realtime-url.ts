import { siteOrigin } from './site-url';
import type { RealtimeGameId } from '../../shared/realtime/protocol';

export function wandWebSocketUrl(requestUrl: string): string {
  return realtimeWebSocketUrl(requestUrl, 'wand');
}

export function realtimeWebSocketUrl(requestUrl: string, gameId: RealtimeGameId): string {
  const configured = process.env.REALTIME_PUBLIC_ORIGIN?.trim();
  // 本地开发的 SITE_URL 往往仍是正式站；连接应跟随当前开发页面的主机。
  const base = new URL(configured || (process.env.NODE_ENV === 'production' ? siteOrigin() : '') || requestUrl);
  if (configured && (!['ws:', 'wss:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash || base.username || base.password)) {
    throw new Error('REALTIME_PUBLIC_ORIGIN 必须是 ws(s) origin');
  }
  if (!configured) {
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    if (process.env.NODE_ENV !== 'production') base.port = process.env.REALTIME_PORT || '3033';
  }
  if (base.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('非回环实时地址必须使用 wss');
  }
  base.pathname = `/realtime/${gameId}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}
