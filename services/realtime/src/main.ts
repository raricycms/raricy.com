import { once } from 'node:events';
import { readRealtimeConfig } from './config.js';
import { createRealtimeGames } from './games.js';
import { createSiteTicketAuthority } from './site-auth.js';
import { createRealtimeServer } from './server.js';

async function main() {
  const config = readRealtimeConfig();
  const realtimeGames = createRealtimeGames(createSiteTicketAuthority());
  const runtime = createRealtimeServer({ allowedOrigins: config.allowedOrigins, games: realtimeGames });
  runtime.server.listen(config.port, config.host);
  try { await once(runtime.server, 'listening'); }
  catch (error) { await runtime.close(); throw error; }
  console.log(`[realtime] http://${config.host}:${config.port}，已注册 ${realtimeGames.length} 款游戏`);
  const stop = () => { void runtime.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch((error: unknown) => {
  console.error('[realtime] 启动失败', error instanceof Error ? error.message : 'unknown_error');
  process.exitCode = 1;
});
