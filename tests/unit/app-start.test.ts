import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { appEnvironment, realtimeEnvironment } from '../../scripts/app-env.mjs';
import { runAppProcesses } from '../../scripts/app-processes.mjs';
import { realtimeWebSocketUrl, wandWebSocketUrl } from '@/lib/realtime-url';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

describe('共同启动的环境配置', () => {
  it('生产复用站点域名，生成共享临时凭据，并隔离主站私密变量', () => {
    const source = { SITE_URL: 'https://example.com/', ALLOWED_ORIGINS: 'www.example.com,http://localhost:3100', SECRET_KEY: 'session-secret', DATABASE_URL: 'file:private.db' };
    const env = appEnvironment(source, { development: false, port: 3100 });
    expect(env.REALTIME_SERVICE_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(env.REALTIME_AUTH_BASE_URL).toBe('http://127.0.0.1:3100');
    expect(env.REALTIME_ALLOWED_ORIGINS).toBe('https://example.com,https://www.example.com,http://localhost:3100');
    const realtime = realtimeEnvironment(env);
    expect(realtime.REALTIME_SERVICE_TOKEN).toBe(env.REALTIME_SERVICE_TOKEN);
    expect(realtime.SECRET_KEY).toBeUndefined();
    expect(realtime.DATABASE_URL).toBeUndefined();
    expect(source).not.toHaveProperty('REALTIME_SERVICE_TOKEN');
    expect(appEnvironment(source, { development: false, port: 3100 }).REALTIME_SERVICE_TOKEN).not.toBe(env.REALTIME_SERVICE_TOKEN);
  });

  it('开发允许实际主站端口；显式配置可以覆盖自动值', () => {
    expect(appEnvironment({}, { development: true, port: 3200 })).toMatchObject({
      REALTIME_ALLOWED_ORIGINS: 'http://localhost:3200,http://127.0.0.1:3200', REALTIME_PORT: '3033',
    });
    const explicit = { REALTIME_SERVICE_TOKEN: 'x'.repeat(32), REALTIME_ALLOWED_ORIGINS: 'https://games.example', REALTIME_AUTH_BASE_URL: 'https://site.example', REALTIME_PORT: '3333' };
    expect(appEnvironment(explicit, { development: false, port: 3000 })).toMatchObject(explicit);
    expect(() => appEnvironment({ SITE_URL: 'https://example.com', REALTIME_SERVICE_TOKEN: 'short' }, { development: false, port: 3000 })).toThrow('REALTIME_SERVICE_TOKEN');
    expect(() => appEnvironment({ REALTIME_PORT: '3000' }, { development: true, port: 3000 })).toThrow('REALTIME_PORT');
    expect(() => appEnvironment({}, { development: false, port: 3000 })).toThrow('SITE_URL');
  });

  it('开发连接当前页面，生产连接站点同域，并保留显式分域设置', () => {
    vi.stubEnv('REALTIME_PUBLIC_ORIGIN', '');
    vi.stubEnv('REALTIME_PORT', '3333');
    vi.stubEnv('SITE_URL', 'https://example.com');
    vi.stubEnv('NODE_ENV', 'development');
    expect(wandWebSocketUrl('http://localhost:3000/api/game/wand/launch')).toBe('ws://localhost:3333/realtime/wand');
    vi.stubEnv('NODE_ENV', 'production');
    expect(wandWebSocketUrl('http://127.0.0.1:3000/api/game/wand/launch')).toBe('wss://example.com/realtime/wand');
    vi.stubEnv('REALTIME_PUBLIC_ORIGIN', 'wss://games.example');
    expect(wandWebSocketUrl('http://localhost:3000')).toBe('wss://games.example/realtime/wand');
    expect(realtimeWebSocketUrl('http://localhost:3000', 'public-space')).toBe('wss://games.example/realtime/public-space');
  });
});

async function runningPair(grandchild = false) {
  const dir = mkdtempSync(path.resolve('tests/.tmp/app-start-'));
  const signals = new EventEmitter();
  const files = [path.join(dir, 'first.json'), path.join(dir, 'second.json')];
  const done = runAppProcesses(files.map((file, index) => ({
    name: `fixture-${index}`, args: [path.resolve('tests/fixtures/app-child.mjs')],
    env: { ...process.env, APP_TEST_READY: file, APP_TEST_GRANDCHILD: grandchild && index === 0 ? '1' : '0' },
  })), { signals, graceMs: 1000 });
  cleanups.push(async () => { signals.emit('SIGTERM'); await done; rmSync(dir, { recursive: true, force: true }); });
  const read = (file: string): { port: number; pid: number } => JSON.parse(readFileSync(file, 'utf8'));
  for (const file of [...files, ...(grandchild ? [`${files[0]}.child`] : [])]) {
    await vi.waitFor(() => expect(read(file).port).toBeGreaterThan(0), { timeout: 5000 });
  }
  return { signals, done, peers: [...files, ...(grandchild ? [`${files[0]}.child`] : [])].map(read) };
}

describe('共同启动的进程生命周期', () => {
  it('停止统一入口会回收两个服务以及开发孙进程，释放全部端口', async () => {
    const { signals, done, peers } = await runningPair(true);
    for (const peer of peers) expect((await fetch(`http://127.0.0.1:${peer.port}`)).status).toBe(200);
    signals.emit('SIGTERM');
    expect(await done).toBe(0);
    for (const peer of peers) await expect(fetch(`http://127.0.0.1:${peer.port}`)).rejects.toThrow();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  }, 10000);

  it('一个服务崩溃时停止另一个，以失败状态交给外层统一重启', async () => {
    const { done, peers } = await runningPair();
    await fetch(`http://127.0.0.1:${peers[0].port}/exit`);
    expect(await done).toBe(17);
    await expect(fetch(`http://127.0.0.1:${peers[1].port}`)).rejects.toThrow();
  }, 10000);
});
