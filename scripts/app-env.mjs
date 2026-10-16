import { randomBytes } from 'node:crypto';

/** 一次启动只生成一份凭据，主站与实时子进程共用；不落盘，也不复用会话密钥。 */
export function appEnvironment(source, { development, port }) {
  const env = { ...source, NODE_ENV: development ? 'development' : 'production' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('主站端口必须在 1–65535 之间');
  const token = env.REALTIME_SERVICE_TOKEN || randomBytes(32).toString('hex');
  if (token.length < 32 || token.length > 256) throw new Error('REALTIME_SERVICE_TOKEN 必须为 32–256 字符');
  env.REALTIME_SERVICE_TOKEN = token;
  env.REALTIME_HOST ||= '127.0.0.1';
  env.REALTIME_PORT ||= '3033';
  const realtimePort = Number(env.REALTIME_PORT);
  if (!Number.isInteger(realtimePort) || realtimePort < 1 || realtimePort > 65535 || realtimePort === port) {
    throw new Error('REALTIME_PORT 必须为 1–65535，且不能与主站端口相同');
  }
  env.REALTIME_AUTH_BASE_URL ||= `http://127.0.0.1:${port}`;
  if (!env.REALTIME_ALLOWED_ORIGINS?.trim()) {
    const origins = new Set(development ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`] : []);
    const entries = [env.SITE_URL, ...(env.ALLOWED_ORIGINS || '').split(',')];
    for (const entry of entries) {
      if (!entry?.trim()) continue;
      const value = entry.trim();
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('站点地址必须使用 http(s)');
      origins.add(url.origin);
    }
    if (!origins.size) throw new Error('请在主站环境中配置 SITE_URL 或 ALLOWED_ORIGINS');
    env.REALTIME_ALLOWED_ORIGINS = [...origins].join(',');
  }
  return env;
}

/** 实时进程只收到运行所需变量，不传数据库地址、JWT 或鱼干加密密钥。 */
export function realtimeEnvironment(env) {
  const systemKeys = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    systemKeys.has(key.toUpperCase()) || key === 'NODE_ENV' || key.startsWith('REALTIME_')));
}
