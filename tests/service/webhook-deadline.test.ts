import { expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { postWebhook, resolveWebhookTarget } from '@/lib/webhook-url';

it('持续有字节的慢响应也必须在回调总时长到期时终止', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
    let chunks = 0;
    const timer = setInterval(() => {
      response.write('.');
      if (++chunks >= 30) { clearInterval(timer); response.end(); }
    }, 20);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const target = await resolveWebhookTarget(`http://127.0.0.1:${port}/callback`, { allowPrivate: true });
    await expect(postWebhook(target, {}, '{}', { timeoutMs: 150 })).rejects.toThrow('回调超时');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
