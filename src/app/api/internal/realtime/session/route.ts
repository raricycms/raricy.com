import { isRealtimeServiceRequest } from '@/lib/realtime-auth';
import { consumeRealtimeTicket, validateRealtimeIdentity } from '@/lib/realtime-ticket-service';
import { isRealtimeIdentity } from '../../../../../../shared/realtime/protocol';

// 只认独立 Bearer 服务凭据，不读取浏览器 Cookie；服务器调用无需 Origin。
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!isRealtimeServiceRequest(request)) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400, headers }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  const data = body as Record<string, unknown>;
  let identity = null;
  if (data.action === 'consume' && data.gameId === 'wand' && typeof data.ticket === 'string') {
    identity = await consumeRealtimeTicket(data.ticket, data.gameId);
  } else if (data.action === 'validate' && data.gameId === 'wand' && isRealtimeIdentity(data.identity)) {
    identity = await validateRealtimeIdentity(data.identity);
  } else return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  return identity ? Response.json({ identity }, { headers }) : Response.json({ error: 'invalid_identity' }, { status: 403, headers });
}
