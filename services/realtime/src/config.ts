export interface RealtimeConfig {
  host: string;
  port: number;
  allowedOrigins: readonly string[];
}

export function parseAllowedOrigins(value: string): string[] {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const url = new URL(entry);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry) {
      throw new Error('REALTIME_ALLOWED_ORIGINS 必须是完整的 http(s) origin，不含路径或尾斜杠');
    }
  }
  return [...new Set(entries)];
}

export function readRealtimeConfig(env: Readonly<Record<string, string | undefined>> = process.env): RealtimeConfig {
  const port = Number(env.REALTIME_PORT || 3033);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REALTIME_PORT 必须在 1–65535 之间');
  const allowedOrigins = parseAllowedOrigins(env.REALTIME_ALLOWED_ORIGINS
    ?? (env.NODE_ENV === 'production' ? '' : 'http://localhost:3000,http://127.0.0.1:3000'));
  if (!allowedOrigins.length) throw new Error('必须配置 REALTIME_ALLOWED_ORIGINS');
  return { host: env.REALTIME_HOST || '127.0.0.1', port, allowedOrigins };
}
