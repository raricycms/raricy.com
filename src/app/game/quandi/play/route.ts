import { getCurrentUser } from '@/lib/auth';
import { canPlayRealtime } from '@/lib/realtime-ticket-service';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 固定路径由 Next 的文件追踪纳入构建；绝不由请求参数选择文件。
const quandiDocument = readFileSync(path.join(process.cwd(), 'src/games/quandi/document.html'), 'utf8');

// Route Handler 不经过页面 layout，必须独立检查身份、封禁及专注状态。
export async function GET() {
  const user = await getCurrentUser();
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };
  if (!user) return new Response('请先登录', { status: 401, headers });
  if (!canPlayRealtime(user)) return new Response('当前账号暂不可使用玩具', { status: 403, headers });
  return new Response(quandiDocument, { headers: {
    ...headers, 'Content-Type': 'text/html; charset=utf-8',
    // CSP sandbox 在直接访问时也保持不透明来源。游戏无法接触本站 Cookie/DOM，
    // connect-src 禁止它自行联网；只有父页持有的 MessagePort 能转发经过校验的操作。
    'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  } });
}
