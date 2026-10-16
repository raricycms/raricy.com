import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { appEnvironment, realtimeEnvironment } from './app-env.mjs';
import { runAppProcesses } from './app-processes.mjs';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env');
const root = fileURLToPath(new URL('../', import.meta.url));

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['dev', 'start'].includes(mode)) throw new Error('用法: node scripts/start.mjs <dev|start> [Next CLI 参数]');
  const development = mode === 'dev';
  process.env.NODE_ENV = development ? 'development' : 'production';
  loadEnvConfig(root, development);
  let port = Number(process.env.PORT || 3000);
  for (let i = 0; i < args.length; i++) {
    if (['-p', '--port'].includes(args[i])) port = Number(args[++i]);
    else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7));
    else if (/^-p\d+$/.test(args[i])) port = Number(args[i].slice(2));
  }
  const env = appEnvironment(process.env, { development, port });
  const realtimeMain = path.join(root, 'services/realtime/dist/services/realtime/src/main.js');
  if (!development && !existsSync(realtimeMain)) throw new Error('缺少实时服务构建，请先运行 npm run build');
  const realtimeArgs = development
    ? ['--watch', '--import', 'tsx', 'services/realtime/src/main.ts']
    : [realtimeMain];
  console.log('[app] 统一启动主站与实时服务，共用主站环境配置');
  process.exitCode = await runAppProcesses([
    { name: 'realtime', args: realtimeArgs, env: realtimeEnvironment(env) },
    // 显式传端口，禁止 next dev 在占用时自行换端口，导致内部认证仍连到旧端口。
    { name: 'next', args: [require.resolve('next/dist/bin/next'), mode, '-p', String(port), ...(development ? [] : ['-H', '127.0.0.1']), ...args], env },
  ], { cwd: root });
}

void main().catch((error) => { console.error('[app] 启动失败:', error.message); process.exitCode = 1; });
