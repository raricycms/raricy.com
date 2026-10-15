import { createHash, timingSafeEqual } from 'node:crypto';

/** 只使用独立服务凭据，永不回退到主站会话密钥。 */
export function realtimeServiceToken(): string | null {
  const token = process.env.REALTIME_SERVICE_TOKEN ?? '';
  return token.length >= 32 && token.length <= 256 ? token : null;
}

export function isRealtimeServiceRequest(request: Request): boolean {
  const expected = realtimeServiceToken();
  const authorization = request.headers.get('authorization') ?? '';
  if (!expected || authorization.length > 300 || !authorization.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(authorization.slice(7)), digest(expected));
}
